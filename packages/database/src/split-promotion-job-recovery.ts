import { Prisma } from "@prisma/client";
import {
  PromotionJobPersistenceError,
  assertSafeFailureCode,
  validDate,
  type PromotionJobInvocation,
  type ReconcileInterruptedPromotionJobInvocationInput,
} from "./promotion-job-persistence-types.ts";

interface RecoverySqlClient {
  query<T>(statement: Prisma.Sql): Promise<T[]>;
}

interface ExpiredInvocationRow {
  runId: string;
  observedWakeGeneration: bigint | null;
}

/** Bounded SQL selection shared by each authority-local repository. */
export async function sweepExpiredPromotionJobInvocations(
  client: RecoverySqlClient,
  input: Readonly<{
    invocationTable: Prisma.Sql;
    reconciledAt: Date;
    maximumRows?: number;
    safeFailureCode: string;
    reconcile(
      input: ReconcileInterruptedPromotionJobInvocationInput,
    ): Promise<PromotionJobInvocation>;
  }>,
): Promise<Readonly<{
  invocations: readonly PromotionJobInvocation[];
  moreEligible: boolean;
}>> {
  const maximumRows = input.maximumRows ?? 10;
  assertSafeFailureCode(input.safeFailureCode);
  if (
    !validDate(input.reconciledAt) || !Number.isSafeInteger(maximumRows) ||
    maximumRows < 1 || maximumRows > 100
  ) throw new PromotionJobPersistenceError("PROMOTION_JOB_INPUT_INVALID");

  const candidates = await client.query<ExpiredInvocationRow>(
    Prisma.sql`
      select run_id::text as "runId",
        observed_wake_generation as "observedWakeGeneration"
      from ${input.invocationTable}
      where lifecycle_state = 'running'
        and ownership_expires_at <= ${input.reconciledAt}
      order by ownership_expires_at, run_id
      limit ${maximumRows}
      for update skip locked
    `,
  );
  const invocations: PromotionJobInvocation[] = [];
  for (const candidate of candidates) {
    invocations.push(await input.reconcile({
      runId: candidate.runId,
      reconciledAt: input.reconciledAt,
      resolution: "continuation_required",
      safeFailureCode: input.safeFailureCode,
      continuation: {
        requestedGeneration: (candidate.observedWakeGeneration ?? 0n) + 1n,
        requestedAt: input.reconciledAt,
      },
      retentionProtected: true,
    }));
  }
  const [remaining] = await client.query<{ moreEligible: boolean }>(Prisma.sql`
    select exists (
      select 1
      from ${input.invocationTable}
      where lifecycle_state = 'running'
        and ownership_expires_at <= ${input.reconciledAt}
    ) as "moreEligible"
  `);
  return {
    invocations,
    moreEligible: remaining?.moreEligible ?? false,
  };
}

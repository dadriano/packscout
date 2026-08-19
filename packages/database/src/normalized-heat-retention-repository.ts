import { Prisma } from "@prisma/client";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
  type PackscoutTransactionClient,
} from "./database.ts";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface NormalizedHeatRetentionCleanupResult {
  readonly deletedOutcomes: number;
  readonly deletedObservations: number;
  readonly hasMore: boolean;
}

/** Deletes one tenant-bounded batch after the exact seven-day hold has elapsed. */
export async function cleanupExpiredNormalizedHeatHistory(
  database: PackscoutTransactionClient,
  input: {
    organizationId: string;
    cutoffAt: Date;
    limit: number;
  },
): Promise<NormalizedHeatRetentionCleanupResult> {
  if ("$transaction" in (database as unknown as Record<string, unknown>)) {
    throw new TypeError(
      "Normalized Heat cleanup requires the caller's active database transaction.",
    );
  }
  if (!uuidPattern.test(input.organizationId)) {
    throw new RangeError("organizationId is invalid.");
  }
  if (!Number.isFinite(input.cutoffAt.getTime())) {
    throw new RangeError("cutoffAt is invalid.");
  }
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
    throw new RangeError("Normalized Heat cleanup limit is invalid.");
  }
  const organizationId = Prisma.sql`cast(${input.organizationId.toLowerCase()} as uuid)`;
  const deletedOutcomeRows = await database.$queryRaw<Array<{ count: number }>>(
    Prisma.sql`
      with selected as (
        select organization_id, candidate_key
        from public.normalized_heat_observation_outcomes
        where organization_id = ${organizationId}
          and retained_until <= ${input.cutoffAt}
          and retained_until <= current_timestamp
        order by retained_until, candidate_key
        for update skip locked
        limit ${input.limit}
      ), deleted as (
        delete from public.normalized_heat_observation_outcomes as outcome
        using selected
        where outcome.organization_id = selected.organization_id
          and outcome.candidate_key = selected.candidate_key
        returning 1
      )
      select count(*)::integer as count from deleted
    `,
  );
  const deletedOutcomes = deletedOutcomeRows[0]?.count ?? 0;
  const remaining = input.limit - deletedOutcomes;
  let deletedObservations = 0;
  if (remaining > 0) {
    const deletedObservationRows = await database.$queryRaw<Array<{ count: number }>>(
      Prisma.sql`
        with selected as (
          select observation.id, observation.organization_id
          from public.normalized_heat_observations as observation
          where observation.organization_id = ${organizationId}
            and observation.retained_until <= ${input.cutoffAt}
            and observation.retained_until <= current_timestamp
            and not exists (
              select 1
              from public.normalized_heat_observation_outcomes as outcome
              where outcome.organization_id = observation.organization_id
                and outcome.observation_id = observation.id
            )
          order by observation.retained_until, observation.observation_key
          for update skip locked
          limit ${remaining}
        ), deleted as (
          delete from public.normalized_heat_observations as observation
          using selected
          where observation.organization_id = selected.organization_id
            and observation.id = selected.id
          returning 1
        )
        select count(*)::integer as count from deleted
      `,
    );
    deletedObservations = deletedObservationRows[0]?.count ?? 0;
  }
  const pendingRows = await database.$queryRaw<Array<{ pending: boolean }>>(
    Prisma.sql`
      select exists (
        select 1
        from public.normalized_heat_observation_outcomes
        where organization_id = ${organizationId}
          and retained_until <= ${input.cutoffAt}
          and retained_until <= current_timestamp
        union all
        select 1
        from public.normalized_heat_observations
        where organization_id = ${organizationId}
          and retained_until <= ${input.cutoffAt}
          and retained_until <= current_timestamp
        limit 1
      ) as pending
    `,
  );
  return {
    deletedOutcomes,
    deletedObservations,
    hasMore: pendingRows[0]?.pending ?? false,
  };
}

/** Opens the required transaction while keeping tenant selection server-bound. */
export class PrismaNormalizedHeatRetentionRepository {
  readonly #organizationId: string;

  constructor(
    private readonly database: PackscoutPrismaClient,
    configuration: { organizationId: string },
  ) {
    if (!uuidPattern.test(configuration.organizationId)) {
      throw new RangeError("organizationId is invalid.");
    }
    this.#organizationId = configuration.organizationId.toLowerCase();
  }

  cleanup(input: {
    cutoffAt: Date;
    limit: number;
  }): Promise<NormalizedHeatRetentionCleanupResult> {
    return this.database.$transaction(
      async (transaction) => await cleanupExpiredNormalizedHeatHistory(
        transaction,
        {
          organizationId: this.#organizationId,
          cutoffAt: input.cutoffAt,
          limit: input.limit,
        },
      ),
      PACKSCOUT_TRANSACTION_OPTIONS,
    );
  }
}

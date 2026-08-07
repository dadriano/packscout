import { randomUUID } from "node:crypto";
import { and, asc, eq, lte, or, sql } from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
import type { PackscoutDatabase } from "./database.ts";
import { estimatedEvRecomputationRequests } from "./schema/index.ts";
import { hashJson } from "./security.ts";

const workerIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const failureCodePattern = /^[A-Z][A-Z0-9_]{0,127}$/;

export interface EstimatedEvRecomputationIdentity {
  readonly organizationId: string;
  readonly platformKey: string;
  readonly packExternalId: string;
  readonly evInputExternalId: string;
  readonly packRevisionId: string | null;
  readonly evInputRevisionId: string | null;
}

export interface ClaimedEstimatedEvRecomputation
  extends EstimatedEvRecomputationIdentity {
  readonly id: string;
  readonly providerId: string;
  readonly configurationRevisionId: string;
  readonly claimToken: string;
  readonly attemptCount: number;
}

export interface EstimatedEvRecomputationQueuePort {
  claimBatch(input: {
    workerId: string;
    now: Date;
    limit: number;
    leaseMilliseconds: number;
  }): Promise<readonly ClaimedEstimatedEvRecomputation[]>;
  complete(input: {
    requestId: string;
    claimToken: string;
    completedAt: Date;
    resultStatus: "estimated" | "unavailable";
    calculationRevisionId: string;
  }): Promise<boolean>;
  recordFailure(input: {
    requestId: string;
    claimToken: string;
    failedAt: Date;
    retryAt: Date;
    failureCode: string;
    maximumAttempts: number;
  }): Promise<"failed" | "lost" | "retrying">;
}

export function estimatedEvRecomputationRequestKey(
  input: EstimatedEvRecomputationIdentity,
): string {
  return hashJson({
    version: "estimated-ev-recomputation-v1",
    organizationId: input.organizationId,
    platformKey: input.platformKey,
    packExternalId: input.packExternalId,
    evInputExternalId: input.evInputExternalId,
    packRevisionId: input.packRevisionId,
    evInputRevisionId: input.evInputRevisionId,
  });
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} is outside its safe bounds.`);
  }
  return value;
}

export class DrizzleEstimatedEvRecomputationRepository<
  TQueryResult extends PgQueryResultHKT,
> implements EstimatedEvRecomputationQueuePort {
  constructor(private readonly database: PackscoutDatabase<TQueryResult>) {}

  async claimBatch(input: {
    workerId: string;
    now: Date;
    limit: number;
    leaseMilliseconds: number;
  }): Promise<readonly ClaimedEstimatedEvRecomputation[]> {
    if (!workerIdPattern.test(input.workerId)) {
      throw new RangeError("Estimated EV worker ID is invalid.");
    }
    const limit = boundedInteger(input.limit, 1, 100, "Estimated EV claim limit");
    const leaseMilliseconds = boundedInteger(
      input.leaseMilliseconds,
      1_000,
      15 * 60_000,
      "Estimated EV claim lease",
    );
    const claimExpiresAt = new Date(input.now.getTime() + leaseMilliseconds);
    return this.database.transaction(async (transaction) => {
      const candidates = await transaction
        .select({ id: estimatedEvRecomputationRequests.id })
        .from(estimatedEvRecomputationRequests)
        .where(
          or(
            and(
              eq(estimatedEvRecomputationRequests.state, "queued"),
              lte(estimatedEvRecomputationRequests.availableAt, input.now),
            ),
            and(
              eq(estimatedEvRecomputationRequests.state, "running"),
              lte(estimatedEvRecomputationRequests.claimExpiresAt, input.now),
            ),
          ),
        )
        .orderBy(
          asc(estimatedEvRecomputationRequests.availableAt),
          asc(estimatedEvRecomputationRequests.createdAt),
          asc(estimatedEvRecomputationRequests.id),
        )
        .limit(limit)
        .for("update", { skipLocked: true });
      const claimed: ClaimedEstimatedEvRecomputation[] = [];
      for (const candidate of candidates) {
        const claimToken = randomUUID();
        const [request] = await transaction
          .update(estimatedEvRecomputationRequests)
          .set({
            state: "running",
            claimedBy: input.workerId,
            claimToken,
            claimExpiresAt,
            attemptCount: sql`${estimatedEvRecomputationRequests.attemptCount} + 1`,
            failureCode: null,
            updatedAt: input.now,
          })
          .where(eq(estimatedEvRecomputationRequests.id, candidate.id))
          .returning({
            id: estimatedEvRecomputationRequests.id,
            organizationId: estimatedEvRecomputationRequests.organizationId,
            providerId: estimatedEvRecomputationRequests.providerId,
            configurationRevisionId:
              estimatedEvRecomputationRequests.configurationRevisionId,
            platformKey: estimatedEvRecomputationRequests.platformKey,
            packExternalId: estimatedEvRecomputationRequests.packExternalId,
            evInputExternalId:
              estimatedEvRecomputationRequests.evInputExternalId,
            packRevisionId: estimatedEvRecomputationRequests.packRevisionId,
            evInputRevisionId:
              estimatedEvRecomputationRequests.evInputRevisionId,
            attemptCount: estimatedEvRecomputationRequests.attemptCount,
          });
        if (request) claimed.push({ ...request, claimToken });
      }
      return claimed;
    });
  }

  async complete(input: {
    requestId: string;
    claimToken: string;
    completedAt: Date;
    resultStatus: "estimated" | "unavailable";
    calculationRevisionId: string;
  }): Promise<boolean> {
    const [completed] = await this.database
      .update(estimatedEvRecomputationRequests)
      .set({
        state: "completed",
        resultStatus: input.resultStatus,
        calculationRevisionId: input.calculationRevisionId,
        claimedBy: null,
        claimToken: null,
        claimExpiresAt: null,
        failureCode: null,
        completedAt: input.completedAt,
        updatedAt: input.completedAt,
      })
      .where(
        and(
          eq(estimatedEvRecomputationRequests.id, input.requestId),
          eq(estimatedEvRecomputationRequests.state, "running"),
          eq(estimatedEvRecomputationRequests.claimToken, input.claimToken),
        ),
      )
      .returning({ id: estimatedEvRecomputationRequests.id });
    return completed !== undefined;
  }

  async recordFailure(input: {
    requestId: string;
    claimToken: string;
    failedAt: Date;
    retryAt: Date;
    failureCode: string;
    maximumAttempts: number;
  }): Promise<"failed" | "lost" | "retrying"> {
    const maximumAttempts = boundedInteger(
      input.maximumAttempts,
      1,
      20,
      "Estimated EV maximum attempts",
    );
    const failureCode = failureCodePattern.test(input.failureCode)
      ? input.failureCode
      : "ESTIMATED_EV_RECOMPUTATION_FAILED";
    return this.database.transaction(async (transaction) => {
      const [request] = await transaction
        .select({ attemptCount: estimatedEvRecomputationRequests.attemptCount })
        .from(estimatedEvRecomputationRequests)
        .where(
          and(
            eq(estimatedEvRecomputationRequests.id, input.requestId),
            eq(estimatedEvRecomputationRequests.state, "running"),
            eq(estimatedEvRecomputationRequests.claimToken, input.claimToken),
          ),
        )
        .for("update")
        .limit(1);
      if (!request) return "lost";
      const terminal = request.attemptCount >= maximumAttempts;
      await transaction
        .update(estimatedEvRecomputationRequests)
        .set({
          state: terminal ? "failed" : "queued",
          availableAt: terminal ? input.failedAt : input.retryAt,
          claimedBy: null,
          claimToken: null,
          claimExpiresAt: null,
          failureCode,
          updatedAt: input.failedAt,
        })
        .where(
          and(
            eq(estimatedEvRecomputationRequests.id, input.requestId),
            eq(estimatedEvRecomputationRequests.claimToken, input.claimToken),
          ),
        );
      return terminal ? "failed" : "retrying";
    });
  }
}

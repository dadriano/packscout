import type { RetentionBatchResult } from "@packscout/contracts";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
import type { PackscoutDatabase } from "./database.ts";
import { auditEvents } from "./schema/core.ts";
import {
  importPages,
  quarantineRecords,
  sourceRecords,
} from "./schema/ingestion.ts";
import { quarantineAttempts } from "./schema/quarantine-retry.ts";
import { retentionExecutions } from "./schema/operations.ts";

export interface RetentionClock {
  now(): Date;
}

export interface ExpiredQuarantineReference {
  readonly id: string;
  readonly providerId: string;
  readonly reasonCode: string;
}

export interface PersistedRetentionBatch {
  readonly result: RetentionBatchResult;
  readonly recovered: boolean;
  readonly expiredQuarantines: readonly ExpiredQuarantineReference[];
}

function duration(startedAt: Date, finishedAt: Date): number {
  return Math.max(0, finishedAt.getTime() - startedAt.getTime());
}

export class DrizzleProtectedPayloadRetentionRepository<
  TQueryResult extends PgQueryResultHKT,
> {
  constructor(
    private readonly database: PackscoutDatabase<TQueryResult>,
    private readonly clock: RetentionClock,
  ) {}

  async discoverEligibleOrganizations(input: {
    cutoffAt: Date;
    limit: number;
  }): Promise<readonly string[]> {
    if (
      !Number.isFinite(input.cutoffAt.getTime()) ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 1_000
    ) {
      throw new RangeError("Retention discovery request is invalid.");
    }
    const [pageOrganizations, sourceOrganizations, quarantineOrganizations] =
      await Promise.all([
        this.database
          .selectDistinct({ organizationId: importPages.organizationId })
          .from(importPages)
          .where(
            and(
              lte(importPages.expiresAt, input.cutoffAt),
              isNotNull(importPages.payloadJson),
              notExists(
                this.database
                  .select({ id: quarantineAttempts.id })
                  .from(quarantineAttempts)
                  .innerJoin(
                    quarantineRecords,
                    and(
                      eq(
                        quarantineRecords.id,
                        quarantineAttempts.quarantineId,
                      ),
                      eq(
                        quarantineRecords.organizationId,
                        quarantineAttempts.organizationId,
                      ),
                    ),
                  )
                  .where(
                    and(
                      eq(
                        quarantineAttempts.organizationId,
                        importPages.organizationId,
                      ),
                      eq(quarantineAttempts.state, "running"),
                      eq(quarantineRecords.pageId, importPages.id),
                    ),
                  ),
              ),
            ),
          )
          .orderBy(asc(importPages.organizationId))
          .limit(input.limit),
        this.database
          .selectDistinct({ organizationId: sourceRecords.organizationId })
          .from(sourceRecords)
          .where(
            and(
              lte(sourceRecords.expiresAt, input.cutoffAt),
              isNotNull(sourceRecords.payloadJson),
              notExists(
                this.database
                  .select({ id: quarantineAttempts.id })
                  .from(quarantineAttempts)
                  .innerJoin(
                    quarantineRecords,
                    and(
                      eq(
                        quarantineRecords.id,
                        quarantineAttempts.quarantineId,
                      ),
                      eq(
                        quarantineRecords.organizationId,
                        quarantineAttempts.organizationId,
                      ),
                    ),
                  )
                  .where(
                    and(
                      eq(
                        quarantineAttempts.organizationId,
                        sourceRecords.organizationId,
                      ),
                      eq(quarantineAttempts.state, "running"),
                      eq(quarantineRecords.sourceRecordId, sourceRecords.id),
                    ),
                  ),
              ),
            ),
          )
          .orderBy(asc(sourceRecords.organizationId))
          .limit(input.limit),
        this.database
          .selectDistinct({ organizationId: quarantineRecords.organizationId })
          .from(quarantineRecords)
          .where(
            and(
              lte(quarantineRecords.expiresAt, input.cutoffAt),
              or(
                isNotNull(quarantineRecords.payloadJson),
                eq(quarantineRecords.state, "open"),
              ),
              notExists(
                this.database
                  .select({ id: quarantineAttempts.id })
                  .from(quarantineAttempts)
                  .where(
                    and(
                      eq(
                        quarantineAttempts.organizationId,
                        quarantineRecords.organizationId,
                      ),
                      eq(
                        quarantineAttempts.quarantineId,
                        quarantineRecords.id,
                      ),
                      eq(quarantineAttempts.state, "running"),
                    ),
                  ),
              ),
            ),
          )
          .orderBy(asc(quarantineRecords.organizationId))
          .limit(input.limit),
      ]);
    return [
      ...new Set(
        [
          ...pageOrganizations,
          ...sourceOrganizations,
          ...quarantineOrganizations,
        ].map(({ organizationId }) => organizationId),
      ),
    ]
      .sort((left, right) => left.localeCompare(right))
      .slice(0, input.limit);
  }

  async expireBatch(input: {
    executionId: string;
    organizationId: string;
    cutoffAt: Date;
    batchSize: number;
    startedAt: Date;
  }): Promise<PersistedRetentionBatch> {
    this.assertBatchSize(input.batchSize);
    return this.database.transaction(async (transaction) => {
      const [existing] = await transaction
        .select()
        .from(retentionExecutions)
        .where(
          and(
            eq(retentionExecutions.id, input.executionId),
            eq(retentionExecutions.organizationId, input.organizationId),
          ),
        )
        .limit(1)
        .for("update");
      if (existing?.finishedAt) {
        return {
          result: this.toResult(existing, true),
          recovered: false,
          expiredQuarantines: [],
        };
      }
      if (!existing) {
        await transaction.insert(retentionExecutions).values({
          id: input.executionId,
          organizationId: input.organizationId,
          state: "running",
          cutoffAt: input.cutoffAt,
          batchSize: input.batchSize,
          startedAt: input.startedAt,
        });
      }
      const [previous] = await transaction
        .select({ state: retentionExecutions.state })
        .from(retentionExecutions)
        .where(
          and(
            eq(retentionExecutions.organizationId, input.organizationId),
            ne(retentionExecutions.id, input.executionId),
            ne(retentionExecutions.state, "running"),
          ),
        )
        .orderBy(desc(retentionExecutions.startedAt))
        .limit(1);
      const alreadyExpired = await this.countEvidence(
        transaction,
        input.organizationId,
        input.cutoffAt,
        true,
      );

      let remainingBudget = input.batchSize;
      const quarantines = remainingBudget > 0
        ? await transaction
            .select({
              id: quarantineRecords.id,
              providerId: quarantineRecords.providerId,
              reasonCode: quarantineRecords.reasonCode,
              state: quarantineRecords.state,
            })
            .from(quarantineRecords)
            .where(
              and(
                eq(quarantineRecords.organizationId, input.organizationId),
                lte(quarantineRecords.expiresAt, input.cutoffAt),
                or(
                  isNotNull(quarantineRecords.payloadJson),
                  eq(quarantineRecords.state, "open"),
                ),
                notExists(
                  transaction
                    .select({ id: quarantineAttempts.id })
                    .from(quarantineAttempts)
                    .where(
                      and(
                        eq(
                          quarantineAttempts.organizationId,
                          quarantineRecords.organizationId,
                        ),
                        eq(
                          quarantineAttempts.quarantineId,
                          quarantineRecords.id,
                        ),
                        eq(quarantineAttempts.state, "running"),
                      ),
                    ),
                ),
              ),
            )
            .orderBy(asc(quarantineRecords.expiresAt), asc(quarantineRecords.id))
            .limit(remainingBudget)
            .for("update", { skipLocked: true })
        : [];
      remainingBudget -= quarantines.length;

      const sources = remainingBudget > 0
        ? await transaction
            .select({ id: sourceRecords.id })
            .from(sourceRecords)
            .where(
              and(
                eq(sourceRecords.organizationId, input.organizationId),
                lte(sourceRecords.expiresAt, input.cutoffAt),
                isNotNull(sourceRecords.payloadJson),
                notExists(
                  transaction
                    .select({ id: quarantineAttempts.id })
                    .from(quarantineAttempts)
                    .innerJoin(
                      quarantineRecords,
                      and(
                        eq(
                          quarantineRecords.id,
                          quarantineAttempts.quarantineId,
                        ),
                        eq(
                          quarantineRecords.organizationId,
                          quarantineAttempts.organizationId,
                        ),
                      ),
                    )
                    .where(
                      and(
                        eq(
                          quarantineAttempts.organizationId,
                          sourceRecords.organizationId,
                        ),
                        eq(quarantineAttempts.state, "running"),
                        eq(
                          quarantineRecords.sourceRecordId,
                          sourceRecords.id,
                        ),
                      ),
                    ),
                ),
              ),
            )
            .orderBy(asc(sourceRecords.expiresAt), asc(sourceRecords.id))
            .limit(remainingBudget)
            .for("update", { skipLocked: true })
        : [];
      remainingBudget -= sources.length;

      const pages = remainingBudget > 0
        ? await transaction
            .select({ id: importPages.id })
            .from(importPages)
            .where(
              and(
                eq(importPages.organizationId, input.organizationId),
                lte(importPages.expiresAt, input.cutoffAt),
                isNotNull(importPages.payloadJson),
                notExists(
                  transaction
                    .select({ id: quarantineAttempts.id })
                    .from(quarantineAttempts)
                    .innerJoin(
                      quarantineRecords,
                      and(
                        eq(
                          quarantineRecords.id,
                          quarantineAttempts.quarantineId,
                        ),
                        eq(
                          quarantineRecords.organizationId,
                          quarantineAttempts.organizationId,
                        ),
                      ),
                    )
                    .where(
                      and(
                        eq(
                          quarantineAttempts.organizationId,
                          importPages.organizationId,
                        ),
                        eq(quarantineAttempts.state, "running"),
                        eq(quarantineRecords.pageId, importPages.id),
                      ),
                    ),
                ),
              ),
            )
            .orderBy(asc(importPages.expiresAt), asc(importPages.id))
            .limit(remainingBudget)
            .for("update", { skipLocked: true })
        : [];
      const finishedAt = this.clock.now();

      if (quarantines.length > 0) {
        await transaction
          .update(quarantineRecords)
          .set({
            payloadJson: null,
            payloadExpiredAt: finishedAt,
            state: sql`case when ${quarantineRecords.state} = 'open' then 'expired'::quarantine_state else ${quarantineRecords.state} end`,
          })
          .where(
            and(
              eq(quarantineRecords.organizationId, input.organizationId),
              inArray(
                quarantineRecords.id,
                quarantines.map(({ id }) => id),
              ),
            ),
          );
      }
      if (sources.length > 0) {
        await transaction
          .update(sourceRecords)
          .set({ payloadJson: null, payloadExpiredAt: finishedAt })
          .where(
            and(
              eq(sourceRecords.organizationId, input.organizationId),
              inArray(sourceRecords.id, sources.map(({ id }) => id)),
            ),
          );
      }
      if (pages.length > 0) {
        await transaction
          .update(importPages)
          .set({ payloadJson: null, payloadExpiredAt: finishedAt })
          .where(
            and(
              eq(importPages.organizationId, input.organizationId),
              inArray(importPages.id, pages.map(({ id }) => id)),
            ),
          );
      }

      const remaining = await this.countEvidence(
        transaction,
        input.organizationId,
        input.cutoffAt,
        false,
      );
      const selected = quarantines.length + sources.length + pages.length;
      const [completed] = await transaction
        .update(retentionExecutions)
        .set({
          state: "succeeded",
          selectedCount: selected,
          expiredCount: selected,
          alreadyExpiredCount: alreadyExpired,
          failedCount: 0,
          remainingCount: remaining,
          pagesExpiredCount: pages.length,
          sourceRecordsExpiredCount: sources.length,
          quarantinesExpiredCount: quarantines.length,
          finishedAt,
        })
        .where(
          and(
            eq(retentionExecutions.id, input.executionId),
            eq(retentionExecutions.organizationId, input.organizationId),
            eq(retentionExecutions.state, "running"),
          ),
        )
        .returning();
      if (!completed) throw new Error("Retention execution could not be completed.");
      await transaction.insert(auditEvents).values({
        organizationId: input.organizationId,
        actorKey: "system:retention",
        action: "provider.retention.expire",
        subjectType: "retention_execution",
        subjectId: input.executionId,
        outcome: "success",
        metadataJson: {
          selected,
          expired: selected,
          alreadyExpired,
          remaining,
          pages: pages.length,
          sourceRecords: sources.length,
          quarantines: quarantines.length,
        },
        occurredAt: finishedAt,
      });
      return {
        result: this.toResult(completed, false),
        recovered: previous?.state === "failed",
        expiredQuarantines: quarantines
          .filter(({ state }) => state === "open")
          .map(({ id, providerId, reasonCode }) => ({
            id,
            providerId,
            reasonCode,
          })),
      };
    });
  }

  async recordFailure(input: {
    executionId: string;
    organizationId: string;
    cutoffAt: Date;
    batchSize: number;
    startedAt: Date;
    finishedAt: Date;
    failureCode: string;
  }): Promise<RetentionBatchResult> {
    this.assertBatchSize(input.batchSize);
    const failureCode = /^[A-Z][A-Z0-9_]{0,127}$/.test(input.failureCode)
      ? input.failureCode
      : "RETENTION_FAILED";
    return this.database.transaction(async (transaction) => {
      const [existing] = await transaction
        .select()
        .from(retentionExecutions)
        .where(eq(retentionExecutions.id, input.executionId))
        .limit(1)
        .for("update");
      if (existing && existing.organizationId !== input.organizationId) {
        throw new Error("Retention execution identity is outside tenant scope.");
      }
      if (existing?.finishedAt) return this.toResult(existing, true);
      const [record] = existing
        ? await transaction
            .update(retentionExecutions)
            .set({
              state: "failed",
              failedCount: 1,
              failureCode,
              sanitizedSummary: "A bounded protected-data cleanup did not complete.",
              finishedAt: input.finishedAt,
            })
            .where(
              and(
                eq(retentionExecutions.id, input.executionId),
                eq(retentionExecutions.organizationId, input.organizationId),
              ),
            )
            .returning()
        : await transaction
            .insert(retentionExecutions)
            .values({
              id: input.executionId,
              organizationId: input.organizationId,
              state: "failed",
              cutoffAt: input.cutoffAt,
              batchSize: input.batchSize,
              failedCount: 1,
              failureCode,
              sanitizedSummary: "A bounded protected-data cleanup did not complete.",
              startedAt: input.startedAt,
              finishedAt: input.finishedAt,
            })
            .returning();
      if (!record) throw new Error("Retention failure could not be recorded.");
      await transaction.insert(auditEvents).values({
        organizationId: input.organizationId,
        actorKey: "system:retention",
        action: "provider.retention.expire",
        subjectType: "retention_execution",
        subjectId: input.executionId,
        outcome: "failure",
        metadataJson: { failureCode },
        occurredAt: input.finishedAt,
      });
      return this.toResult(record, false);
    });
  }

  private async countEvidence(
    database: PackscoutDatabase<TQueryResult>,
    organizationId: string,
    cutoffAt: Date,
    expired: boolean,
  ): Promise<number> {
    const pagePayloadCondition = expired
      ? and(isNull(importPages.payloadJson), isNotNull(importPages.payloadExpiredAt))
      : isNotNull(importPages.payloadJson);
    const sourcePayloadCondition = expired
      ? and(
          isNull(sourceRecords.payloadJson),
          isNotNull(sourceRecords.payloadExpiredAt),
        )
      : isNotNull(sourceRecords.payloadJson);
    const quarantinePayloadCondition = expired
      ? isNotNull(quarantineRecords.payloadExpiredAt)
      : or(
          isNotNull(quarantineRecords.payloadJson),
          eq(quarantineRecords.state, "open"),
        );
    const [[pageCount], [sourceCount], [quarantineCount]] = await Promise.all([
      database
        .select({ value: count() })
        .from(importPages)
        .where(
          and(
            eq(importPages.organizationId, organizationId),
            lte(importPages.expiresAt, cutoffAt),
            pagePayloadCondition,
          ),
        ),
      database
        .select({ value: count() })
        .from(sourceRecords)
        .where(
          and(
            eq(sourceRecords.organizationId, organizationId),
            lte(sourceRecords.expiresAt, cutoffAt),
            sourcePayloadCondition,
          ),
        ),
      database
        .select({ value: count() })
        .from(quarantineRecords)
        .where(
          and(
            eq(quarantineRecords.organizationId, organizationId),
            lte(quarantineRecords.expiresAt, cutoffAt),
            quarantinePayloadCondition,
          ),
        ),
    ]);
    return (
      Number(pageCount?.value ?? 0) +
      Number(sourceCount?.value ?? 0) +
      Number(quarantineCount?.value ?? 0)
    );
  }

  private toResult(
    execution: typeof retentionExecutions.$inferSelect,
    replayed: boolean,
  ): RetentionBatchResult {
    const finishedAt = execution.finishedAt ?? execution.startedAt;
    return {
      executionId: execution.id,
      selected: execution.selectedCount,
      expired: execution.expiredCount,
      alreadyExpired: execution.alreadyExpiredCount,
      failed: execution.failedCount,
      remaining: execution.remainingCount,
      pagesExpired: execution.pagesExpiredCount,
      sourceRecordsExpired: execution.sourceRecordsExpiredCount,
      quarantinesExpired: execution.quarantinesExpiredCount,
      startedAt: execution.startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: duration(execution.startedAt, finishedAt),
      replayed,
    };
  }

  private assertBatchSize(batchSize: number): void {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
      throw new RangeError("Retention batch size must be between 1 and 10000.");
    }
  }
}

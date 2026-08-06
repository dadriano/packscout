import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
import type { PackscoutDatabase } from "./database.ts";
import {
  auditEvents,
  importRuns,
  providerConfigRevisions,
  providerCursorCheckpoints,
  providerSources,
  type RunCounters,
} from "./schema/index.ts";

export type PersistedImportTrigger = "scheduled" | "manual";
export type PersistedImportRunState =
  | "queued"
  | "running"
  | "succeeded"
  | "incomplete"
  | "failed";

export interface PersistedImportRun {
  readonly id: string;
  readonly organizationId: string;
  readonly providerId: string;
  readonly configRevisionId: string;
  readonly trigger: PersistedImportTrigger | "recovery";
  readonly state: PersistedImportRunState;
  readonly requestedCursor: string | null;
  readonly finalCursor: string | null;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly heartbeatAt: Date | null;
  readonly counters: RunCounters;
  readonly reachedProviderHead: boolean;
  readonly failureCode: string | null;
  readonly failureSummary: string | null;
}

export interface ClaimedImportRun extends PersistedImportRun {
  readonly state: "running";
  readonly workerId: string;
  readonly leaseExpiresAt: Date;
  readonly currentCursor: string | null;
  readonly nextPageNumber: number;
}

export type RequestImportPersistenceResult =
  | { readonly kind: "created"; readonly run: PersistedImportRun }
  | { readonly kind: "active"; readonly run: PersistedImportRun }
  | { readonly kind: "not_found" }
  | { readonly kind: "provider_unavailable" };

export type ClaimImportPersistenceResult =
  | { readonly kind: "claimed"; readonly run: ClaimedImportRun }
  | { readonly kind: "not_found" }
  | { readonly kind: "not_claimable"; readonly run: PersistedImportRun };

export type FinishImportPersistenceResult =
  | { readonly kind: "finished"; readonly run: PersistedImportRun }
  | { readonly kind: "not_found" }
  | { readonly kind: "ownership_lost" }
  | { readonly kind: "already_terminal"; readonly run: PersistedImportRun };

const emptyCounters: RunCounters = {
  accepted: 0,
  duplicate: 0,
  quarantined: 0,
  pages: 0,
  records: 0,
  requestAttempts: 0,
  transientRetries: 0,
};

function normalizeCounters(counters: RunCounters | null): RunCounters {
  return {
    ...emptyCounters,
    ...(counters ?? {}),
  };
}

export class DrizzleImportRunRepository<
  TQueryResult extends PgQueryResultHKT,
> {
  constructor(private readonly database: PackscoutDatabase<TQueryResult>) {}

  async requestRun(input: {
    organizationId: string;
    providerId: string;
    runId: string;
    trigger: PersistedImportTrigger;
    requestedByActorKey: string | null;
    requestedAt: Date;
  }): Promise<RequestImportPersistenceResult> {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select id from ${providerSources} where ${providerSources.id} = ${input.providerId} and ${providerSources.organizationId} = ${input.organizationId} for update`,
      );
      const [provider] = await transaction
        .select({
          id: providerSources.id,
          state: providerSources.state,
          activeRevisionId: providerSources.activeRevisionId,
        })
        .from(providerSources)
        .where(
          and(
            eq(providerSources.organizationId, input.organizationId),
            eq(providerSources.id, input.providerId),
          ),
        )
        .limit(1);
      if (!provider) return { kind: "not_found" };
      if (provider.state !== "active" || !provider.activeRevisionId) {
        return { kind: "provider_unavailable" };
      }
      const [activeRevision] = await transaction
        .select({ testedAt: providerConfigRevisions.testedAt })
        .from(providerConfigRevisions)
        .where(
          and(
            eq(providerConfigRevisions.organizationId, input.organizationId),
            eq(providerConfigRevisions.providerId, input.providerId),
            eq(providerConfigRevisions.id, provider.activeRevisionId),
          ),
        )
        .limit(1);
      if (!activeRevision?.testedAt) return { kind: "provider_unavailable" };

      const activeRun = await this.loadActiveRun(
        transaction,
        input.organizationId,
        input.providerId,
      );
      if (activeRun) return { kind: "active", run: activeRun };
      const [checkpoint] = await transaction
        .select({ cursor: providerCursorCheckpoints.cursor })
        .from(providerCursorCheckpoints)
        .where(
          and(
            eq(providerCursorCheckpoints.organizationId, input.organizationId),
            eq(providerCursorCheckpoints.providerId, input.providerId),
            eq(providerCursorCheckpoints.configRevisionId, provider.activeRevisionId),
          ),
        )
        .limit(1);
      await transaction.insert(importRuns).values({
        id: input.runId,
        organizationId: input.organizationId,
        providerId: input.providerId,
        configRevisionId: provider.activeRevisionId,
        trigger: input.trigger,
        requestedByActorKey: input.requestedByActorKey,
        state: "queued",
        requestedCursor: checkpoint?.cursor ?? null,
        countersJson: emptyCounters,
        createdAt: input.requestedAt,
      });
      await transaction.insert(auditEvents).values({
        organizationId: input.organizationId,
        actorKey: input.requestedByActorKey ?? "system:scheduler",
        action: "provider.import.request",
        subjectType: "import_run",
        subjectId: input.runId,
        outcome: "success",
        metadataJson: {
          providerId: input.providerId,
          configRevisionId: provider.activeRevisionId,
          trigger: input.trigger,
        },
        occurredAt: input.requestedAt,
      });
      const run = await this.loadRun(transaction, input.organizationId, input.runId);
      if (!run) throw new Error("Created import run could not be loaded.");
      return { kind: "created", run };
    });
  }

  async claimRun(input: {
    organizationId: string;
    runId: string;
    workerId: string;
    claimedAt: Date;
    leaseExpiresAt: Date;
  }): Promise<ClaimImportPersistenceResult> {
    this.assertLease(input.workerId, input.claimedAt, input.leaseExpiresAt);
    return this.database.transaction(async (transaction) => {
      const run = await this.lockRun(transaction, input.organizationId, input.runId);
      if (!run) return { kind: "not_found" };
      const [lease] = await transaction
        .select({ owner: importRuns.leaseOwner, expiresAt: importRuns.leaseExpiresAt })
        .from(importRuns)
        .where(
          and(
            eq(importRuns.organizationId, input.organizationId),
            eq(importRuns.id, input.runId),
          ),
        )
        .limit(1);
      const canClaim =
        run.state === "queued" ||
        (run.state === "running" &&
          lease?.expiresAt !== null &&
          lease?.expiresAt !== undefined &&
          lease.expiresAt <= input.claimedAt);
      if (!canClaim) return { kind: "not_claimable", run };
      await transaction
        .update(importRuns)
        .set({
          state: "running",
          startedAt: run.startedAt ?? input.claimedAt,
          heartbeatAt: input.claimedAt,
          leaseOwner: input.workerId,
          leaseExpiresAt: input.leaseExpiresAt,
          attempt: sql`${importRuns.attempt} + 1`,
        })
        .where(
          and(
            eq(importRuns.organizationId, input.organizationId),
            eq(importRuns.id, input.runId),
          ),
        );
      const [checkpoint] = await transaction
        .select({ cursor: providerCursorCheckpoints.cursor })
        .from(providerCursorCheckpoints)
        .where(
          and(
            eq(providerCursorCheckpoints.organizationId, input.organizationId),
            eq(providerCursorCheckpoints.providerId, run.providerId),
            eq(providerCursorCheckpoints.configRevisionId, run.configRevisionId),
          ),
        )
        .limit(1);
      const claimed = await this.loadRun(transaction, input.organizationId, input.runId);
      if (!claimed) throw new Error("Claimed import run could not be loaded.");
      return {
        kind: "claimed",
        run: {
          ...claimed,
          state: "running",
          workerId: input.workerId,
          leaseExpiresAt: input.leaseExpiresAt,
          currentCursor: checkpoint?.cursor ?? null,
          nextPageNumber: claimed.counters.pages + 1,
        },
      };
    });
  }

  async renewLease(input: {
    organizationId: string;
    runId: string;
    workerId: string;
    renewedAt: Date;
    leaseExpiresAt: Date;
  }): Promise<boolean> {
    this.assertLease(input.workerId, input.renewedAt, input.leaseExpiresAt);
    const renewed = await this.database
      .update(importRuns)
      .set({ heartbeatAt: input.renewedAt, leaseExpiresAt: input.leaseExpiresAt })
      .where(
        and(
          eq(importRuns.organizationId, input.organizationId),
          eq(importRuns.id, input.runId),
          eq(importRuns.state, "running"),
          eq(importRuns.leaseOwner, input.workerId),
          gte(importRuns.leaseExpiresAt, input.renewedAt),
        ),
      )
      .returning({ id: importRuns.id });
    return renewed.length === 1;
  }

  async recordRequestAttempt(input: {
    organizationId: string;
    runId: string;
    workerId: string;
    transientRetry: boolean;
  }): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const run = await this.lockRun(transaction, input.organizationId, input.runId);
      if (!run || run.state !== "running") return false;
      const [owner] = await transaction
        .select({ leaseOwner: importRuns.leaseOwner })
        .from(importRuns)
        .where(eq(importRuns.id, input.runId))
        .limit(1);
      if (owner?.leaseOwner !== input.workerId) return false;
      const counters = {
        ...run.counters,
        requestAttempts: run.counters.requestAttempts + 1,
        transientRetries:
          run.counters.transientRetries + (input.transientRetry ? 1 : 0),
      };
      await transaction
        .update(importRuns)
        .set({ countersJson: counters })
        .where(
          and(
            eq(importRuns.organizationId, input.organizationId),
            eq(importRuns.id, input.runId),
          ),
        );
      return true;
    });
  }

  async finishRun(input: {
    organizationId: string;
    runId: string;
    workerId: string;
    state: "succeeded" | "incomplete" | "failed";
    reachedProviderHead: boolean;
    failureCode: string | null;
    failureSummary: string | null;
    finishedAt: Date;
  }): Promise<FinishImportPersistenceResult> {
    return this.database.transaction(async (transaction) => {
      const run = await this.lockRun(transaction, input.organizationId, input.runId);
      if (!run) return { kind: "not_found" };
      if (run.state !== "running") {
        return { kind: "already_terminal", run };
      }
      const [owner] = await transaction
        .select({ leaseOwner: importRuns.leaseOwner })
        .from(importRuns)
        .where(eq(importRuns.id, input.runId))
        .limit(1);
      if (owner?.leaseOwner !== input.workerId) return { kind: "ownership_lost" };
      await transaction
        .update(importRuns)
        .set({
          state: input.state,
          reachedProviderHead: input.reachedProviderHead,
          failureCode: input.failureCode,
          failureSummary: input.failureSummary,
          finishedAt: input.finishedAt,
          heartbeatAt: input.finishedAt,
          leaseOwner: null,
          leaseExpiresAt: null,
        })
        .where(
          and(
            eq(importRuns.organizationId, input.organizationId),
            eq(importRuns.id, input.runId),
          ),
        );
      await transaction.insert(auditEvents).values({
        organizationId: input.organizationId,
        actorKey: "system:import-worker",
        action: "provider.import.finish",
        subjectType: "import_run",
        subjectId: input.runId,
        outcome: input.state === "failed" ? "failure" : "success",
        metadataJson: {
          providerId: run.providerId,
          configRevisionId: run.configRevisionId,
          state: input.state,
          failureCode: input.failureCode,
          reachedProviderHead: input.reachedProviderHead,
        },
        occurredAt: input.finishedAt,
      });
      const finished = await this.loadRun(transaction, input.organizationId, input.runId);
      if (!finished) throw new Error("Finished import run could not be loaded.");
      return { kind: "finished", run: finished };
    });
  }

  async getRun(
    organizationId: string,
    runId: string,
  ): Promise<PersistedImportRun | null> {
    return this.loadRun(this.database, organizationId, runId);
  }

  private assertLease(workerId: string, startsAt: Date, expiresAt: Date): void {
    if (
      workerId.length < 1 ||
      workerId.length > 256 ||
      expiresAt.getTime() <= startsAt.getTime()
    ) {
      throw new RangeError("Import run lease is invalid.");
    }
  }

  private async loadActiveRun(
    database: PackscoutDatabase<TQueryResult>,
    organizationId: string,
    providerId: string,
  ): Promise<PersistedImportRun | null> {
    const [row] = await database
      .select()
      .from(importRuns)
      .where(
        and(
          eq(importRuns.organizationId, organizationId),
          eq(importRuns.providerId, providerId),
          sql`${importRuns.state} in ('queued', 'running')`,
        ),
      )
      .orderBy(desc(importRuns.createdAt))
      .limit(1);
    return row ? this.toRun(row) : null;
  }

  private async loadRun(
    database: PackscoutDatabase<TQueryResult>,
    organizationId: string,
    runId: string,
  ): Promise<PersistedImportRun | null> {
    const [row] = await database
      .select()
      .from(importRuns)
      .where(
        and(
          eq(importRuns.organizationId, organizationId),
          eq(importRuns.id, runId),
        ),
      )
      .limit(1);
    return row ? this.toRun(row) : null;
  }

  private async lockRun(
    database: PackscoutDatabase<TQueryResult>,
    organizationId: string,
    runId: string,
  ): Promise<PersistedImportRun | null> {
    await database.execute(
      sql`select id from ${importRuns} where ${importRuns.id} = ${runId} and ${importRuns.organizationId} = ${organizationId} for update`,
    );
    return this.loadRun(database, organizationId, runId);
  }

  private toRun(row: typeof importRuns.$inferSelect): PersistedImportRun {
    return {
      id: row.id,
      organizationId: row.organizationId,
      providerId: row.providerId,
      configRevisionId: row.configRevisionId,
      trigger: row.trigger,
      state: row.state,
      requestedCursor: row.requestedCursor,
      finalCursor: row.finalCursor,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      heartbeatAt: row.heartbeatAt,
      counters: normalizeCounters(row.countersJson),
      reachedProviderHead: row.reachedProviderHead,
      failureCode: row.failureCode,
      failureSummary: row.failureSummary,
    };
  }
}

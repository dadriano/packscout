import {
  PrismaBackgroundWorkRepository,
  PrismaWorkerPresenceRepository,
  type BackgroundWorkCursor,
  type RecomputationQueueRecord,
  type RecomputationRecoveryResolution,
  type RetentionExecutionRecord,
} from "@packscout/database";
import {
  evaluateRecomputationBacklog,
  evaluateRetentionCadence,
  resolveBackgroundWorkTimelinessMs,
  type RecomputationQueueEntry,
  type RecomputationRecoveryAction,
  type RecomputationRecoveryResult,
  type RetentionExecutionSummary,
  type WorkerEffectiveSettings,
} from "@packscout/contracts";
import { classifyWorkerPresence } from "@packscout/services";
import { createProviderActorKeyer, createRecordReferencer } from "./auth/actor-key.ts";
import { InvalidOperationCursorError } from "./import-operations-runtime.ts";
import type {
  BackgroundWorkRouterDependencies,
  RecomputationQueuePage,
  RetentionExecutionPage,
} from "./routes/background-work.ts";

type BackgroundWorkDatabase = ConstructorParameters<
  typeof PrismaBackgroundWorkRepository
>[0];

export interface AdminBackgroundWorkRuntimeInput {
  readonly database: BackgroundWorkDatabase;
  readonly actorPseudonymKey: Uint8Array;
}

type CursorKind = "recomputation" | "retention";

interface CursorPayload {
  readonly version: 1;
  readonly kind: CursorKind;
  readonly value: string;
  readonly id: string;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const durableStates = {
  pending: "queued",
  claimed: "running",
  failed: "failed",
  completed: "completed",
} as const;

const browserStates = {
  queued: "pending",
  running: "claimed",
  failed: "failed",
  completed: "completed",
} as const;

function encodeCursor(kind: CursorKind, at: Date, id: string): string {
  return Buffer.from(
    JSON.stringify({ version: 1, kind, value: at.toISOString(), id }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(
  kind: CursorKind,
  cursor: string | undefined,
): BackgroundWorkCursor | undefined {
  if (cursor === undefined) return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Partial<CursorPayload>;
    if (
      parsed.version !== 1 ||
      parsed.kind !== kind ||
      typeof parsed.value !== "string" ||
      !Number.isFinite(Date.parse(parsed.value)) ||
      typeof parsed.id !== "string" ||
      !uuidPattern.test(parsed.id)
    ) {
      throw new Error("invalid");
    }
    return { createdAt: new Date(parsed.value), id: parsed.id };
  } catch {
    throw new InvalidOperationCursorError();
  }
}

function claimAgeMs(record: RecomputationQueueRecord, now: Date): number | null {
  if (record.state !== "running") return null;
  return Math.max(0, now.getTime() - record.updatedAt.getTime());
}

export function createAdminBackgroundWorkRuntime(
  input: AdminBackgroundWorkRuntimeInput,
): Omit<
  BackgroundWorkRouterDependencies,
  "auth" | "cookiePolicy" | "sameOrigin"
> {
  const clock = { now: () => new Date() };
  const repository = new PrismaBackgroundWorkRepository(input.database);
  const presence = new PrismaWorkerPresenceRepository(input.database);
  const keyer = createProviderActorKeyer(input.actorPseudonymKey);
  const packReference = createRecordReferencer(input.actorPseudonymKey, "pack");

  function toEntry(
    record: RecomputationQueueRecord,
    now: Date,
  ): RecomputationQueueEntry {
    return {
      id: record.id,
      providerId: record.providerId,
      platformKey: record.platformKey,
      state: browserStates[record.state],
      packReference: packReference([
        record.platformKey,
        record.packExternalId,
        record.evInputExternalId,
      ]),
      attemptCount: record.attemptCount,
      createdAt: record.createdAt.toISOString(),
      availableAt: record.availableAt.toISOString(),
      completedAt: record.completedAt?.toISOString() ?? null,
      claimedBy: record.state === "running" ? record.claimedBy : null,
      claimExpiresAt: record.claimExpiresAt?.toISOString() ?? null,
      claimAgeMs: claimAgeMs(record, now),
      claimExpired:
        record.state === "running" &&
        record.claimExpiresAt !== null &&
        record.claimExpiresAt <= now,
      failureCode: record.failureCode,
      // The route derives the operator-facing sentence from the stable code so
      // no exception text ever leaves the server.
      failureSummary: null,
    };
  }

  function toExecution(
    record: RetentionExecutionRecord,
  ): RetentionExecutionSummary {
    const pruned = {
      pages: record.pagesExpired,
      sourceRecords: record.sourceRecordsExpired,
      quarantines: record.quarantinesExpired,
      total:
        record.pagesExpired +
        record.sourceRecordsExpired +
        record.quarantinesExpired,
    };
    return {
      id: record.id,
      state: record.state,
      startedAt: record.startedAt.toISOString(),
      finishedAt: record.finishedAt?.toISOString() ?? null,
      durationMs: record.finishedAt
        ? Math.max(0, record.finishedAt.getTime() - record.startedAt.getTime())
        : null,
      cutoffAt: record.cutoffAt.toISOString(),
      pruned,
      alreadyExpired: record.alreadyExpired,
      remaining: record.remaining,
      failureCode: record.failureCode,
      failureSummary: record.sanitizedSummary,
    };
  }

  /**
   * The settings the live fleet actually published. A stopped or stale
   * instance no longer speaks for the fleet, so its window is excluded and an
   * absent fleet yields no threshold at all.
   */
  async function publishedSettings(
    now: Date,
  ): Promise<readonly WorkerEffectiveSettings[]> {
    const instances = await presence.listInstances({ limit: 100 });
    return instances
      .filter((instance) => classifyWorkerPresence(instance, now) === "running")
      .map((instance) => instance.effectiveSettings);
  }

  async function resolve(
    action: RecomputationRecoveryAction,
    organizationId: string,
    requestId: string,
    actorKey: string,
    now: Date,
  ): Promise<RecomputationRecoveryResolution> {
    const request = { organizationId, requestId, actorKey, now };
    return action === "release"
      ? repository.releaseStuckClaim(request)
      : repository.requeueFailedEntry(request);
  }

  return {
    reads: {
      async listRecomputations(request): Promise<RecomputationQueuePage> {
        const now = clock.now();
        const before = decodeCursor("recomputation", request.cursor);
        const [page, aggregate, settings] = await Promise.all([
          repository.listRecomputations({
            organizationId: request.organizationId,
            limit: request.limit,
            ...(request.state ? { state: durableStates[request.state] } : {}),
            ...(before ? { before } : {}),
          }),
          repository.aggregateRecomputations({
            organizationId: request.organizationId,
            now,
          }),
          publishedSettings(now),
        ]);
        const last = page.items.at(-1);
        return {
          items: page.items.map((record) => toEntry(record, now)),
          nextCursor:
            page.hasMore && last
              ? encodeCursor("recomputation", last.createdAt, last.id)
              : null,
          backlog: evaluateRecomputationBacklog({
            now: now.toISOString(),
            pending: aggregate.pending,
            readyPending: aggregate.readyPending,
            claimed: aggregate.claimed,
            expiredClaims: aggregate.expiredClaims,
            failed: aggregate.failed,
            oldestPendingAvailableAt:
              aggregate.oldestPendingAvailableAt?.toISOString() ?? null,
            timelyAfterMs: resolveBackgroundWorkTimelinessMs(settings),
          }),
        };
      },
      async listRetentionExecutions(request): Promise<RetentionExecutionPage> {
        const now = clock.now();
        const before = decodeCursor("retention", request.cursor);
        const [page, latest, settings] = await Promise.all([
          repository.listRetentionExecutions({
            organizationId: request.organizationId,
            limit: request.limit,
            ...(before ? { before } : {}),
          }),
          repository.latestRetentionExecution({
            organizationId: request.organizationId,
          }),
          publishedSettings(now),
        ]);
        const last = page.items.at(-1);
        return {
          items: page.items.map(toExecution),
          nextCursor:
            page.hasMore && last
              ? encodeCursor("retention", last.startedAt, last.id)
              : null,
          cadence: evaluateRetentionCadence({
            now: now.toISOString(),
            expectedIntervalMs: resolveBackgroundWorkTimelinessMs(settings),
            latest: latest ? toExecution(latest) : null,
          }),
        };
      },
    },
    recovery: {
      async recover(request): Promise<readonly RecomputationRecoveryResult[]> {
        const now = clock.now();
        const actorKey = keyer.keyFor({
          organizationId: request.actor.organizationId,
          operatorId: request.actor.operatorId,
        });
        const results: RecomputationRecoveryResult[] = [];
        for (const requestId of request.requestIds) {
          const resolution = await resolve(
            request.action,
            request.actor.organizationId,
            requestId,
            actorKey,
            now,
          );
          results.push({
            requestId,
            outcome: resolution.outcome,
            entry: resolution.record
              ? toEntry(resolution.record, clock.now())
              : null,
          });
        }
        return results;
      },
    },
  };
}

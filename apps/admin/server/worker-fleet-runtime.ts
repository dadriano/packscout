import {
  PrismaWorkerFleetReadRepository,
  PrismaWorkerPresenceRepository,
  type ProviderScheduleRecord,
  type RunningImportRunRecord,
  type WorkerFleetCursor,
  type WorkerPresenceRecord,
} from "@packscout/database";
import {
  evaluateRunStall,
  evaluateScheduleHealth,
  evaluateWorkerFleet,
  isScheduleWedged,
  resolveWorkerFleetSettings,
  WORKER_FLEET_SCAN_LIMIT,
  type ScheduleHealthView,
  type StalledRunView,
  type WorkerActivityScope,
  type WorkerFleetSettingsResolution,
  type WorkerInstanceView,
} from "@packscout/contracts";
import {
  classifyWorkerPresence,
  isImportRunStalled,
  workerPresenceAgeMs,
} from "@packscout/services";
import { InvalidOperationCursorError } from "./import-operations-runtime.ts";
import type {
  ScheduleHealthPage,
  StalledRunPage,
  WorkerFleetInstancesPage,
  WorkerFleetRouterDependencies,
  WorkerSettingsReport,
} from "./routes/worker-fleet.ts";

/**
 * Composes the admin's worker-fleet reads from durable presence, run, and
 * schedule evidence.
 *
 * Every threshold comes from what the fleet published — per-instance staleness
 * through `classifyWorkerPresence`, run heartbeats through `isImportRunStalled`,
 * schedule tolerance through the resolved presence window — and every condition
 * is decided by the shared evaluations, so the admin and alerting describe one
 * observation the same way.
 */

type WorkerFleetDatabase = ConstructorParameters<
  typeof PrismaWorkerFleetReadRepository
>[0];

export interface AdminWorkerFleetRuntimeInput {
  readonly database: WorkerFleetDatabase;
}

type CursorKind = "stalled_run" | "schedule";

interface CursorPayload {
  readonly version: 1;
  readonly kind: CursorKind;
  readonly value: string;
  readonly id: string;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function encodeCursor(kind: CursorKind, at: Date, id: string): string {
  return Buffer.from(
    JSON.stringify({ version: 1, kind, value: at.toISOString(), id }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(
  kind: CursorKind,
  cursor: string | undefined,
): WorkerFleetCursor | undefined {
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
    return { at: new Date(parsed.value), id: parsed.id };
  } catch {
    throw new InvalidOperationCursorError();
  }
}

function ageMs(from: Date | null, now: Date): number | null {
  return from === null ? null : Math.max(0, now.getTime() - from.getTime());
}

function lastSignalOf(record: RunningImportRunRecord): Date | null {
  return record.heartbeatAt ?? record.startedAt;
}

interface PresenceSnapshot {
  readonly records: readonly WorkerPresenceRecord[];
  readonly settings: WorkerFleetSettingsResolution;
  /** Identities still retained, so a departed lease holder reads as departed. */
  readonly identities: ReadonlySet<string>;
}

export function createAdminWorkerFleetRuntime(
  input: AdminWorkerFleetRuntimeInput,
): Omit<WorkerFleetRouterDependencies, "auth" | "cookiePolicy"> {
  const clock = { now: () => new Date() };
  const presence = new PrismaWorkerPresenceRepository(input.database);
  const evidence = new PrismaWorkerFleetReadRepository(input.database);

  async function readPresence(): Promise<PresenceSnapshot> {
    const records = await presence.listInstances({
      limit: WORKER_FLEET_SCAN_LIMIT,
    });
    return {
      records,
      settings: resolveWorkerFleetSettings(
        records.map((record) => record.effectiveSettings),
      ),
      identities: new Set(records.map((record) => record.instanceId)),
    };
  }

  function toInstanceView(
    record: WorkerPresenceRecord,
    now: Date,
    organizationId: string,
    providerNames: ReadonlyMap<string, string>,
  ): WorkerInstanceView {
    const activity = record.currentActivity;
    const scope: WorkerActivityScope =
      activity.kind === "idle"
        ? "idle"
        : activity.organizationId === organizationId
          ? "workspace"
          : "other_workspace";
    const inWorkspace = scope === "workspace";
    return {
      instanceId: record.instanceId,
      status: classifyWorkerPresence(record, now),
      state: record.state,
      version: record.version,
      host: record.host,
      runtimeVersion: record.runtimeVersion,
      startedAt: record.startedAt.toISOString(),
      upForMs: Math.max(0, now.getTime() - record.startedAt.getTime()),
      lastHeartbeatAt: record.lastHeartbeatAt.toISOString(),
      heartbeatAgeMs: workerPresenceAgeMs(record, now),
      stoppedAt: record.stoppedAt?.toISOString() ?? null,
      activity: {
        kind: activity.kind,
        scope,
        providerId: inWorkspace ? activity.providerId : null,
        providerName:
          inWorkspace && activity.providerId !== null
            ? (providerNames.get(activity.providerId) ?? null)
            : null,
        runId: inWorkspace ? activity.runId : null,
        startedAt: record.activityStartedAt?.toISOString() ?? null,
        ageMs: ageMs(record.activityStartedAt, now),
      },
      effectiveSettings: record.effectiveSettings,
    };
  }

  /**
   * A run counts as stalled only when `isImportRunStalled` says so against the
   * window the fleet published. Without published settings nothing says what
   * "stalled" means, so no run is accused of it.
   */
  function stallOf(
    record: RunningImportRunRecord,
    staleAfterMs: number | null,
    now: Date,
  ): ReturnType<typeof evaluateRunStall> | null {
    if (staleAfterMs === null) return null;
    const stalled = isImportRunStalled(
      {
        state: record.state,
        heartbeatAt: record.heartbeatAt,
        startedAt: record.startedAt,
      },
      { runHeartbeatStaleAfterMs: staleAfterMs },
      now,
    );
    if (!stalled) return null;
    return evaluateRunStall({
      now: now.toISOString(),
      stalled,
      lastSignalAt: lastSignalOf(record)?.toISOString() ?? null,
      staleAfterMs,
    });
  }

  function toStalledRun(
    record: RunningImportRunRecord,
    stall: ReturnType<typeof evaluateRunStall>,
    now: Date,
    identities: ReadonlySet<string>,
  ): StalledRunView {
    return {
      runId: record.runId,
      providerId: record.providerId,
      providerName: record.providerName,
      platformKey: record.platformKey,
      trigger: record.trigger,
      startedAt: record.startedAt?.toISOString() ?? null,
      lastHeartbeatAt: record.heartbeatAt?.toISOString() ?? null,
      stall,
      leaseOwner: record.leaseOwner,
      leaseOwnerPresent:
        record.leaseOwner !== null && identities.has(record.leaseOwner),
      leaseExpiresAt: record.leaseExpiresAt?.toISOString() ?? null,
      leaseExpired:
        record.leaseExpiresAt !== null &&
        record.leaseExpiresAt.getTime() <= now.getTime(),
    };
  }

  function toScheduleHealth(
    record: ProviderScheduleRecord,
    overdueAfterMs: number | null,
    now: Date,
    identities: ReadonlySet<string>,
  ): ScheduleHealthView {
    return {
      providerId: record.providerId,
      providerName: record.providerName,
      platformKey: record.platformKey,
      nextDueAt: record.nextDueAt.toISOString(),
      health: evaluateScheduleHealth({
        now: now.toISOString(),
        nextDueAt: record.nextDueAt.toISOString(),
        claimOwner: record.claimOwner,
        claimExpiresAt: record.claimExpiresAt?.toISOString() ?? null,
        lastClaimedAt: record.lastClaimedAt?.toISOString() ?? null,
        overdueAfterMs,
      }),
      claimOwner: record.claimOwner,
      claimOwnerPresent:
        record.claimOwner !== null && identities.has(record.claimOwner),
      claimExpiresAt: record.claimExpiresAt?.toISOString() ?? null,
      lastClaimedAt: record.lastClaimedAt?.toISOString() ?? null,
      lastOutcome: record.lastOutcome,
      lastRunId: record.lastRunId,
    };
  }

  return {
    reads: {
      async listInstances(request): Promise<WorkerFleetInstancesPage> {
        const now = clock.now();
        const [snapshot, runs, schedules] = await Promise.all([
          readPresence(),
          evidence.listRunningRuns({
            organizationId: request.organizationId,
            limit: WORKER_FLEET_SCAN_LIMIT,
          }),
          evidence.listSchedules({
            organizationId: request.organizationId,
            limit: WORKER_FLEET_SCAN_LIMIT,
          }),
        ]);
        const published = snapshot.settings.settings;
        const stalledRuns = runs.items.filter(
          (record) =>
            stallOf(record, published?.runHeartbeatStaleAfterMs ?? null, now) !==
            null,
        ).length;
        const wedgedSchedules = schedules.items.filter((record) =>
          isScheduleWedged(
            toScheduleHealth(
              record,
              published?.presenceStaleAfterMs ?? null,
              now,
              snapshot.identities,
            ).health,
          ),
        ).length;
        const providerNames = new Map(
          schedules.items.map((record) => [
            record.providerId,
            record.providerName,
          ]),
        );
        return {
          instances: snapshot.records
            .slice(0, request.limit)
            .map((record) =>
              toInstanceView(record, now, request.organizationId, providerNames),
            ),
          hasMore: snapshot.records.length > request.limit,
          fleet: evaluateWorkerFleet({
            now: now.toISOString(),
            instances: snapshot.records.map((record) => ({
              status: classifyWorkerPresence(record, now),
              heartbeatAgeMs: workerPresenceAgeMs(record, now),
            })),
            stalledRuns,
            wedgedSchedules,
          }),
          settings: snapshot.settings,
        };
      },

      async listStalledRuns(request): Promise<StalledRunPage> {
        const now = clock.now();
        const before = decodeCursor("stalled_run", request.cursor);
        const [snapshot, page] = await Promise.all([
          readPresence(),
          evidence.listRunningRuns({
            organizationId: request.organizationId,
            limit: request.limit,
            ...(before ? { before } : {}),
          }),
        ]);
        const staleAfterMs =
          snapshot.settings.settings?.runHeartbeatStaleAfterMs ?? null;
        const items: StalledRunView[] = [];
        let lastStalled: RunningImportRunRecord | undefined;
        // Running runs arrive oldest-signal first, so once a run is fresh every
        // run after it is fresher: the stalled set ends there and so does paging.
        let reachedFreshRun = false;
        for (const record of page.items) {
          const stall = stallOf(record, staleAfterMs, now);
          if (stall === null) {
            reachedFreshRun = true;
            break;
          }
          items.push(toStalledRun(record, stall, now, snapshot.identities));
          lastStalled = record;
        }
        const signal = lastStalled ? lastSignalOf(lastStalled) : null;
        return {
          items,
          nextCursor:
            !reachedFreshRun && page.hasMore && lastStalled && signal
              ? encodeCursor("stalled_run", signal, lastStalled.runId)
              : null,
          staleAfterMs,
        };
      },

      async listScheduleHealth(request): Promise<ScheduleHealthPage> {
        const now = clock.now();
        const before = decodeCursor("schedule", request.cursor);
        const [snapshot, page] = await Promise.all([
          readPresence(),
          evidence.listSchedules({
            organizationId: request.organizationId,
            limit: request.limit,
            ...(before ? { before } : {}),
          }),
        ]);
        const overdueAfterMs =
          snapshot.settings.settings?.presenceStaleAfterMs ?? null;
        const last = page.items.at(-1);
        return {
          items: page.items.map((record) =>
            toScheduleHealth(record, overdueAfterMs, now, snapshot.identities),
          ),
          nextCursor:
            page.hasMore && last
              ? encodeCursor("schedule", last.nextDueAt, last.providerId)
              : null,
          overdueAfterMs,
        };
      },

      async readSettings(): Promise<WorkerSettingsReport> {
        const now = clock.now();
        const snapshot = await readPresence();
        return { settings: snapshot.settings, observedAt: now.toISOString() };
      },
    },
  };
}

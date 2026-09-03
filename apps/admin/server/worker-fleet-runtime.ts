import {
  PrismaWorkerFleetReadRepository,
  PrismaWorkerPresenceRepository,
  type RunningImportRunRecord,
  type WorkerFleetCursor,
  type WorkerPresenceRecord,
} from "@packscout/database";
import {
  isScheduleWedged,
  WORKER_FLEET_SCAN_LIMIT,
  type StalledRunView,
  type WorkerActivityScope,
  type WorkerInstanceView,
} from "@packscout/contracts";
import { classifyWorkerPresence, workerPresenceAgeMs } from "@packscout/services";
import { InvalidOperationCursorError } from "./import-operations-runtime.ts";
import {
  evaluateFleetFrom,
  evaluateRunStallFor,
  readWorkerFleetSnapshot,
  toScheduleHealthView,
  toStalledRunView,
  type WorkerFleetSnapshot,
} from "./machinery-derivations.ts";
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
 * Every condition comes from the shared derivations alerting also reads, so the
 * page and the alert describe one observation the same way; this module only
 * pages the evidence and shapes it for the browser.
 */

type WorkerFleetDatabase = ConstructorParameters<
  typeof PrismaWorkerFleetReadRepository
>[0];

export interface AdminWorkerFleetRuntimeInput {
  readonly database: WorkerFleetDatabase;
}

export interface DistributedAdminWorkerFleetRuntimeInput {
  readonly presence: Pick<PrismaWorkerPresenceRepository, "listInstances">;
  readonly evidence: Pick<
    PrismaWorkerFleetReadRepository,
    "listRunningRuns" | "listSchedules"
  >;
  readonly clock?: { now(): Date };
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

export function createAdminWorkerFleetRuntime(
  input: AdminWorkerFleetRuntimeInput,
): Omit<WorkerFleetRouterDependencies, "auth" | "cookiePolicy"> {
  return createDistributedAdminWorkerFleetRuntime({
    presence: new PrismaWorkerPresenceRepository(input.database),
    evidence: new PrismaWorkerFleetReadRepository(input.database),
  });
}

/**
 * Distributed composition: presence is central, while run/schedule evidence
 * is a bounded provider-gateway aggregate supplied by the provider runtime.
 */
export function createDistributedAdminWorkerFleetRuntime(
  input: DistributedAdminWorkerFleetRuntimeInput,
): Omit<WorkerFleetRouterDependencies, "auth" | "cookiePolicy"> {
  const clock = input.clock ?? { now: () => new Date() };
  const { presence, evidence } = input;

  function readPresence(): Promise<WorkerFleetSnapshot> {
    return readWorkerFleetSnapshot(presence, WORKER_FLEET_SCAN_LIMIT);
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
            evaluateRunStallFor(
              record,
              published?.runHeartbeatStaleAfterMs ?? null,
              now,
            ) !== null,
        ).length;
        const wedgedSchedules = schedules.items.filter((record) =>
          isScheduleWedged(
            toScheduleHealthView(
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
          fleet: evaluateFleetFrom({
            records: snapshot.records,
            now,
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
          const stall = evaluateRunStallFor(record, staleAfterMs, now);
          if (stall === null) {
            reachedFreshRun = true;
            break;
          }
          items.push(
            toStalledRunView(record, stall, now, snapshot.identities),
          );
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
            toScheduleHealthView(
              record,
              overdueAfterMs,
              now,
              snapshot.identities,
            ),
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

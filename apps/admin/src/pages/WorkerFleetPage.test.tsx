import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateRunStall,
  evaluateScheduleHealth,
  evaluateWorkerFleet,
  resolveWorkerFleetSettings,
  type ScheduleHealthView,
  type StalledRunView,
  type WorkerEffectiveSettings,
  type WorkerFleetEvaluation,
  type WorkerInstanceView,
} from "@packscout/contracts";
import { MemoryRouter } from "react-router-dom";
import {
  cleanupPage,
  deferred,
  jsonResponse,
  pageText,
  renderPage,
  settlePage,
  stubFetch,
  type RecordedRequest,
} from "../testing/react-page-test.tsx";
import { WorkerFleetPage } from "./WorkerFleetPage.tsx";

const now = "2026-08-20T12:00:00.000Z";
const providerId = "00000000-0000-4000-8000-000000000020";
const runId = "00000000-0000-4000-8000-000000000030";

const settings: WorkerEffectiveSettings = {
  heartbeatIntervalMs: 15_000,
  presenceStaleAfterMs: 60_000,
  runHeartbeatStaleAfterMs: 300_000,
  scheduleClaimLeaseMs: 120_000,
  importRunLeaseMs: 600_000,
  protectedPayloadRetentionDays: 90,
  presenceRetentionDays: 30,
};
const resolution = resolveWorkerFleetSettings([settings]);

const liveInstance: WorkerInstanceView = {
  instanceId: "worker:live:1",
  status: "running",
  state: "running",
  version: "1.4.2",
  host: "pipeline-a",
  runtimeVersion: "22.11.0",
  startedAt: "2026-08-20T08:00:00.000Z",
  upForMs: 14_400_000,
  lastHeartbeatAt: "2026-08-20T11:59:55.000Z",
  heartbeatAgeMs: 5_000,
  stoppedAt: null,
  activity: {
    kind: "importing",
    scope: "workspace",
    providerId,
    providerName: "Fanatics Live",
    runId,
    startedAt: "2026-08-20T11:50:00.000Z",
    ageMs: 600_000,
  },
  effectiveSettings: settings,
};

const staleInstance: WorkerInstanceView = {
  ...liveInstance,
  instanceId: "worker:departed:1",
  status: "stale",
  lastHeartbeatAt: "2026-08-20T11:45:00.000Z",
  heartbeatAgeMs: 900_000,
  activity: {
    kind: "idle",
    scope: "idle",
    providerId: null,
    providerName: null,
    runId: null,
    startedAt: null,
    ageMs: null,
  },
};

const stalledRun: StalledRunView = {
  runId,
  providerId,
  providerName: "Fanatics Live",
  platformKey: "fanatics",
  trigger: "scheduled",
  startedAt: "2026-08-20T11:00:00.000Z",
  lastHeartbeatAt: "2026-08-20T11:50:00.000Z",
  stall: evaluateRunStall({
    now,
    stalled: true,
    lastSignalAt: "2026-08-20T11:50:00.000Z",
    staleAfterMs: settings.runHeartbeatStaleAfterMs,
  }),
  leaseOwner: "worker:departed:1",
  leaseOwnerPresent: false,
  leaseExpiresAt: "2026-08-20T11:55:00.000Z",
  leaseExpired: true,
};

function schedule(
  overrides: Partial<ScheduleHealthView> = {},
): ScheduleHealthView {
  return {
    providerId,
    providerName: "Fanatics Live",
    platformKey: "fanatics",
    nextDueAt: "2026-08-20T11:58:00.000Z",
    health: evaluateScheduleHealth({
      now,
      nextDueAt: "2026-08-20T11:58:00.000Z",
      claimOwner: null,
      claimExpiresAt: null,
      lastClaimedAt: "2026-08-20T11:00:00.000Z",
      overdueAfterMs: settings.presenceStaleAfterMs,
    }),
    claimOwner: null,
    claimOwnerPresent: false,
    claimExpiresAt: null,
    lastClaimedAt: "2026-08-20T11:00:00.000Z",
    lastOutcome: "succeeded",
    lastRunId: runId,
    ...overrides,
  };
}

const wedgedSchedule = schedule({
  nextDueAt: "2026-08-20T11:00:00.000Z",
  health: evaluateScheduleHealth({
    now,
    nextDueAt: "2026-08-20T11:00:00.000Z",
    claimOwner: "worker:departed:1",
    claimExpiresAt: "2026-08-20T11:05:00.000Z",
    lastClaimedAt: "2026-08-20T11:00:30.000Z",
    overdueAfterMs: settings.presenceStaleAfterMs,
  }),
  claimOwner: "worker:departed:1",
  claimExpiresAt: "2026-08-20T11:05:00.000Z",
  lastClaimedAt: "2026-08-20T11:00:30.000Z",
});

function route() {
  return (
    <MemoryRouter initialEntries={["/workers"]}>
      <WorkerFleetPage />
    </MemoryRouter>
  );
}

function path({ input }: RecordedRequest): string {
  return String(input);
}

interface FleetFixture {
  instances: WorkerInstanceView[];
  fleet: WorkerFleetEvaluation;
  stalledRuns?: StalledRunView[];
  schedules?: ScheduleHealthView[];
  settings?: typeof resolution;
}

function stubFleet(
  context: Parameters<typeof stubFetch>[0],
  fixture: FleetFixture,
) {
  // Thresholds follow the fixture's published settings exactly as the server
  // derives them, so a fleet that published nothing offers no threshold here
  // either.
  const published = fixture.settings ?? resolution;
  return stubFetch(context, (request) => {
    const target = path(request);
    if (target.startsWith("/api/worker-fleet/instances")) {
      return jsonResponse({
        instances: fixture.instances,
        hasMore: false,
        fleet: fixture.fleet,
        settings: published,
      });
    }
    if (target.startsWith("/api/worker-fleet/stalled-runs")) {
      return jsonResponse({
        items: fixture.stalledRuns ?? [],
        nextCursor: null,
        staleAfterMs: published.settings?.runHeartbeatStaleAfterMs ?? null,
      });
    }
    if (target.startsWith("/api/worker-fleet/schedules")) {
      return jsonResponse({
        items: fixture.schedules ?? [],
        nextCursor: null,
        overdueAfterMs: published.settings?.presenceStaleAfterMs ?? null,
      });
    }
    return jsonResponse({ settings: published, observedAt: now });
  });
}

test("a healthy fleet reports live workers, their activity, and the settings in force", async (context) => {
  const load = deferred<Response>();
  stubFetch(context, (request) =>
    path(request).startsWith("/api/worker-fleet/instances")
      ? load.promise
      : jsonResponse(
          path(request).startsWith("/api/worker-fleet/settings")
            ? { settings: resolution, observedAt: now }
            : { items: [], nextCursor: null, staleAfterMs: 300_000, overdueAfterMs: 60_000 },
        ),
  );

  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  assert.match(pageText(renderer), /Loading worker presence/);

  load.resolve(
    jsonResponse({
      instances: [liveInstance],
      hasMore: false,
      fleet: evaluateWorkerFleet({
        now,
        instances: [{ status: "running", heartbeatAgeMs: 5_000 }],
        stalledRuns: 0,
        wedgedSchedules: 0,
      }),
      settings: resolution,
    }),
  );
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /Workers are running/);
  assert.match(text, /1 worker is live and heartbeating/);
  assert.match(text, /worker:live:1/);
  assert.match(text, /pipeline-a/);
  assert.match(text, /Importing · Fanatics Live/);
  // Thresholds are the ones the fleet published, quoted read-only.
  assert.match(text, /Operating thresholds in force/);
  assert.match(text, /Run heartbeat stale after/);
  assert.match(text, /5m 0s/);
  assert.match(text, /Published by 1 instance/);
  assert.doesNotMatch(text, /No worker has heartbeated/);
});

test("a degraded fleet surfaces the stale instance, stalled run, and wedged schedule", async (context) => {
  stubFleet(context, {
    instances: [liveInstance, staleInstance],
    fleet: evaluateWorkerFleet({
      now,
      instances: [
        { status: "running", heartbeatAgeMs: 5_000 },
        { status: "stale", heartbeatAgeMs: 900_000 },
      ],
      stalledRuns: 1,
      wedgedSchedules: 1,
    }),
    stalledRuns: [stalledRun],
    schedules: [wedgedSchedule],
  });

  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /Workers are running with problems/);
  assert.match(text, /1 stale instance, 1 stalled run, 1 schedule needing attention/);
  assert.match(text, /Stalled import runs/);
  assert.match(text, /Past the window by/);
  assert.match(text, /worker:departed:1, which no longer has a presence record/);
  assert.match(text, /Claim expired/);
  assert.match(text, /outlived its expiry/);

  // Every problem row deep-links into the page that acts on it.
  const links = [...renderer.container.querySelectorAll("a")].map((anchor) =>
    anchor.getAttribute("href"),
  );
  assert.ok(links.includes(`/runs/${runId}`));
  assert.ok(links.includes(`/providers/${providerId}`));
});

test("a dead fleet states the silence duration as the headline fact", async (context) => {
  stubFleet(context, {
    instances: [staleInstance],
    fleet: evaluateWorkerFleet({
      now,
      instances: [{ status: "stale", heartbeatAgeMs: 900_000 }],
      stalledRuns: 2,
      wedgedSchedules: 0,
    }),
    stalledRuns: [stalledRun],
  });

  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /No worker is alive/);
  assert.match(text, /No worker has heartbeated for 15m 0s/);
  assert.match(text, /Scheduled imports, estimated-EV recomputation, and retention are not running/);
  assert.match(text, /Stale instances/);
  assert.doesNotMatch(text, /Workers are running/);
});

test("an empty presence table says nothing ever reported instead of inventing a duration", async (context) => {
  stubFleet(context, {
    instances: [],
    fleet: evaluateWorkerFleet({
      now,
      instances: [],
      stalledRuns: 0,
      wedgedSchedules: 0,
    }),
    settings: resolveWorkerFleetSettings([]),
  });

  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /No worker has ever reported/);
  assert.match(text, /aged past its retention window/);
  assert.match(text, /No worker instance has reported/);
  assert.doesNotMatch(text, /No worker has heartbeated for/);
  // With nothing published, no threshold is stated and none is invented.
  assert.match(text, /No instance has published its operating settings/);
  assert.match(text, /Stalled runs cannot be judged yet/);
});

test("losing pipeline access explains the boundary instead of showing stale evidence", async (context) => {
  stubFetch(context, () =>
    jsonResponse({ error: "Forbidden", code: "FORBIDDEN" }, 403),
  );
  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /Your role no longer permits worker fleet status access/);
  assert.match(text, /Your role no longer permits stalled run detection access/);
  assert.match(text, /Your role no longer permits schedule health access/);
  assert.match(text, /Your role no longer permits worker operating settings access/);
  assert.doesNotMatch(text, /worker:live:1/);
  assert.doesNotMatch(text, /Operating thresholds in force/);
});

test("live status refreshes on a bounded cadence rather than per second", async (context) => {
  const requests = stubFleet(context, {
    instances: [liveInstance],
    fleet: evaluateWorkerFleet({
      now,
      instances: [{ status: "running", heartbeatAgeMs: 5_000 }],
      stalledRuns: 0,
      wedgedSchedules: 0,
    }),
  });

  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  // One read per section on entry; the refresh interval is measured in tens of
  // seconds, so settling the page adds no further traffic.
  assert.equal(requests.length, 4);
  assert.match(pageText(renderer), /Status refreshes every 15s/);
  await settlePage();
  assert.equal(requests.length, 4);
});

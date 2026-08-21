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
import { act } from "react";
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

/**
 * Drives one bounded refresh without waiting out the live cadence, through the
 * same visibility path the page uses. A bare jsdom document reports
 * "prerender", so the tab is first made visible as a real one would be.
 */
async function refresh(renderer: Awaited<ReturnType<typeof renderPage>>) {
  const { document } = renderer.dom.window;
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  });
  await act(async () =>
    document.dispatchEvent(new renderer.dom.window.Event("visibilitychange")),
  );
  await settlePage();
}

/**
 * A restart is exactly when the effective settings can change, and a
 * deployment restarts the fleet. A page left open across one must not keep
 * measuring fresh worker evidence against thresholds no worker is running.
 */
test("effective settings are re-read when a restarted fleet publishes different ones", async (context) => {
  const restarted: WorkerEffectiveSettings = {
    ...settings,
    runHeartbeatStaleAfterMs: 900_000,
  };
  let published = resolution;
  let instance = liveInstance;
  const requests = stubFetch(context, (request) => {
    const target = path(request);
    if (target.startsWith("/api/worker-fleet/instances")) {
      return jsonResponse({
        instances: [instance],
        hasMore: false,
        fleet: evaluateWorkerFleet({
          now,
          instances: [{ status: "running", heartbeatAgeMs: 5_000 }],
          stalledRuns: 0,
          wedgedSchedules: 0,
        }),
        settings: published,
      });
    }
    if (target.startsWith("/api/worker-fleet/stalled-runs")) {
      return jsonResponse({
        items: [],
        nextCursor: null,
        staleAfterMs: published.settings?.runHeartbeatStaleAfterMs ?? null,
      });
    }
    if (target.startsWith("/api/worker-fleet/schedules")) {
      return jsonResponse({ items: [], nextCursor: null, overdueAfterMs: null });
    }
    return jsonResponse({ settings: published, observedAt: now });
  });

  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();
  assert.match(pageText(renderer), /Run heartbeat stale after/);
  assert.match(pageText(renderer), /5m 0s/);

  // The fleet restarts on a deployment and publishes a different threshold.
  published = resolveWorkerFleetSettings([restarted]);
  instance = { ...liveInstance, version: "1.5.0", effectiveSettings: restarted };
  await refresh(renderer);

  const text = pageText(renderer);
  assert.match(text, /Run heartbeat stale after 15m 0s/);
  // The superseded threshold is gone everywhere it was quoted, not just here.
  assert.doesNotMatch(text, /\b5m 0s/);
  assert.match(text, /beaten inside its 15m 0s window/);
  assert.match(text, /1\.5\.0/);
  // The settings section polls on the same cadence as the evidence above it.
  assert.equal(
    requests.filter((entry) => path(entry).startsWith("/api/worker-fleet/settings"))
      .length,
    2,
  );
});

/**
 * The hooks deliberately keep their last successful values, and the failure
 * copy promises that prior safe results remain visible. A fifteen-second
 * refresh hiccup must therefore report itself beside that evidence, not take
 * it away from the operator who is acting on it.
 */
test("a refresh failure is reported beside the evidence it could not refresh", async (context) => {
  let failing = false;
  stubFetch(context, (request) => {
    if (failing) {
      return jsonResponse(
        { error: "The admin service is unavailable.", code: "UNAVAILABLE" },
        503,
      );
    }
    const target = path(request);
    if (target.startsWith("/api/worker-fleet/instances")) {
      return jsonResponse({
        instances: [liveInstance],
        hasMore: false,
        fleet: evaluateWorkerFleet({
          now,
          instances: [{ status: "running", heartbeatAgeMs: 5_000 }],
          stalledRuns: 1,
          wedgedSchedules: 1,
        }),
        settings: resolution,
      });
    }
    if (target.startsWith("/api/worker-fleet/stalled-runs")) {
      return jsonResponse({
        items: [stalledRun],
        nextCursor: null,
        staleAfterMs: settings.runHeartbeatStaleAfterMs,
      });
    }
    if (target.startsWith("/api/worker-fleet/schedules")) {
      return jsonResponse({
        items: [wedgedSchedule],
        nextCursor: null,
        overdueAfterMs: settings.presenceStaleAfterMs,
      });
    }
    return jsonResponse({ settings: resolution, observedAt: now });
  });

  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();
  assert.match(pageText(renderer), /worker:live:1/);

  failing = true;
  await refresh(renderer);

  const text = pageText(renderer);
  // The failure is stated, once per section, and it is stated truthfully.
  assert.match(text, /worker fleet status is temporarily unavailable/);
  assert.match(text, /Prior safe results remain visible/);
  // And the evidence it could not refresh is exactly where it was.
  assert.match(text, /Workers are running/);
  assert.match(text, /worker:live:1/);
  assert.match(text, /Stalled import runs/);
  assert.match(text, /Claim expired/);
  assert.match(text, /Operating thresholds in force/);
  assert.match(text, /Run heartbeat stale after/);
  assert.ok(renderer.container.querySelector('[role="alert"]'));
  // Retrying is still offered for every section that failed.
  assert.equal(
    [...renderer.container.querySelectorAll("button")].filter(
      (button) => button.textContent?.trim() === "Try again",
    ).length,
    4,
  );
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

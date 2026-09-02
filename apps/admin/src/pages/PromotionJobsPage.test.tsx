import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  PromotionJobHistoryPage,
  PromotionJobInvocationMonitoring,
  PromotionJobMonitoringOverview,
} from "@packscout/contracts";
import * as React from "react";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import {
  changeControl,
  cleanupPage,
  deferred,
  findButton,
  jsonResponse,
  pageText,
  renderPage,
  settlePage,
  stubFetch,
} from "../testing/react-page-test.tsx";
import { PromotionJobsPage } from "./PromotionJobsPage.tsx";

Object.assign(globalThis, { React });

const observedAt = "2026-09-01T12:00:00.000Z";
const digest = "a".repeat(64);

function invocation(
  monitoringId: string,
  job: PromotionJobInvocationMonitoring["job"],
  failureCode: string | null = null,
): PromotionJobInvocationMonitoring {
  return {
    monitoringId,
    job,
    trigger: "change_wake",
    state: "terminal",
    outcome: failureCode ? "failed" : "caught_up",
    requestedAt: observedAt,
    startedAt: observedAt,
    finishedAt: observedAt,
    durationMs: 350,
    cycleCount: 1,
    attemptCount: 1,
    retryCount: failureCode ? 1 : 0,
    failureCode,
    continuationPending: false,
  };
}

const alphaInvocation = invocation(
  "pj_6HY8d6A1RXq4A1l68cnXPgEVxk0Z_r6g",
  "provider:alpha",
);

function overviewFixture(): PromotionJobMonitoringOverview {
  return {
    observedAt,
    roster: {
      observedAt,
      version: "4",
      highWater: "18",
      digest,
      providerCount: 3,
      eligibleProviderCount: 3,
    },
    evaluator: {
      state: "stale",
      observedAt,
      evaluatedThrough: "2026-09-01T11:58:00.000Z",
      rosterVersion: "3",
      rosterHighWater: "17",
      rosterDigest: "b".repeat(64),
      expectedCount: 4,
      reachableCount: 3,
      unavailableCount: 1,
      manifestEvaluated: true,
      failureCode: null,
    },
    manifest: {
      evidenceSource: "live",
      observedAt,
      stale: false,
      schedule: {
        lifecycle: "active",
        health: "healthy",
        scheduleEpoch: "7",
        missedWindowCount: "0",
        lastScheduledCheckinAt: observedAt,
        nextExpectedCheckinAt: "2026-09-01T12:01:00.000Z",
      },
      wake: {
        pending: true,
        requestedGeneration: "9",
        acknowledgedGeneration: "8",
        latestCause: "provider_release_completed",
        latestRequestedAt: observedAt,
        deliveryState: "pending",
        lastDeliveryAttemptAt: null,
        failureCode: null,
      },
      activeManifest: {
        publicManifestId: "manifest-18",
        fingerprint: digest,
        generation: "18",
        activatedAt: observedAt,
      },
      previousManifest: null,
      gateQueueDepth: 1,
      oldestGateAgeMs: 12_000,
      serializedOperation: {
        operation: "advance",
        providerKey: "alpha",
        state: "sent",
        attemptCount: 1,
        failureCode: null,
      },
      lastActivationAt: observedAt,
      lastReconciliationAt: observedAt,
      latestInvocation: invocation(
        "pj_7HY8d6A1RXq4A1l68cnXPgEVxk0Z_r6g",
        "manifest",
      ),
    },
    providers: [
      {
        providerKey: "alpha",
        displayName: "Alpha Cards",
        lifecycle: "active",
        evidenceSource: "live",
        observedAt,
        stale: false,
        routeFailureCode: null,
        state: "awaiting_activation",
        schedule: {
          lifecycle: "active",
          health: "healthy",
          scheduleEpoch: "4",
          missedWindowCount: "0",
          lastScheduledCheckinAt: observedAt,
          nextExpectedCheckinAt: "2026-09-01T12:01:00.000Z",
        },
        wake: null,
        settledPosition: "91",
        completedRelease: {
          publicReleaseId: "alpha-91",
          fingerprint: digest,
          position: "91",
        },
        activeRelease: {
          publicReleaseId: "alpha-90",
          fingerprint: digest,
          position: "90",
        },
        pendingGate: {
          operation: "advance",
          state: "running",
          requestedGeneration: "2",
          acknowledgedGeneration: "1",
          requestedAt: observedAt,
          attemptCount: 1,
          retryAt: null,
          failureCode: null,
        },
        latestInvocation: alphaInvocation,
        projectionLagMs: 250,
      },
      {
        providerKey: "beta",
        displayName: "Beta Breaks",
        lifecycle: "archived",
        evidenceSource: "last_known",
        observedAt: "2026-09-01T11:45:00.000Z",
        stale: true,
        routeFailureCode: "PROVIDER_UNREACHABLE",
        state: "last_known",
        schedule: null,
        wake: null,
        settledPosition: "44",
        completedRelease: null,
        activeRelease: null,
        pendingGate: null,
        latestInvocation: null,
        projectionLagMs: null,
      },
      {
        providerKey: "gamma",
        displayName: "Gamma Market",
        lifecycle: "disabled",
        evidenceSource: "live",
        observedAt,
        stale: false,
        routeFailureCode: null,
        state: "inactive",
        schedule: null,
        wake: null,
        settledPosition: "12",
        completedRelease: null,
        activeRelease: {
          publicReleaseId: "gamma-12",
          fingerprint: digest,
          position: "12",
        },
        pendingGate: null,
        latestInvocation: null,
        projectionLagMs: 0,
      },
    ],
  };
}

function historyFixture(
  item = alphaInvocation,
  nextCursor: string | null = null,
): PromotionJobHistoryPage {
  return { items: [item], nextCursor, rosterDigest: digest };
}

function route(initial = "/promotion-jobs") {
  return <MemoryRouter initialEntries={[initial]}><PromotionJobsPage /></MemoryRouter>;
}

function requestPath(input: RequestInfo | URL): string {
  return String(input);
}

function assertLabelledByReferencesResolve(container: HTMLElement): void {
  for (const element of container.querySelectorAll<HTMLElement>("[aria-labelledby]")) {
    const references = element.getAttribute("aria-labelledby")?.split(/\s+/u) ?? [];
    assert.ok(references.length > 0, "aria-labelledby must contain a reference");
    for (const reference of references) {
      assert.ok(
        container.ownerDocument.getElementById(reference),
        `aria-labelledby reference ${reference} must resolve`,
      );
    }
  }
}

function assertSemanticTable(table: HTMLTableElement): void {
  assert.ok(table.caption?.textContent?.trim(), "data tables need an accessible caption");
  assert.equal(
    table.querySelectorAll('thead th:not([scope="col"])').length,
    0,
    "every column header declares column scope",
  );
  assert.equal(
    table.querySelectorAll('tbody th:not([scope="row"])').length,
    0,
    "every row header declares row scope",
  );
}

test("renders central activation and each independent provider exactly once without mutation controls", async (context) => {
  stubFetch(context, ({ input }) => requestPath(input).includes("/overview")
    ? jsonResponse(overviewFixture())
    : jsonResponse(historyFixture()));
  const rendered = await renderPage(route());
  cleanupPage(context, rendered);
  await settlePage();

  const text = pageText(rendered);
  assert.match(text, /Manifest activation/);
  assert.match(text, /Provider roster changed; liveness is last-known/);
  assert.match(text, /Publication completed; central activation is still pending/);
  assert.match(text, /Archived provider with retained last-known evidence/);
  assert.match(text, /Disabled, but its last release is still active/);
  assert.equal(rendered.container.querySelectorAll(".promotion-provider-table tbody tr").length, 3);
  assert.equal(rendered.container.querySelectorAll('a[href="/data/published?provider=alpha"]').length, 1);
  assert.equal(rendered.container.querySelectorAll("h1").length, 1);
  assertLabelledByReferencesResolve(rendered.container);
  const landmarkLabels = [...rendered.container.querySelectorAll("aside")]
    .map((landmark) => landmark.getAttribute("aria-labelledby"));
  assert.deepEqual(landmarkLabels, [
    "promotion-readonly-title",
    "promotion-evaluator-title",
  ]);
  assert.equal(new Set(landmarkLabels).size, landmarkLabels.length);
  for (const table of rendered.container.querySelectorAll("table")) {
    assertSemanticTable(table);
  }
  const tableRegions = [...rendered.container.querySelectorAll<HTMLElement>('.promotion-table-region[role="region"]')];
  assert.equal(tableRegions.length, 2);
  assert.ok(tableRegions.every((region) => region.tabIndex === 0));
  assert.ok(tableRegions.every((region) => Boolean(region.getAttribute("aria-label")?.trim())));
  assert.equal(
    rendered.container.querySelector('a[aria-label="Latest central job: Caught up"]')?.textContent,
    "Caught up",
  );
  assert.equal(
    rendered.container.querySelector('a[aria-label="Latest job for Alpha Cards: Caught up"]')?.textContent,
    "Caught up",
  );
  for (const id of ["promotion-filter", "promotion-trigger", "promotion-outcome"]) {
    assert.ok(rendered.container.querySelector(`label[for="${id}"]`));
  }
  for (const forbidden of ["Run job", "Retry job", "Cancel", "Pause", "Rollback", "Activate"]) {
    assert.doesNotMatch(text, new RegExp(`\\b${forbidden}\\b`, "u"));
  }
  assert.doesNotMatch(rendered.container.innerHTML, /databaseUrl|organizationId|credential|claimToken/u);
});

test("announces both loading regions without hiding the page heading", async (context) => {
  const overviewLoad = deferred<Response>();
  const historyLoad = deferred<Response>();
  stubFetch(context, ({ input }) => requestPath(input).includes("/overview")
    ? overviewLoad.promise
    : historyLoad.promise);
  const rendered = await renderPage(route());
  cleanupPage(context, rendered);

  assert.equal(rendered.container.querySelectorAll("h1").length, 1);
  const loadingRegions = [...rendered.container.querySelectorAll<HTMLElement>(
    '[role="status"][aria-live="polite"][aria-atomic="true"][aria-busy="true"]',
  )];
  assert.deepEqual(
    loadingRegions.map((region) => region.textContent?.trim()),
    ["Loading current promotion status…", "Loading promotion job history…"],
  );

  overviewLoad.resolve(jsonResponse(overviewFixture()));
  historyLoad.resolve(jsonResponse(historyFixture()));
  await settlePage();
});

test("gives simultaneous overview and history failures distinct retry names", async (context) => {
  stubFetch(context, () => jsonResponse(
    { error: "Unavailable", code: "SERVICE_UNAVAILABLE" },
    503,
  ));
  const rendered = await renderPage(route());
  cleanupPage(context, rendered);
  await settlePage();

  assert.equal(rendered.container.querySelectorAll('[role="alert"]').length, 2);
  const retryNames = [...rendered.container.querySelectorAll<HTMLButtonElement>('[role="alert"] button')]
    .map((button) => button.textContent?.trim());
  assert.deepEqual(retryNames, [
    "Retry current promotion status",
    "Retry promotion job history",
  ]);
  assert.equal(new Set(retryNames).size, retryNames.length);
});

test("invalid shared URL filters stay visible and never broaden into a history read", async (context) => {
  const requests = stubFetch(context, () => jsonResponse(overviewFixture()));
  const rendered = await renderPage(route("/promotion-jobs?filter=all"));
  cleanupPage(context, rendered);
  await settlePage();

  const text = pageText(rendered);
  assert.match(text, /Invalid: all/);
  assert.match(text, /These URL filters are invalid/);
  assert.match(text, /No broader history query was sent/);
  assert.equal(
    requests.filter(({ input }) => requestPath(input).includes("/history")).length,
    0,
  );
});

test("a slower superseded filter response cannot replace the current scope", async (context) => {
  const oldHistory = deferred<Response>();
  const newHistory = deferred<Response>();
  stubFetch(context, ({ input }) => {
    const target = new URL(requestPath(input), "https://admin.packscout.test");
    if (target.pathname.endsWith("/overview")) return jsonResponse(overviewFixture());
    return target.searchParams.get("filter") === "manifest"
      ? newHistory.promise
      : oldHistory.promise;
  });
  const rendered = await renderPage(route());
  cleanupPage(context, rendered);
  await settlePage();

  await act(async () => changeControl(rendered, "promotion-filter", "manifest"));
  newHistory.resolve(jsonResponse(historyFixture(invocation(
    "pj_8HY8d6A1RXq4A1l68cnXPgEVxk0Z_r6g",
    "manifest",
    "NEW_SCOPE_FAILURE",
  ))));
  await settlePage();
  assert.match(pageText(rendered), /NEW_SCOPE_FAILURE/);

  oldHistory.resolve(jsonResponse(historyFixture(invocation(
    "pj_9HY8d6A1RXq4A1l68cnXPgEVxk0Z_r6g",
    "provider:alpha",
    "OLD_SCOPE_FAILURE",
  ))));
  await settlePage();
  assert.match(pageText(rendered), /NEW_SCOPE_FAILURE/);
  assert.doesNotMatch(pageText(rendered), /OLD_SCOPE_FAILURE/);
});

test("refresh failures retain only the exact same scope and announce stale evidence", async (context) => {
  let fail = false;
  stubFetch(context, ({ input }) => {
    if (fail) return jsonResponse({ error: "Unavailable", code: "SERVICE_UNAVAILABLE" }, 503);
    return requestPath(input).includes("/overview")
      ? jsonResponse(overviewFixture())
      : jsonResponse(historyFixture(invocation(
          "pj_AHY8d6A1RXq4A1l68cnXPgEVxk0Z_r6g",
          "provider:alpha",
          "EXACT_SCOPE_MARKER",
        )));
  });
  const rendered = await renderPage(route());
  cleanupPage(context, rendered);
  await settlePage();
  assert.match(pageText(rendered), /EXACT_SCOPE_MARKER/);

  fail = true;
  await act(async () => findButton(rendered, "Refresh status").click());
  await settlePage();
  assert.match(pageText(rendered), /Last safe evidence for this exact view remains below and is marked stale/);
  assert.match(pageText(rendered), /EXACT_SCOPE_MARKER/);

  await act(async () => changeControl(rendered, "promotion-filter", "manifest"));
  await settlePage();
  await settlePage();
  assert.doesNotMatch(pageText(rendered), /EXACT_SCOPE_MARKER/);
  assert.match(pageText(rendered), /promotion history is temporarily unavailable/);
});

test("hidden tabs do not refresh and a 429 pauses automatic cadence until manual retry", async (context) => {
  const requests = stubFetch(context, () => jsonResponse(
    { error: "Too many monitoring requests", code: "RATE_LIMITED" },
    429,
  ));
  const rendered = await renderPage(<p>Preparing</p>);
  cleanupPage(context, rendered);
  let visibility: DocumentVisibilityState = "visible";
  Object.defineProperty(rendered.dom.window.document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  await act(async () => rendered.root.render(route()));
  await settlePage();
  assert.equal(requests.length, 2);
  assert.match(pageText(rendered), /paused for one minute/);

  await act(async () => document.dispatchEvent(new rendered.dom.window.Event("visibilitychange")));
  await settlePage();
  assert.equal(requests.length, 2, "rate-limited live reads do not poll again immediately");

  visibility = "hidden";
  await act(async () => document.dispatchEvent(new rendered.dom.window.Event("visibilitychange")));
  await settlePage();
  assert.equal(requests.length, 2, "hidden tabs do not poll");

  visibility = "visible";
  await act(async () => findButton(rendered, "Refresh status").click());
  await settlePage();
  assert.equal(requests.length, 4, "manual refresh explicitly retries both independent sections");
});

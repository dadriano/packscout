import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { act } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { AuthSessionResponse, ProviderSourceDiagnosticHistory } from "@packscout/contracts";
import { SessionProvider } from "../providers/session.tsx";
import { ToastProvider } from "../providers/toast.tsx";
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
import {
  diagnosticHistory,
  operationsDetail,
  operationsFixtureIds,
  operationsOverview,
  operationsSession,
} from "../testing/provider-source-operations-fixture.ts";
import { OperationsPage } from "./OperationsPage.tsx";
import { ProviderDetailPage } from "./ProviderDetailPage.tsx";
import { ProvidersPage } from "./ProvidersPage.tsx";

Object.assign(globalThis, { React });

function shell(element: React.ReactElement, session: AuthSessionResponse) {
  return (
    <ToastProvider>
      <SessionProvider initialSession={session}>
        <MemoryRouter>{element}</MemoryRouter>
      </SessionProvider>
    </ToastProvider>
  );
}

test("adapter-pinned request sizes are visible without an inapplicable save control", async (context) => {
  const detail = operationsDetail();
  detail.source.source!.requestSizePolicy = "adapter_profile";
  detail.source.source!.recordsPerRequest = 2_000;
  const requests = stubFetch(context, ({ input }) => {
    if (String(input).includes("/diagnostics")) {
      return jsonResponse({ ...diagnosticHistory(), snapshot: detail.source });
    }
    return jsonResponse(detail);
  });
  const rendered = await renderPage(
    <ToastProvider><SessionProvider initialSession={operationsSession()}>
      <MemoryRouter initialEntries={[`/providers/${detail.source.providerId}`]}>
        <Routes><Route path="/providers/:providerId" element={<ProviderDetailPage />} /></Routes>
      </MemoryRouter>
    </SessionProvider></ToastProvider>,
  );
  cleanupPage(context, rendered);
  await settlePage();
  assert.match(pageText(rendered), /No configurable request setting is initialized.*verified adapter default is 2,000 records/u);
  assert.equal(rendered.container.querySelector("#provider-source-records-per-request"), null);
  assert.ok(![...rendered.container.querySelectorAll("button")].some((button) =>
    button.textContent?.includes("Save request size")));
  assert.ok(requests.every(({ init }) => !init?.method || init.method === "GET"));
});

test("operations overview renders four server rows and returns exact Run, Pause, and Resume outcomes", async (context) => {
  const overview = operationsOverview();
  const requests = stubFetch(context, ({ input }) => {
    const path = String(input);
    if (path === "/api/provider-source-operations") return jsonResponse(overview);
    if (path.endsWith("/import-runs")) {
      return jsonResponse({
        run: {
          id: operationsFixtureIds.runs[0],
          providerId: operationsFixtureIds.providers[0],
          configurationRevisionId: operationsFixtureIds.revisions[0],
          trigger: "manual",
          state: "queued",
        },
        deduplicated: false,
        outcome: "queued",
      }, 202);
    }
    if (path.endsWith("/pause")) {
      return jsonResponse({ state: "pause_requested", audit: { outcome: "succeeded" } });
    }
    if (path.endsWith("/resume")) {
      return jsonResponse({ state: "resumed", audit: { outcome: "succeeded" } });
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  const renderer = await renderPage(shell(<OperationsPage />, operationsSession()));
  cleanupPage(context, renderer);
  await settlePage();

  assert.equal(renderer.container.querySelectorAll(".provider-pulse__card").length, 4);
  assert.match(pageText(renderer), /Pipeline status/);
  assert.match(pageText(renderer), /Waiting for capacity/);
  assert.match(pageText(renderer), /Action required/);
  assert.match(pageText(renderer), /Source total unknown/);
  assert.equal(findButton(renderer, "Resolve before run").disabled, true);
  assert.match(pageText(renderer), /Disable this source.*Test source.*Activate paused.*Resume/iu);
  assert.doesNotMatch(pageText(renderer), /Retry source/iu);
  const runCard = renderer.container.querySelector(`[data-provider-id="${operationsFixtureIds.providers[0]}"]`)!;
  const runButton = [...runCard.querySelectorAll("button")].find((button) => button.textContent === "Run now")!;
  const pauseButton = [...runCard.querySelectorAll("button")].find((button) => button.textContent === "Pause")!;

  await act(async () => {
    runButton.click();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  await settlePage();
  assert.match(pageText(renderer), /manual run created and queued/iu);
  assert.ok(renderer.container.querySelector(`a[href="/runs/${operationsFixtureIds.runs[0]}?providerId=${operationsFixtureIds.providers[0]}"]`));

  await act(async () => {
    pauseButton.click();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  await settlePage();
  assert.match(pageText(renderer), /pause requested; the current page may commit/iu);

  await act(async () => {
    findButton(renderer, "Resume").click();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  await settlePage();
  assert.match(pageText(renderer), /resumed from the committed cursor/iu);

  const runRequest = requests.find(({ input }) => String(input).endsWith("/import-runs"));
  assert.deepEqual(JSON.parse(String(runRequest?.init?.body)), {
    expectedSourceRevisionId: operationsFixtureIds.revisions[0],
  });
  const pauseRequest = requests.find(({ input }) => String(input).endsWith("/pause"));
  assert.deepEqual(JSON.parse(String(pauseRequest?.init?.body)), {
    expectedSourceRevisionId: operationsFixtureIds.revisions[0],
  });
  const resumeRequest = requests.find(({ input }) => String(input).endsWith("/resume"));
  assert.deepEqual(JSON.parse(String(resumeRequest?.init?.body)), {
    expectedSourceRevisionId: operationsFixtureIds.revisions[2],
  });

  await act(async () => findButton(renderer, "Pause display").click());
  assert.match(pageText(renderer), /Snapshot paused · ingestion continues/iu);
  assert.match(pageText(renderer), /Display paused/);
});

test("provider admin lists canonical provider-source lanes without the legacy provider read model", async (context) => {
  const requests = stubFetch(context, ({ input }) => {
    const path = String(input);
    if (path === "/api/provider-source-operations") {
      return jsonResponse(operationsOverview());
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  const renderer = await renderPage(shell(<ProvidersPage />, operationsSession()));
  cleanupPage(context, renderer);
  await settlePage();

  assert.match(pageText(renderer), /Data providers/);
  assert.match(pageText(renderer), /Collector Crypt/);
  assert.match(pageText(renderer), /Courtyard/);
  assert.match(pageText(renderer), /Phygitals/);
  assert.match(pageText(renderer), /ClutchPacks/);
  assert.equal(renderer.container.querySelectorAll(".source-lane").length, 4);
  assert.deepEqual(requests.map(({ input }) => String(input)), [
    "/api/provider-source-operations",
  ]);
});

test("provider detail preserves safe state through refresh and action failures while filtering bounded history", async (context) => {
  const detail = operationsDetail();
  let servedDetail = detail;
  let diagnosticsFail = false;
  let intervalFails = false;
  let intervalBody: unknown = null;
  let recordsPerRequestBody: unknown = null;
  let recordsPerRequestFails = false;
  let heldDetailResponse: Promise<Response> | null = null;
  const requests = stubFetch(context, ({ input, init }) => {
    const path = String(input);
    if (path.includes("/diagnostics")) {
      if (diagnosticsFail) {
        return jsonResponse({ error: "Unavailable", code: "SOURCE_OPERATIONS_UNAVAILABLE" }, 503);
      }
      const url = new URL(path, "https://admin.packscout.test");
      if (url.searchParams.has("cursor")) {
        const expired: ProviderSourceDiagnosticHistory = {
          ...diagnosticHistory(),
          events: [],
          nextCursor: null,
          history: {
            state: "expired",
            message: "Older diagnostic history has expired. Current source state is shown above.",
          },
        };
        return jsonResponse(expired);
      }
      const runId = url.searchParams.get("runId");
      return jsonResponse(diagnosticHistory(0, {
        severity: url.searchParams.get("severity") as "info" | "warning" | "critical" | null,
        phase: url.searchParams.get("phase"),
        runId,
        contextEventsHidden: runId !== null,
      }));
    }
    if (path === `/api/provider-source-operations/providers/${operationsFixtureIds.providers[0]}`) {
      if (heldDetailResponse) {
        const response = heldDetailResponse;
        heldDetailResponse = null;
        return response;
      }
      return jsonResponse(servedDetail);
    }
    if (path.endsWith("/interval")) {
      intervalBody = JSON.parse(String(init?.body));
      if (intervalFails) {
        return jsonResponse({ error: "Conflict", code: "SOURCE_CONFLICT" }, 409);
      }
      return jsonResponse({ scheduleRevisionId: operationsFixtureIds.schedules[0], audit: { outcome: "succeeded" } });
    }
    if (path.endsWith("/records-per-request")) {
      recordsPerRequestBody = JSON.parse(String(init?.body));
      if (recordsPerRequestFails) {
        return jsonResponse({ error: "Conflict", code: "SOURCE_CONFLICT" }, 409);
      }
      return jsonResponse({
        scheduleRevisionId: operationsFixtureIds.schedules[2],
        audit: { outcome: "success" },
      });
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  const routed = await renderPage(
    <ToastProvider>
      <SessionProvider initialSession={operationsSession()}>
        <MemoryRouter initialEntries={[`/providers/${operationsFixtureIds.providers[0]}`]}>
          <Routes><Route path="/providers/:providerId" element={<ProviderDetailPage />} /></Routes>
        </MemoryRouter>
      </SessionProvider>
    </ToastProvider>,
  );
  cleanupPage(context, routed);
  await settlePage();

  assert.match(pageText(routed), /Source contract/);
  assert.match(pageText(routed), /packscout\.provider-observation\.v1/);
  assert.match(pageText(routed), /Safe fingerprint/);
  assert.match(pageText(routed), /Page committed/);
  assert.match(pageText(routed), /Shared connection/);
  const runLinks = [...routed.container.querySelectorAll<HTMLAnchorElement>('a[href^="/runs/"]')];
  assert.ok(runLinks.length >= 3, "active, history, and committed-page run links remain available");
  assert.ok(runLinks.every((link) => new URL(link.href).searchParams.get("providerId") === detail.source.providerId));
  assert.match(pageText(routed), /Current run: 500\. Next run: 1,000\./u);
  assert.match(
    pageText(routed),
    /Smaller values use less memory\. Larger values can finish backfills faster\. The source may return fewer\./u,
  );

  assert.equal(
    [...routed.container.querySelectorAll("button")]
      .some((button) => button.textContent?.trim() === "Test source"),
    false,
  );

  await act(async () => findButton(routed, "Pause display").click());
  diagnosticsFail = true;
  await act(async () => {
    findButton(routed, "Resume display").click();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  await settlePage();
  assert.match(pageText(routed), /Recent diagnostics are temporarily unavailable/);
  assert.match(pageText(routed), /Page committed/);
  assert.match(pageText(routed), /Previously loaded safe diagnostics remain visible/iu);
  diagnosticsFail = false;
  await act(async () => {
    findButton(routed, "Retry diagnostics").click();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  await settlePage();

  const severity = routed.container.querySelector<HTMLSelectElement>("#diagnostic-severity");
  assert.ok(severity);
  severity.focus();
  await act(async () => {
    changeControl(routed, "diagnostic-severity", "critical");
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  await settlePage();
  assert.equal(routed.dom.window.document.activeElement?.id, "diagnostic-severity");
  assert.ok(requests.some(({ input }) => String(input).includes("severity=critical")));

  await act(async () => {
    changeControl(routed, "diagnostic-run", operationsFixtureIds.runs[0]);
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  await settlePage();
  assert.match(pageText(routed), /only matching run and page events/iu);
  assert.doesNotMatch(pageText(routed), /Shared connection Connection episode/);

  await act(async () => {
    findButton(routed, "Load older events").click();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  await settlePage();
  assert.match(pageText(routed), /History gap/);
  assert.match(pageText(routed), /Older diagnostic history has expired/);

  await act(async () => {
    changeControl(routed, "provider-source-interval", "600");
    const form = findButton(routed, "Save timing").closest("form");
    assert.ok(form);
    form.dispatchEvent(new routed.dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  await settlePage();
  assert.deepEqual(intervalBody, {
    expectedSourceRevisionId: operationsFixtureIds.revisions[0],
    expectedScheduleRevisionId: operationsFixtureIds.schedules[0],
    intervalSeconds: 600,
  });
  assert.match(pageText(routed), /interval changed to 10m/iu);

  intervalFails = true;
  await act(async () => {
    changeControl(routed, "provider-source-interval", "777");
    const form = findButton(routed, "Save timing").closest("form");
    assert.ok(form);
    form.dispatchEvent(new routed.dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  await settlePage();
  assert.match(pageText(routed), /changed in another session/iu);
  assert.equal(routed.container.querySelector<HTMLInputElement>("#provider-source-interval")?.value, "777");
  assert.match(pageText(routed), /Source contract/);

  await act(async () => {
    changeControl(routed, "provider-source-records-per-request", "5001");
    const input = routed.container.querySelector<HTMLInputElement>(
      "#provider-source-records-per-request",
    );
    assert.ok(input);
    input.dispatchEvent(new routed.dom.window.Event("invalid", {
      cancelable: true,
    }));
    const form = findButton(routed, "Save request size").closest("form");
    assert.ok(form);
    form.dispatchEvent(new routed.dom.window.Event("submit", {
      bubbles: true,
      cancelable: true,
    }));
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  assert.equal(recordsPerRequestBody, null);
  assert.match(pageText(routed), /Enter a whole number from 1 to 5,000\./u);
  assert.equal(
    routed.container.querySelector<HTMLInputElement>(
      "#provider-source-records-per-request",
    )?.getAttribute("aria-invalid"),
    "true",
  );

  await act(async () => {
    changeControl(routed, "provider-source-records-per-request", "1250");
  });
  servedDetail = {
    ...detail,
    source: {
      ...detail.source,
      source: {
        ...detail.source.source!,
        recordsPerRequest: 2_000,
      },
      schedule: {
        ...detail.source.schedule!,
        scheduleRevisionId: operationsFixtureIds.schedules[1],
      },
    },
  };
  await act(async () => findButton(routed, "Pause display").click());
  await act(async () => {
    findButton(routed, "Resume display").click();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  await settlePage();
  assert.equal(
    routed.container.querySelector<HTMLInputElement>(
      "#provider-source-records-per-request",
    )?.value,
    "1250",
  );

  recordsPerRequestFails = true;
  await act(async () => {
    const form = findButton(routed, "Save request size").closest("form");
    assert.ok(form);
    form.dispatchEvent(new routed.dom.window.Event("submit", {
      bubbles: true,
      cancelable: true,
    }));
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  await settlePage();
  assert.deepEqual(recordsPerRequestBody, {
    expectedSourceRevisionId: operationsFixtureIds.revisions[0],
    expectedScheduleRevisionId: operationsFixtureIds.schedules[0],
    recordsPerRequest: 1_250,
  });
  assert.match(pageText(routed), /changed in another session/iu);
  assert.equal(
    routed.container.querySelector<HTMLInputElement>(
      "#provider-source-records-per-request",
    )?.value,
    "1250",
  );

  const heldReload = deferred<Response>();
  heldDetailResponse = heldReload.promise;
  await act(async () => {
    findButton(routed, "Reload current value").click();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  assert.equal(
    routed.container.querySelector<HTMLInputElement>(
      "#provider-source-records-per-request",
    )?.disabled,
    true,
  );
  assert.equal(findButton(routed, "Reloading…").disabled, true);
  await act(async () => {
    heldReload.resolve(jsonResponse(servedDetail));
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  await settlePage();
  assert.equal(
    routed.container.querySelector<HTMLInputElement>(
      "#provider-source-records-per-request",
    )?.value,
    "2000",
  );

  recordsPerRequestFails = false;
  await act(async () => {
    changeControl(routed, "provider-source-records-per-request", "1250");
    const form = findButton(routed, "Save request size").closest("form");
    assert.ok(form);
    form.dispatchEvent(new routed.dom.window.Event("submit", {
      bubbles: true,
      cancelable: true,
    }));
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  await settlePage();
  assert.deepEqual(recordsPerRequestBody, {
    expectedSourceRevisionId: operationsFixtureIds.revisions[0],
    expectedScheduleRevisionId: operationsFixtureIds.schedules[1],
    recordsPerRequest: 1_250,
  });
  assert.match(pageText(routed), /Saved\. Applies to the next import run\./u);
});

test("provider detail ignores a pre-save detail response after the request size revision is saved", async (context) => {
  const initialDetail = operationsDetail();
  const staleDetailResponse = deferred<Response>();
  const postSaveDetailResponse = deferred<Response>();
  const firstSaveResponse = deferred<Response>();
  const recordsPerRequestBodies: unknown[] = [];
  let detailRequestCount = 0;

  stubFetch(context, ({ input, init }) => {
    const path = String(input);
    if (path.includes("/diagnostics")) {
      return jsonResponse(diagnosticHistory());
    }
    if (path === `/api/provider-source-operations/providers/${operationsFixtureIds.providers[0]}`) {
      detailRequestCount += 1;
      if (detailRequestCount === 1) return jsonResponse(initialDetail);
      if (detailRequestCount === 2) return staleDetailResponse.promise;
      if (detailRequestCount === 3) return postSaveDetailResponse.promise;
      return jsonResponse(initialDetail);
    }
    if (path.endsWith("/records-per-request")) {
      recordsPerRequestBodies.push(JSON.parse(String(init?.body)));
      if (recordsPerRequestBodies.length === 1) return firstSaveResponse.promise;
      return jsonResponse({
        scheduleRevisionId: operationsFixtureIds.schedules[3],
        audit: { outcome: "success" },
      });
    }
    throw new Error(`Unexpected request: ${path}`);
  });

  const routed = await renderPage(
    <ToastProvider>
      <SessionProvider initialSession={operationsSession()}>
        <MemoryRouter initialEntries={[`/providers/${operationsFixtureIds.providers[0]}`]}>
          <Routes><Route path="/providers/:providerId" element={<ProviderDetailPage />} /></Routes>
        </MemoryRouter>
      </SessionProvider>
    </ToastProvider>,
  );
  cleanupPage(context, routed);
  await settlePage();

  await act(async () => findButton(routed, "Pause display").click());
  await act(async () => {
    findButton(routed, "Resume display").click();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  assert.equal(detailRequestCount, 2);

  await act(async () => {
    changeControl(routed, "provider-source-records-per-request", "1250");
    const form = findButton(routed, "Save request size").closest("form");
    assert.ok(form);
    form.dispatchEvent(new routed.dom.window.Event("submit", {
      bubbles: true,
      cancelable: true,
    }));
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  assert.equal(recordsPerRequestBodies.length, 1);

  await act(async () => {
    firstSaveResponse.resolve(jsonResponse({
      scheduleRevisionId: operationsFixtureIds.schedules[2],
      audit: { outcome: "success" },
    }));
    staleDetailResponse.resolve(jsonResponse(initialDetail));
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  assert.match(pageText(routed), /Saved\. Applies to the next import run\./u);
  assert.equal(detailRequestCount, 3);
  assert.equal(
    routed.container.querySelector<HTMLInputElement>(
      "#provider-source-records-per-request",
    )?.value,
    "1250",
  );

  await act(async () => {
    const form = findButton(routed, "Save request size").closest("form");
    assert.ok(form);
    form.dispatchEvent(new routed.dom.window.Event("submit", {
      bubbles: true,
      cancelable: true,
    }));
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  await settlePage();

  assert.deepEqual(recordsPerRequestBodies[1], {
    expectedSourceRevisionId: operationsFixtureIds.revisions[0],
    expectedScheduleRevisionId: operationsFixtureIds.schedules[2],
    recordsPerRequest: 1_250,
  });
});

test("paused action-required provider detail blocks false retries and names the tested lifecycle recovery", async (context) => {
  const baseDetail = operationsDetail(3);
  const detail = {
    ...baseDetail,
    source: {
      ...baseDetail.source,
      source: {
        ...baseDetail.source.source!,
        lifecycle: "paused" as const,
      },
    },
  };
  stubFetch(context, ({ input }) => {
    const path = String(input);
    if (path.includes("/diagnostics")) return jsonResponse(diagnosticHistory(3));
    if (path === `/api/provider-source-operations/providers/${operationsFixtureIds.providers[3]}`) {
      return jsonResponse(detail);
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  const routed = await renderPage(
    <ToastProvider>
      <SessionProvider initialSession={operationsSession()}>
        <MemoryRouter initialEntries={[`/providers/${operationsFixtureIds.providers[3]}`]}>
          <Routes><Route path="/providers/:providerId" element={<ProviderDetailPage />} /></Routes>
        </MemoryRouter>
      </SessionProvider>
    </ToastProvider>,
  );
  cleanupPage(context, routed);
  await settlePage();

  assert.equal(findButton(routed, "Resolve before run").disabled, true);
  assert.equal(findButton(routed, "Resume").disabled, true);
  assert.match(pageText(routed), /Disable → Test source → Activate paused → Resume/u);
  const buttonLabels = [...routed.container.querySelectorAll("button")]
    .map((button) => button.textContent?.trim());
  assert.equal(buttonLabels.includes("Run now"), false);
  assert.equal(buttonLabels.includes("Retry source"), false);
  assert.equal(buttonLabels.includes("Test source"), false);
});

test("provider detail drops disconnected older diagnostics on refresh and discards stale older responses after filter changes", async (context) => {
  const detail = operationsDetail();
  const base = diagnosticHistory();
  const [pageCommitted, connectionRetry] = base.events;
  assert.ok(pageCommitted && connectionRetry);
  const olderPage: ProviderSourceDiagnosticHistory = {
    ...base,
    events: [{ ...connectionRetry, occurredAt: "2026-08-21T11:58:00.000Z", safeCode: "OLDER_RETRY" }],
    nextCursor: "cursor-older",
  };
  const disconnectedPage: ProviderSourceDiagnosticHistory = {
    ...base,
    events: [
      { ...pageCommitted, occurredAt: "2026-08-21T12:01:00.000Z", safeCode: "NEWEST_COMMIT" },
      pageCommitted,
    ],
    nextCursor: "cursor-newest",
  };
  const criticalPage: ProviderSourceDiagnosticHistory = {
    ...base,
    events: [{ ...pageCommitted, severity: "critical", safeCode: "CRITICAL_ONLY" }],
    nextCursor: "cursor-critical",
    filter: { severity: "critical", phase: null, runId: null, contextEventsHidden: false },
  };
  const stalePage: ProviderSourceDiagnosticHistory = {
    ...base,
    events: [{ ...connectionRetry, occurredAt: "2026-08-21T11:57:00.000Z", safeCode: "STALE_OLDER" }],
    nextCursor: null,
  };
  let newestPage = base;
  let heldOlderResponse: Promise<Response> | null = null;
  stubFetch(context, ({ input }) => {
    const path = String(input);
    if (path.includes("/diagnostics")) {
      const url = new URL(path, "https://admin.packscout.test");
      if (url.searchParams.has("cursor")) {
        return heldOlderResponse ?? jsonResponse(olderPage);
      }
      return jsonResponse(url.searchParams.get("severity") === "critical" ? criticalPage : newestPage);
    }
    if (path === `/api/provider-source-operations/providers/${operationsFixtureIds.providers[0]}`) {
      return jsonResponse(detail);
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  const routed = await renderPage(
    <ToastProvider>
      <SessionProvider initialSession={operationsSession()}>
        <MemoryRouter initialEntries={[`/providers/${operationsFixtureIds.providers[0]}`]}>
          <Routes><Route path="/providers/:providerId" element={<ProviderDetailPage />} /></Routes>
        </MemoryRouter>
      </SessionProvider>
    </ToastProvider>,
  );
  cleanupPage(context, routed);
  await settlePage();
  const shownEvents = () => routed.container.querySelectorAll(".source-diagnostic-event").length;

  assert.equal(shownEvents(), 2);
  await act(async () => {
    findButton(routed, "Load older events").click();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  await settlePage();
  assert.equal(shownEvents(), 3);
  assert.match(pageText(routed), /OLDER_RETRY/);

  await act(async () => findButton(routed, "Pause display").click());
  await act(async () => {
    findButton(routed, "Resume display").click();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  await settlePage();
  assert.equal(shownEvents(), 3);
  assert.match(pageText(routed), /OLDER_RETRY/);

  newestPage = disconnectedPage;
  await act(async () => findButton(routed, "Pause display").click());
  await act(async () => {
    findButton(routed, "Resume display").click();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  await settlePage();
  assert.equal(shownEvents(), 2);
  assert.match(pageText(routed), /NEWEST_COMMIT/);
  assert.doesNotMatch(pageText(routed), /OLDER_RETRY/);

  const heldOlder = deferred<Response>();
  heldOlderResponse = heldOlder.promise;
  await act(async () => {
    findButton(routed, "Load older events").click();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  await act(async () => {
    changeControl(routed, "diagnostic-severity", "critical");
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  await settlePage();
  assert.match(pageText(routed), /CRITICAL_ONLY/);
  await act(async () => {
    heldOlder.resolve(jsonResponse(stalePage));
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  await settlePage();
  assert.equal(shownEvents(), 1);
  assert.doesNotMatch(pageText(routed), /STALE_OLDER/);
  assert.doesNotMatch(pageText(routed), /older diagnostic events loaded/iu);
  assert.equal(findButton(routed, "Load older events").disabled, false);
});

test("forbidden overview exposes no evidence and read-only provider detail hides administrator controls", async (context) => {
  let forbidden = true;
  stubFetch(context, ({ input }) => {
    const path = String(input);
    if (forbidden) return jsonResponse({ error: "Forbidden", code: "FORBIDDEN" }, 403);
    if (path.includes("/diagnostics")) return jsonResponse(diagnosticHistory());
    return jsonResponse(operationsDetail());
  });
  const denied = await renderPage(shell(<OperationsPage />, operationsSession("data_operator")));
  cleanupPage(context, denied);
  await settlePage();
  assert.match(pageText(denied), /role no longer permits processor status access/iu);
  assert.equal(denied.container.querySelector(".source-lane"), null);

  forbidden = false;
  const viewer: AuthSessionResponse = {
    ...operationsSession("data_operator"),
    permissions: ["providers:view"],
  };
  const readOnly = await renderPage(
    <ToastProvider>
      <SessionProvider initialSession={viewer}>
        <MemoryRouter initialEntries={[`/providers/${operationsFixtureIds.providers[0]}`]}>
          <Routes><Route path="/providers/:providerId" element={<ProviderDetailPage />} /></Routes>
        </MemoryRouter>
      </SessionProvider>
    </ToastProvider>,
  );
  cleanupPage(context, readOnly);
  await settlePage();
  assert.match(pageText(readOnly), /Read-only access/);
  assert.match(pageText(readOnly), /Current run: 500\. Next run: 1,000\./u);
  assert.doesNotMatch(pageText(readOnly), /Test source|Save timing|Save request size/);
  assert.equal(
    readOnly.container.querySelector("#provider-source-records-per-request"),
    null,
  );
  assert.equal([...readOnly.container.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Run now"), false);
});

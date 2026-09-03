import assert from "node:assert/strict";
import { test } from "node:test";
import type { PromotionJobInvocationDetail } from "@packscout/contracts";
import * as React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import {
  cleanupPage,
  deferred,
  jsonResponse,
  pageText,
  renderPage,
  settlePage,
  stubFetch,
} from "../testing/react-page-test.tsx";
import { PromotionJobDetailPage } from "./PromotionJobDetailPage.tsx";

Object.assign(globalThis, { React });

const monitoringId = "pj_6HY8d6A1RXq4A1l68cnXPgEVxk0Z_r6g";
const digest = "a".repeat(64);
const observedAt = "2026-09-01T12:00:00.000Z";

const detail: PromotionJobInvocationDetail = {
  invocation: {
    monitoringId,
    job: "provider:alpha",
    trigger: "continuation",
    state: "terminal",
    outcome: "caught_up",
    requestedAt: observedAt,
    startedAt: observedAt,
    finishedAt: "2026-09-01T12:00:01.000Z",
    durationMs: 1_000,
    cycleCount: 2,
    attemptCount: 1,
    retryCount: 0,
    failureCode: null,
    continuationPending: false,
  },
  totalAttemptCount: 1,
  truncatedAttemptCount: 0,
  attemptSetDigest: digest,
  attempts: [{
    attemptNumber: 1,
    kind: "provider",
    state: "completed",
    targetPosition: "81",
    retryCount: 0,
    failureCode: null,
    publicReleaseId: "alpha-81",
    releaseFingerprint: digest,
    totalOperationCount: 1,
    truncatedOperationCount: 0,
    orderedOperationDigest: digest,
    operationSummariesDigest: digest,
    observedAt,
    operations: [{
      operationNumber: 1,
      kind: "finalizeRelease",
      state: "acknowledged",
      sendCount: 1,
      sentAt: observedAt,
      acknowledgedAt: "2026-09-01T12:00:01.000Z",
      operationIdDigest: digest,
      requestDigest: digest,
      receiptDigest: digest,
    }],
  }],
};

function route(id: string) {
  return (
    <MemoryRouter initialEntries={[`/promotion-jobs/${id}`]}>
      <Routes>
        <Route path="/promotion-jobs/:monitoringId" element={<PromotionJobDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
}

test("shows bounded safe attempt evidence with semantic, keyboard-openable details", async (context) => {
  stubFetch(context, () => jsonResponse(detail));
  const rendered = await renderPage(route(monitoringId));
  cleanupPage(context, rendered);
  await settlePage();

  const text = pageText(rendered);
  assert.match(text, /Caught up/);
  assert.match(text, /At most 25 attempts and 25 operations per attempt are shown/);
  assert.match(text, /Attempt 1/);
  assert.equal(rendered.container.querySelectorAll("details").length, 1);
  const summary = rendered.container.querySelector<HTMLElement>("summary");
  assert.ok(summary);
  assert.equal(summary.tabIndex, 0);
  summary.focus();
  assert.equal(rendered.dom.window.document.activeElement, summary);
  assert.equal(rendered.container.querySelectorAll(".promotion-operation-table tbody tr").length, 1);
  assert.equal(rendered.container.querySelectorAll("h1").length, 1);
  for (const section of rendered.container.querySelectorAll<HTMLElement>("section[aria-labelledby]")) {
    const reference = section.getAttribute("aria-labelledby");
    assert.ok(reference);
    assert.ok(rendered.dom.window.document.getElementById(reference));
  }
  const operationTable = rendered.container.querySelector<HTMLTableElement>(".promotion-operation-table");
  assert.ok(operationTable);
  assert.ok(operationTable.caption?.textContent?.includes("Attempt 1 operations"));
  assert.equal(operationTable.querySelectorAll('thead th:not([scope="col"])').length, 0);
  assert.equal(operationTable.querySelectorAll('tbody th:not([scope="row"])').length, 0);
  const operationRegion = rendered.container.querySelector<HTMLElement>(
    '.promotion-table-region[role="region"][aria-label="Attempt 1 operations"]',
  );
  assert.equal(operationRegion?.tabIndex, 0);
  assert.doesNotMatch(rendered.container.innerHTML, /requestBody|responseBody|receiptBody|credential|claimToken/u);
  assert.equal(rendered.container.querySelectorAll("button").length, 0);
});

test("announces detail loading as a polite busy status", async (context) => {
  const load = deferred<Response>();
  stubFetch(context, () => load.promise);
  const rendered = await renderPage(route(monitoringId));
  cleanupPage(context, rendered);

  assert.equal(rendered.container.querySelectorAll("h1").length, 1);
  const status = rendered.container.querySelector<HTMLElement>(
    '[role="status"][aria-live="polite"][aria-atomic="true"][aria-busy="true"]',
  );
  assert.equal(status?.textContent?.trim(), "Loading promotion job evidence…");

  load.resolve(jsonResponse(detail));
  await settlePage();
});

test("reports a detail failure with an unambiguous retry control", async (context) => {
  stubFetch(context, () => jsonResponse(
    { error: "Unavailable", code: "SERVICE_UNAVAILABLE" },
    503,
  ));
  const rendered = await renderPage(route(monitoringId));
  cleanupPage(context, rendered);
  await settlePage();

  const alert = rendered.container.querySelector<HTMLElement>('[role="alert"]');
  assert.match(alert?.textContent ?? "", /promotion job is temporarily unavailable/);
  const retry = alert?.querySelector<HTMLButtonElement>("button");
  assert.equal(retry?.textContent?.trim(), "Retry promotion job detail");
  assert.equal(retry?.type, "button");
});

test("rejects a non-opaque detail path before any monitoring request", async (context) => {
  const requests = stubFetch(context, () => jsonResponse(detail));
  const rendered = await renderPage(route("10000000-0000-4000-8000-000000000001"));
  cleanupPage(context, rendered);
  await settlePage();

  assert.match(pageText(rendered), /link is invalid. No monitoring request was sent/);
  assert.equal(requests.length, 0);
  assert.equal(
    rendered.container.querySelector('a[href="/promotion-jobs"]')?.textContent,
    "Back to promotion jobs",
  );
});

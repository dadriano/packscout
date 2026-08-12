import assert from "node:assert/strict";
import { test } from "node:test";
import type { AdminAlertDetail, AdminAlertSummary } from "@packscout/contracts";
import { act } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ConfirmProvider } from "../providers/confirm.tsx";
import { ToastProvider } from "../providers/toast.tsx";
import {
  cleanupPage,
  deferred,
  findButton,
  jsonResponse,
  pageText,
  renderPage,
  settlePage,
  stubFetch,
} from "../testing/react-page-test.tsx";
import { AlertDetailPage } from "./AlertDetailPage.tsx";

const alert: AdminAlertDetail = {
  id: "00000000-0000-4000-8000-000000000050",
  kind: "run_incomplete",
  severity: "warning",
  state: "active",
  title: "Provider feed stopped early",
  summary: "The latest import stopped before reaching provider head.",
  providerId: "00000000-0000-4000-8000-000000000020",
  runId: "00000000-0000-4000-8000-000000000030",
  quarantineId: null,
  firstSeenAt: "2026-08-06T12:01:00.000Z",
  lastSeenAt: "2026-08-06T12:01:00.000Z",
  occurrenceCount: 1,
  reopenedCount: 0,
  acknowledgedAt: null,
  resolvedAt: null,
  occurrences: [{
    id: "00000000-0000-4000-8000-000000000051",
    kind: "run_incomplete",
    severity: "warning",
    occurredAt: "2026-08-06T12:01:00.000Z",
    evidence: { failureCode: "IMPORT_INVALID_CONTRACT", count: 2 },
  }],
};

function summary(state: "acknowledged" | "resolved"): AdminAlertSummary {
  return {
    ...alert,
    state,
    acknowledgedAt: "2026-08-06T12:03:00.000Z",
    resolvedAt: state === "resolved" ? "2026-08-06T12:04:00.000Z" : null,
  };
}

function route() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[`/alerts/${alert.id}`]}>
          <Routes>
            <Route path="/alerts/:alertId" element={<AlertDetailPage />} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </ToastProvider>
  );
}

test("alert detail loads bounded evidence, acknowledges directly, and confirms resolution", async (context) => {
  const load = deferred<Response>();
  const requests = stubFetch(context, ({ input, init }, requestIndex) => {
    if (requestIndex === 0) {
      assert.equal(String(input), `/api/operational-alerts/${alert.id}`);
      return load.promise;
    }
    if (requestIndex === 1) {
      assert.equal(String(input), `/api/operational-alerts/${alert.id}/acknowledge`);
      assert.equal(init?.method, "POST");
      return jsonResponse({ alert: summary("acknowledged") });
    }
    assert.equal(String(input), `/api/operational-alerts/${alert.id}/resolve`);
    assert.equal(init?.method, "POST");
    return jsonResponse({ alert: summary("resolved") });
  });

  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  assert.match(pageText(renderer), /Loading alert evidence/);

  load.resolve(jsonResponse({ alert }));
  await settlePage();
  assert.match(pageText(renderer), /Provider feed stopped early/);
  assert.match(pageText(renderer), /FailureCode IMPORT_INVALID_CONTRACT/);
  assert.match(pageText(renderer), /Review import run/);

  await act(async () => findButton(renderer, "Acknowledge").click());
  await settlePage();
  assert.match(pageText(renderer), /Alert acknowledged/);
  assert.equal([...renderer.container.querySelectorAll("button")]
    .some((button) => button.textContent?.trim() === "Acknowledge"), false);

  await act(async () => findButton(renderer, "Resolve alert").click());
  assert.match(pageText(renderer), /without deleting its occurrence history/);
  await act(async () => findButton(renderer, "Resolve alert", 1).click());
  await settlePage();

  assert.equal(requests.length, 3);
  assert.match(pageText(renderer), /Alert resolved\. Its history remains available/);
  assert.equal([...renderer.container.querySelectorAll("button")]
    .some((button) => button.textContent?.trim() === "Resolve alert"), false);
  assert.match(pageText(renderer), /Occurrence history/);
});

test("alert detail presents a permission-specific failure without mutation controls", async (context) => {
  stubFetch(context, () => jsonResponse({ error: "Forbidden", code: "FORBIDDEN" }, 403));
  const renderer = await renderPage(route());
  cleanupPage(context, renderer);

  assert.match(pageText(renderer), /Your role no longer permits access to this alert/);
  assert.match(pageText(renderer), /Return to alerts/);
  assert.doesNotMatch(pageText(renderer), /Acknowledge|Resolve alert/);
});

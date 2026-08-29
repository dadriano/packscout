import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import type { AuthSessionResponse, QuarantineEntryDetail } from "@packscout/contracts";
import { act } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ConfirmProvider } from "../providers/confirm.tsx";
import { SessionProvider } from "../providers/session.tsx";
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
import { QuarantineDetailPage } from "./QuarantineDetailPage.tsx";

Object.assign(globalThis, { React });

const entry: QuarantineEntryDetail = {
  id: "00000000-0000-4000-8000-000000000040",
  providerId: "00000000-0000-4000-8000-000000000020",
  configurationRevisionId: "00000000-0000-4000-8000-000000000021",
  platformKey: "fanatics",
  runId: "00000000-0000-4000-8000-000000000030",
  pageId: "00000000-0000-4000-8000-000000000031",
  recordKind: "catalog",
  recordIndex: 0,
  externalId: "safe-source-42",
  reasonCode: "MAPPING_FAILED",
  fieldPath: "item.value",
  sanitizedSummary: "The item could not be mapped.",
  state: "open",
  attemptCount: 0,
  firstFailureAt: "2026-08-06T12:00:30.000Z",
  latestFailureAt: "2026-08-06T12:00:30.000Z",
  rawExpiresAt: "2026-08-13T12:00:30.000Z",
  resolvedAt: null,
  resolutionSummary: null,
  attempts: [],
};

const session: AuthSessionResponse = {
  operator: {
    id: "00000000-0000-4000-8000-000000000050",
    email: "operator@example.test",
    displayName: "Data Operator",
    state: "active",
  },
  membership: {
    organizationId: "00000000-0000-4000-8000-000000000051",
    organizationName: "PackScout",
    role: "data_operator",
  },
  permissions: ["providers:view", "imports:start", "imports:retry"],
  csrfToken: "fixture-csrf",
};

function route(currentEntry: QuarantineEntryDetail = entry) {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <SessionProvider initialSession={session}>
          <MemoryRouter initialEntries={[`/quarantine/${currentEntry.id}`]}>
            <Routes>
              <Route path="/quarantine/:quarantineId" element={<QuarantineDetailPage />} />
            </Routes>
          </MemoryRouter>
        </SessionProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}

test("quarantine detail loads safe evidence and retries one open record with confirmation", async (context) => {
  const initialLoad = deferred<Response>();
  const requests = stubFetch(context, ({ input, init }, requestIndex) => {
    if (requestIndex === 0) {
      assert.equal(String(input), `/api/quarantine/${entry.id}`);
      assert.equal(init?.method, undefined);
      return initialLoad.promise;
    }
    assert.equal(String(input), `/api/quarantine/${entry.id}/retries`);
    assert.equal(init?.method, "POST");
    return jsonResponse({
      outcome: {
        quarantineId: entry.id,
        outcome: "resolved",
        entry: {
          ...entry,
          state: "resolved",
          attemptCount: 1,
          resolvedAt: "2026-08-06T12:05:00.000Z",
          resolutionSummary: "Accepted on retry.",
        },
      },
    });
  });

  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  assert.match(pageText(renderer), /Loading safe quarantine evidence/);

  initialLoad.resolve(jsonResponse({ entry }));
  await settlePage();
  assert.match(pageText(renderer), /safe-source-42/);
  assert.match(pageText(renderer), /The item could not be mapped/);

  await act(async () => findButton(renderer, "Retry record").click());
  assert.match(pageText(renderer), /does not rewind the provider cursor/);

  await act(async () => findButton(renderer, "Retry record", 1).click());
  await settlePage();

  assert.equal(requests.length, 2);
  assert.match(pageText(renderer), /The record was accepted and current quality resolution was updated/);
  assert.match(pageText(renderer), /Accepted on retry/);
  assert.equal(
    [...renderer.container.querySelectorAll("button")]
      .filter((button) => button.textContent?.trim() === "Retry record").length,
    0,
  );
});

test("quarantine detail explains when the operator loses permission", async (context) => {
  stubFetch(context, () => jsonResponse({ error: "Forbidden", code: "FORBIDDEN" }, 403));
  const renderer = await renderPage(route());
  cleanupPage(context, renderer);

  assert.match(pageText(renderer), /Your role no longer permits quarantine access/);
  assert.match(pageText(renderer), /Return to quarantine/);
  assert.doesNotMatch(pageText(renderer), /Retry record/);
});

test("expired source quarantines explain that no retry artifact was retained", async (context) => {
  const expiredEntry: QuarantineEntryDetail = {
    ...entry,
    sanitizedSummary:
      "The source adapter rejected this record before canonical translation; no retry artifact is retained.",
    state: "expired",
    rawExpiresAt: entry.firstFailureAt,
  };
  stubFetch(context, () => jsonResponse({ entry: expiredEntry }));
  const renderer = await renderPage(route(expiredEntry));
  cleanupPage(context, renderer);
  await settlePage();

  assert.match(pageText(renderer), /no retry artifact is retained/);
  assert.match(pageText(renderer), /Retry artifact Unavailable/);
  assert.doesNotMatch(pageText(renderer), /Source evidence expired/);
  assert.equal(
    [...renderer.container.querySelectorAll("button")]
      .some((button) => button.textContent?.trim() === "Retry record"),
    false,
  );
});

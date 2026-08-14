import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ImportRunDetail } from "../api/import-operations.ts";
import {
  cleanupPage,
  deferred,
  jsonResponse,
  pageText,
  renderPage,
  settlePage,
  stubFetch,
} from "../testing/react-page-test.tsx";
import { RunDetailPage } from "./RunDetailPage.tsx";

const run: ImportRunDetail = {
  id: "00000000-0000-4000-8000-000000000030",
  providerId: "00000000-0000-4000-8000-000000000020",
  providerName: "Fanatics cards",
  platformKey: "fanatics",
  configurationRevisionId: "00000000-0000-4000-8000-000000000021",
  configurationVersion: 2,
  trigger: "manual",
  state: "incomplete",
  requestedAt: "2026-08-06T12:00:00.000Z",
  startedAt: "2026-08-06T12:00:01.000Z",
  finishedAt: "2026-08-06T12:01:00.000Z",
  lastProgressAt: "2026-08-06T12:00:55.000Z",
  reachedProviderHead: false,
  counters: {
    pages: 1,
    catalog: 3,
    pulls: 4,
    trades: 5,
    accepted: 9,
    unchanged: 2,
    revised: 1,
    quarantined: 2,
    resolvedQuarantines: 1,
  },
  failure: {
    class: "contract",
    code: "IMPORT_INVALID_CONTRACT",
    summary: "Provider response failed validation.",
  },
  cursor: { requestedPreview: "start…", finalPreview: "page-1…" },
  pages: [{
    pageNumber: 1,
    requestedCursorPreview: "start…",
    nextCursorPreview: "page-1…",
    hasMore: true,
    committedAt: "2026-08-06T12:00:55.000Z",
    catalog: 3,
    pulls: 4,
    trades: 5,
    accepted: 9,
    unchanged: 2,
    revised: 1,
    quarantined: 2,
  }],
  timeline: [
    { state: "queued", occurredAt: "2026-08-06T12:00:00.000Z", summary: "Run queued." },
    { state: "running", occurredAt: "2026-08-06T12:00:01.000Z", summary: "Worker claimed run." },
    { state: "incomplete", occurredAt: "2026-08-06T12:01:00.000Z", summary: "Feed stopped before provider head." },
  ],
  relatedQuarantines: [],
};

function route(targetRun: ImportRunDetail = run) {
  return (
    <MemoryRouter initialEntries={[`/runs/${targetRun.id}`]}>
      <Routes>
        <Route path="/runs/:runId" element={<RunDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
}

test("run detail moves from durable loading state to bounded historical evidence", async (context) => {
  const load = deferred<Response>();
  const requests = stubFetch(context, ({ input }) => {
    assert.equal(String(input), `/api/import-runs/${run.id}`);
    return load.promise;
  });
  const renderer = await renderPage(route());
  cleanupPage(context, renderer);

  assert.match(pageText(renderer), /Loading durable run evidence/);
  load.resolve(jsonResponse({ run }));
  await settlePage();

  const text = pageText(renderer);
  assert.equal(requests.length, 1);
  assert.match(text, /Fanatics cards/);
  assert.match(text, /Progress was saved, but the feed did not finish/);
  assert.match(text, /Provider response failed validation/);
  assert.match(text, /Quarantined then \/ now\s+2\s+\/\s+1/);
  assert.match(text, /Page\s+1/);
  assert.match(text, /No records from this run need review/);
  assert.doesNotMatch(text, /rawPayload|authorization|bearer token/i);
});

test("run detail replaces loading with a permission-specific failure", async (context) => {
  stubFetch(context, () => jsonResponse({ error: "Forbidden", code: "FORBIDDEN" }, 403));
  const renderer = await renderPage(route());
  cleanupPage(context, renderer);

  assert.match(pageText(renderer), /Your role no longer permits access to this run/);
  assert.match(pageText(renderer), /Return to runs/);
  assert.doesNotMatch(pageText(renderer), /Fanatics cards/);
});

test("archive detail never presents archive offsets as the live provider checkpoint", async (context) => {
  const archiveRun: ImportRunDetail = {
    ...run,
    trigger: "archive",
    cursor: { requestedPreview: null, finalPreview: null },
    pages: [{
      ...run.pages[0]!,
      requestedCursorPreview: null,
      nextCursorPreview: null,
    }],
  };
  stubFetch(context, () => jsonResponse({ run: archiveRun }));
  const renderer = await renderPage(route(archiveRun));
  cleanupPage(context, renderer);
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /Archive source/);
  assert.match(text, /Starting archive offset/);
  assert.match(text, /Final archive offset/);
  assert.match(text, /Archive offset in/);
  assert.match(text, /Archive offset out/);
  assert.doesNotMatch(text, /Provider head/);
});

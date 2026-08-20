import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  RecomputationQueueEntry,
  RetentionExecutionSummary,
} from "@packscout/contracts";
import {
  evaluateRecomputationBacklog,
  evaluateRetentionCadence,
} from "@packscout/contracts";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
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
  type RecordedRequest,
} from "../testing/react-page-test.tsx";
import { BackgroundWorkPage } from "./BackgroundWorkPage.tsx";

const now = "2026-08-19T12:00:00.000Z";
const stuckId = "00000000-0000-4000-8000-000000000050";
const failedId = "00000000-0000-4000-8000-000000000051";

const stuck: RecomputationQueueEntry = {
  id: stuckId,
  providerId: "00000000-0000-4000-8000-000000000020",
  platformKey: "fanatics",
  state: "claimed",
  packReference: "pack:a1b2c3d4e5f6",
  attemptCount: 2,
  createdAt: "2026-08-19T11:30:00.000Z",
  availableAt: "2026-08-19T11:30:00.000Z",
  completedAt: null,
  claimedBy: "worker:departed:1",
  claimExpiresAt: "2026-08-19T11:55:00.000Z",
  claimAgeMs: 900_000,
  claimExpired: true,
  failureCode: null,
  failureSummary: null,
};
const failed: RecomputationQueueEntry = {
  ...stuck,
  id: failedId,
  state: "failed",
  packReference: "pack:f6e5d4c3b2a1",
  claimedBy: null,
  claimExpiresAt: null,
  claimAgeMs: null,
  claimExpired: false,
  attemptCount: 5,
  failureCode: "ESTIMATED_EV_RECOMPUTATION_FAILED",
  failureSummary: "The recalculation stopped with a bounded operational failure.",
};
const execution: RetentionExecutionSummary = {
  id: "00000000-0000-4000-8000-000000000060",
  state: "succeeded",
  startedAt: "2026-08-19T10:00:00.000Z",
  finishedAt: "2026-08-19T10:00:02.000Z",
  durationMs: 2_000,
  cutoffAt: "2026-05-21T10:00:00.000Z",
  pruned: { pages: 2, sourceRecords: 5, quarantines: 1, total: 8 },
  alreadyExpired: 4,
  remaining: 12,
  failureCode: null,
  failureSummary: null,
};

const backlog = evaluateRecomputationBacklog({
  now,
  pending: 4,
  readyPending: 3,
  claimed: 2,
  expiredClaims: 1,
  failed: 1,
  oldestPendingAvailableAt: "2026-08-19T11:00:00.000Z",
  timelyAfterMs: 60_000,
});
const cadence = evaluateRetentionCadence({
  now,
  expectedIntervalMs: 60_000,
  latest: execution,
});

function route() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <MemoryRouter initialEntries={["/background-work"]}>
          <BackgroundWorkPage />
        </MemoryRouter>
      </ConfirmProvider>
    </ToastProvider>
  );
}

function path({ input }: RecordedRequest): string {
  return String(input);
}

test("background work shows server-derived backlog, stuck claims, and retention history", async (context) => {
  const queueLoad = deferred<Response>();
  const retentionLoad = deferred<Response>();
  stubFetch(context, (request) =>
    path(request).startsWith("/api/background-work/recomputations")
      ? queueLoad.promise
      : retentionLoad.promise,
  );

  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  assert.match(pageText(renderer), /Loading recomputation queue/);
  assert.match(pageText(renderer), /Loading retention history/);

  queueLoad.resolve(
    jsonResponse({ items: [stuck, failed], nextCursor: null, backlog }),
  );
  retentionLoad.resolve(
    jsonResponse({ items: [execution], nextCursor: null, cadence }),
  );
  await settlePage();
  const text = pageText(renderer);
  // The measures are rendered from the server evaluation, not recomputed here.
  assert.match(text, /Queue depth/);
  assert.match(text, /4 pending · 2 in flight/);
  assert.match(text, /Backlogged/);
  assert.match(text, /Stuck claim/);
  assert.match(text, /worker:departed:1/);
  assert.match(text, /pack:a1b2c3d4e5f6/);
  assert.match(text, /Retention executions/);
  assert.match(text, /Overdue/);
  assert.match(text, /12 payloads still to clear/);
});

test("releasing a stuck claim confirms first and reports the per-entry outcome", async (context) => {
  const requests = stubFetch(context, (request) => {
    if (path(request) === `/api/background-work/recomputations/${stuckId}/recoveries`) {
      assert.equal(request.init?.method, "POST");
      assert.equal(String(request.init?.body), JSON.stringify({ action: "release" }));
      return jsonResponse({
        result: {
          requestId: stuckId,
          outcome: "released",
          entry: {
            ...stuck,
            state: "pending",
            claimedBy: null,
            claimExpiresAt: null,
            claimAgeMs: null,
            claimExpired: false,
          },
        },
      });
    }
    if (path(request).startsWith("/api/background-work/recomputations")) {
      return jsonResponse({ items: [stuck, failed], nextCursor: null, backlog });
    }
    return jsonResponse({ items: [execution], nextCursor: null, cadence });
  });

  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  const checkbox = renderer.container.querySelector<HTMLInputElement>(
    "input[type=checkbox]",
  );
  assert.ok(checkbox);
  await act(async () => checkbox.click());

  await act(async () => findButton(renderer, "Release stuck claims (1)").click());
  assert.match(pageText(renderer), /Release 1 recomputation request\?/);
  assert.match(pageText(renderer), /already-resolved outcome instead of running it twice/);

  await act(async () => findButton(renderer, "Release request").click());
  await settlePage();

  assert.equal(
    requests.filter((entry) => path(entry).endsWith("/recoveries")).length,
    1,
  );
  assert.match(pageText(renderer), /Latest recovery outcomes/);
  assert.match(pageText(renderer), /Claim released/);
  assert.match(pageText(renderer), /1 returned to the queue/);
  // The released entry no longer offers recovery.
  assert.equal(
    [...renderer.container.querySelectorAll("button")].filter(
      (button) => button.textContent?.trim().startsWith("Release stuck claims"),
    ).length,
    0,
  );
});

test("a worker that wins the race surfaces as an already-resolved conflict", async (context) => {
  stubFetch(context, (request) => {
    if (path(request).endsWith("/recoveries")) {
      return jsonResponse({
        result: {
          requestId: stuckId,
          outcome: "already_resolved",
          entry: { ...stuck, state: "completed", claimExpired: false, completedAt: now },
        },
      });
    }
    if (path(request).startsWith("/api/background-work/recomputations")) {
      return jsonResponse({ items: [stuck], nextCursor: null, backlog });
    }
    return jsonResponse({ items: [], nextCursor: null, cadence });
  });

  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  const checkbox = renderer.container.querySelector<HTMLInputElement>(
    "input[type=checkbox]",
  );
  await act(async () => checkbox?.click());
  await act(async () => findButton(renderer, "Release stuck claims (1)").click());
  await act(async () => findButton(renderer, "Release request").click());
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /Already resolved by a worker/);
  assert.match(text, /0 returned to the queue; 1 already resolved/);
  assert.doesNotMatch(text, /The action failed/);
});

test("losing pipeline access explains the boundary instead of showing stale controls", async (context) => {
  stubFetch(context, () =>
    jsonResponse({ error: "Forbidden", code: "FORBIDDEN" }, 403),
  );
  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /Your role no longer permits the recomputation queue access/);
  assert.match(text, /Your role no longer permits retention history access/);
  assert.doesNotMatch(text, /Release stuck claims/);
});

test("empty background work reads explain why nothing is listed", async (context) => {
  stubFetch(context, (request) => {
    if (path(request).startsWith("/api/background-work/recomputations")) {
      return jsonResponse({
        items: [],
        nextCursor: null,
        backlog: evaluateRecomputationBacklog({
          now,
          pending: 0,
          readyPending: 0,
          claimed: 0,
          expiredClaims: 0,
          failed: 0,
          oldestPendingAvailableAt: null,
          timelyAfterMs: 60_000,
        }),
      });
    }
    return jsonResponse({
      items: [],
      nextCursor: null,
      cadence: evaluateRetentionCadence({
        now,
        expectedIntervalMs: 60_000,
        latest: null,
      }),
    });
  });

  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /The queue is empty/);
  assert.match(text, /No retention executions yet/);
  assert.match(text, /No retention execution has been recorded/);
  assert.match(text, /Idle/);
});

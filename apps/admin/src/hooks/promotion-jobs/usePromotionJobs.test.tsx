import assert from "node:assert/strict";
import { test } from "node:test";
import type { PromotionJobMonitoringOverview } from "@packscout/contracts";
import * as React from "react";
import { act } from "react";
import {
  cleanupPage,
  deferred,
  jsonResponse,
  renderPage,
  settlePage,
  stubFetch,
} from "../../testing/react-page-test.tsx";
import {
  PROMOTION_JOB_REFRESH_MS,
  usePromotionJobOverview,
} from "./usePromotionJobs.ts";

Object.assign(globalThis, { React });

const observedAt = "2026-09-01T12:00:00.000Z";
const digest = "a".repeat(64);

function overview(version: string): PromotionJobMonitoringOverview {
  return {
    observedAt,
    roster: {
      observedAt,
      version,
      highWater: version,
      digest,
      providerCount: 0,
      eligibleProviderCount: 0,
    },
    evaluator: {
      state: "pending",
      observedAt: null,
      evaluatedThrough: null,
      rosterVersion: null,
      rosterHighWater: null,
      rosterDigest: null,
      expectedCount: null,
      reachableCount: null,
      unavailableCount: null,
      manifestEvaluated: null,
      failureCode: null,
    },
    manifest: {
      evidenceSource: "unavailable",
      observedAt: null,
      stale: false,
      schedule: null,
      wake: null,
      activeManifest: null,
      previousManifest: null,
      gateQueueDepth: 0,
      oldestGateAgeMs: null,
      serializedOperation: null,
      lastActivationAt: null,
      lastReconciliationAt: null,
      latestInvocation: null,
    },
    providers: [],
  };
}

function OverviewProbe() {
  const read = usePromotionJobOverview();
  return (
    <output
      data-loading={String(read.loading)}
      data-refreshing={String(read.refreshing)}
    >
      {read.data?.roster.version ?? "none"}
    </output>
  );
}

test("automatic polling lets a slow overview request settle before starting another", async (context) => {
  const firstRead = deferred<Response>();
  const requests = stubFetch(context, (_request, requestIndex) => requestIndex === 0
    ? firstRead.promise
    : jsonResponse(overview("2")));
  const rendered = await renderPage(<p>Preparing</p>);
  cleanupPage(context, rendered);

  let poll: (() => void) | null = null;
  Object.defineProperty(rendered.dom.window, "setInterval", {
    configurable: true,
    value(handler: TimerHandler, milliseconds?: number) {
      assert.equal(milliseconds, PROMOTION_JOB_REFRESH_MS);
      assert.equal(typeof handler, "function");
      poll = () => {
        if (typeof handler === "function") handler();
      };
      return 1;
    },
  });
  Object.defineProperty(rendered.dom.window.document, "visibilityState", {
    configurable: true,
    value: "visible",
  });

  await act(async () => rendered.root.render(<OverviewProbe />));
  await settlePage();
  assert.equal(requests.length, 1);
  assert.equal(rendered.container.querySelector("output")?.dataset.loading, "true");
  assert.ok(poll);

  await act(async () => poll?.());
  await act(async () => poll?.());
  await settlePage();
  assert.equal(requests.length, 1, "poll ticks do not supersede the active request");
  assert.equal((requests[0]?.init?.signal as AbortSignal | undefined)?.aborted, false);

  firstRead.resolve(jsonResponse(overview("1")));
  await settlePage();
  assert.equal(rendered.container.querySelector("output")?.textContent, "1");
  assert.equal(rendered.container.querySelector("output")?.dataset.loading, "false");

  await act(async () => poll?.());
  await settlePage();
  assert.equal(requests.length, 2, "polling resumes after the prior request settles");
  assert.equal(rendered.container.querySelector("output")?.textContent, "2");
});

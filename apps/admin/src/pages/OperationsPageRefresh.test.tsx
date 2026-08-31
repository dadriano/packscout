import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { SessionProvider } from "../providers/session.tsx";
import { ToastProvider } from "../providers/toast.tsx";
import { cleanupPage, deferred, findButton, jsonResponse, pageText, renderPage, settlePage, stubFetch } from "../testing/react-page-test.tsx";
import { operationsFixtureIds, operationsOverview, operationsSession } from "../testing/provider-source-operations-fixture.ts";
import { OperationsPage } from "./OperationsPage.tsx";

Object.assign(globalThis, { React });

const page = () => <ToastProvider><SessionProvider initialSession={operationsSession()}><MemoryRouter><OperationsPage /></MemoryRouter></SessionProvider></ToastProvider>;

test("slow provider count reads survive repeated refresh ticks without overlapping or starving", async (context) => {
  const response = deferred<Response>();
  const requests = stubFetch(context, () => response.promise);
  const rendered = await renderPage(page());
  cleanupPage(context, rendered);
  Object.defineProperty(rendered.dom.window.document, "visibilityState", { configurable: true, value: "visible" });
  assert.match(pageText(rendered), /Loading providers/u);
  await act(async () => {
    for (let index = 0; index < 4; index += 1) document.dispatchEvent(new rendered.dom.window.Event("visibilitychange"));
  });
  assert.equal(requests.length, 1, "refresh callbacks do not supersede the ongoing exact-count read");
  response.resolve(jsonResponse(operationsOverview()));
  await settlePage();
  assert.equal(rendered.container.querySelectorAll(".provider-pulse__card").length, 4);
  assert.equal(requests.length, 1, "routine polling does not queue an extra read after settlement");
});

test("commands completing during a read coalesce into one immediate fresh read without poll storms", async (context) => {
  const before = operationsOverview();
  const stale = operationsOverview();
  stale.sources[0]!.displayName = "Obsolete Courtyard";
  const after = operationsOverview();
  after.sources[0]!.displayName = "Post-command Courtyard";
  const held = deferred<Response>();
  const followup = deferred<Response>();
  let reads = 0;
  stubFetch(context, ({ input }) => {
    const path = String(input);
    if (path.endsWith("/pause")) return jsonResponse({ state: "pause_requested", audit: { outcome: "succeeded" } });
    if (path.endsWith("/resume")) return jsonResponse({ state: "resumed", audit: { outcome: "succeeded" } });
    reads += 1;
    return reads === 1 ? jsonResponse(before) : reads === 2 ? held.promise : followup.promise;
  });
  const rendered = await renderPage(page());
  cleanupPage(context, rendered);
  Object.defineProperty(rendered.dom.window.document, "visibilityState", { configurable: true, value: "visible" });
  await settlePage();
  await act(async () => document.dispatchEvent(new rendered.dom.window.Event("visibilitychange")));
  const courtyard = rendered.container.querySelector(`[data-provider-id="${operationsFixtureIds.providers[0]}"]`)!;
  const pause = [...courtyard.querySelectorAll("button")].find((button) => button.textContent === "Pause")!;
  await act(async () => pause.click());
  await settlePage();
  await act(async () => findButton(rendered, "Resume").click());
  await settlePage();
  assert.match(pageText(rendered), /resumed from the committed cursor/u);
  assert.equal(reads, 2, "commands wait for the current read instead of starting overlapping reads");
  held.resolve(jsonResponse(stale));
  await settlePage();
  assert.equal(reads, 3, "one fresh read starts immediately after the pre-command read settles");
  assert.doesNotMatch(pageText(rendered), /Obsolete Courtyard/u);
  await act(async () => {
    for (let index = 0; index < 4; index += 1) document.dispatchEvent(new rendered.dom.window.Event("visibilitychange"));
  });
  assert.equal(reads, 3);
  followup.resolve(jsonResponse(after));
  await settlePage();
  assert.match(pageText(rendered), /Post-command Courtyard/u);
  assert.equal(reads, 3, "multiple commands coalesce and routine ticks do not queue extra reads");
});

for (const exit of ["pause", "unmount"] as const) {
  test(`${exit} cancels a queued post-command refresh`, async (context) => {
    const held = deferred<Response>();
    let reads = 0;
    stubFetch(context, ({ input }) => {
      if (String(input).endsWith("/pause")) return jsonResponse({ state: "pause_requested", audit: { outcome: "succeeded" } });
      reads += 1;
      return reads === 2 ? held.promise : jsonResponse(operationsOverview());
    });
    const rendered = await renderPage(page());
    cleanupPage(context, rendered);
    Object.defineProperty(rendered.dom.window.document, "visibilityState", { configurable: true, value: "visible" });
    await settlePage();
    await act(async () => document.dispatchEvent(new rendered.dom.window.Event("visibilitychange")));
    const courtyard = rendered.container.querySelector(`[data-provider-id="${operationsFixtureIds.providers[0]}"]`)!;
    const pause = [...courtyard.querySelectorAll("button")].find((button) => button.textContent === "Pause")!;
    await act(async () => pause.click());
    await settlePage();
    assert.match(pageText(rendered), /pause requested; the current page may commit/u);
    await act(async () => {
      if (exit === "pause") findButton(rendered, "Pause display").click();
      else rendered.root.render(<p>Status closed</p>);
    });
    held.resolve(jsonResponse(operationsOverview()));
    await settlePage();
    assert.equal(reads, 2, `${exit} prevents the queued follow-up read`);
    if (exit === "pause") {
      await act(async () => findButton(rendered, "Resume display").click());
      await settlePage();
      assert.equal(reads, 3, "resuming makes one read without replaying the old queued refresh");
    }
  });
}

test("display pause discards an in-flight update, resume refreshes, and failed reads retain measured evidence", async (context) => {
  const first = operationsOverview();
  const next = operationsOverview();
  next.refreshedAt = "2026-08-21T12:00:30.000Z";
  next.sources[0]!.displayName = "Updated Courtyard";
  const held = deferred<Response>();
  let fail = false;
  const requests = stubFetch(context, (_request, index) => index === 1 ? held.promise
    : fail ? jsonResponse({ error: "Snapshot read failed", code: "SOURCE_OPERATIONS_UNAVAILABLE" }, 503)
      : jsonResponse(index === 0 ? first : next));
  const rendered = await renderPage(page());
  cleanupPage(context, rendered);
  Object.defineProperty(rendered.dom.window.document, "visibilityState", { configurable: true, value: "visible" });
  await settlePage();
  await act(async () => document.dispatchEvent(new rendered.dom.window.Event("visibilitychange")));
  assert.equal(requests.length, 2);
  await act(async () => findButton(rendered, "Pause display").click());
  held.resolve(jsonResponse(next));
  await settlePage();
  assert.doesNotMatch(pageText(rendered), /Updated Courtyard/u);
  assert.match(pageText(rendered), /Snapshot paused · ingestion continues/u);
  await act(async () => document.dispatchEvent(new rendered.dom.window.Event("visibilitychange")));
  assert.equal(requests.length, 2, "paused display does not poll");
  await act(async () => findButton(rendered, "Resume display").click());
  await settlePage();
  assert.match(pageText(rendered), /Updated Courtyard/u);
  const beforeFailure = rendered.container.querySelector(".provider-pulse")!.textContent;
  fail = true;
  await act(async () => document.dispatchEvent(new rendered.dom.window.Event("visibilitychange")));
  await settlePage();
  assert.match(pageText(rendered), /Refresh failed/u);
  assert.equal(rendered.container.querySelector(".provider-pulse")!.textContent, beforeFailure);
  await act(async () => findButton(rendered, "Pause display").click());
  fail = false;
  const requestsBeforeRetry = requests.length;
  await act(async () => findButton(rendered, "Refresh safe evidence").click());
  await settlePage();
  assert.equal(requests.length, requestsBeforeRetry + 1, "explicit retry resumes and refreshes a paused display");
  assert.match(pageText(rendered), /Auto-refresh/u);
  assert.doesNotMatch(pageText(rendered), /Refresh failed|Display paused/u);
});

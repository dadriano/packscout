import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { SessionProvider } from "../providers/session.tsx";
import { ToastProvider } from "../providers/toast.tsx";
import { cleanupPage, deferred, findButton, jsonResponse, pageText, renderPage, settlePage, stubFetch } from "../testing/react-page-test.tsx";
import { operationsOverview, operationsSession } from "../testing/provider-source-operations-fixture.ts";
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
});

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

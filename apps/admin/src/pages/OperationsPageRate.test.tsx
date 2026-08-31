import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import * as React from "react";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { SessionProvider } from "../providers/session.tsx";
import { ToastProvider } from "../providers/toast.tsx";
import { cleanupPage, deferred, findButton, jsonResponse, renderPage, settlePage, stubFetch } from "../testing/react-page-test.tsx";
import { operationsFixtureIds, operationsOverview, operationsSession } from "../testing/provider-source-operations-fixture.ts";
import { OperationsPage } from "./OperationsPage.tsx";

Object.assign(globalThis, { React });

function snapshot(seconds: number, processed: number) {
  const overview = operationsOverview();
  overview.refreshedAt = new Date(Date.parse(overview.refreshedAt) + seconds * 1_000).toISOString();
  overview.sources[0]!.progress.records.total = processed;
  return overview;
}

async function setup(context: TestContext, strict = false) {
  let response: () => Response | Promise<Response> = () => jsonResponse(snapshot(0, 100));
  const requests = stubFetch(context, () => response());
  const rendered = await renderPage(<p>Preparing status</p>);
  cleanupPage(context, rendered);
  let receipt = 0;
  let visibility = "visible";
  let tick: () => void = () => { throw new Error("Poll timer was not installed"); };
  Object.defineProperty(rendered.dom.window.document, "visibilityState", { configurable: true, get: () => visibility });
  Object.defineProperty(rendered.dom.window.performance, "now", { configurable: true, value: () => receipt });
  context.mock.method(rendered.dom.window, "setInterval", (handler: TimerHandler, delay?: number) => {
    assert.equal(delay, 5_000);
    assert.equal(typeof handler, "function");
    tick = () => { if (typeof handler === "function") handler(); };
    return 1;
  });
  context.mock.method(rendered.dom.window, "clearInterval", () => {});
  const page = <ToastProvider><SessionProvider initialSession={operationsSession()}><MemoryRouter><OperationsPage /></MemoryRouter></SessionProvider></ToastProvider>;
  await act(async () => rendered.root.render(strict ? <React.StrictMode>{page}</React.StrictMode> : page));
  await settlePage();
  return {
    rendered, requests,
    value: () => rendered.container.querySelector(`[data-provider-id="${operationsFixtureIds.providers[0]}"] .provider-pulse__rate strong`)?.textContent,
    setResponse: (next: () => Response | Promise<Response>) => { response = next; },
    setSample: (seconds: number, processed: number) => { receipt = seconds * 1_000; response = () => jsonResponse(snapshot(seconds, processed)); },
    poll: async (receivedAt?: number) => { if (receivedAt !== undefined) receipt = receivedAt; await act(async () => tick()); await settlePage(); },
    visibility: async (next: "visible" | "hidden") => {
      visibility = next;
      await act(async () => document.dispatchEvent(new rendered.dom.window.Event("visibilitychange")));
      await settlePage();
    },
  };
}

test("StrictMode and repeated responses do not invent zero or resample retained overview", async (context) => {
  const page = await setup(context, true);
  assert.equal(page.value(), "Measuring…");
  await page.poll(1_000);
  assert.equal(page.value(), "Measuring…");
  page.setSample(5, 150);
  await page.poll();
  assert.equal(page.value(), "10");
  await page.poll(10_000);
  assert.equal(page.value(), "10", "an identical response is not a new unchanged-count observation");
  page.setSample(10, 150);
  await page.poll();
  assert.equal(page.value(), "5", "the actual ten-second window includes the earlier progress");
});

test("paused and failed displays lose their rate and collect new samples only after a successful refresh", async (context) => {
  const page = await setup(context);
  page.setSample(5, 150);
  await page.poll();
  assert.equal(page.value(), "10");
  await act(async () => findButton(page.rendered, "Pause display").click());
  assert.equal(page.value(), "Unavailable");
  page.setSample(10, 200);
  await act(async () => findButton(page.rendered, "Resume display").click());
  await settlePage();
  assert.equal(page.value(), "Measuring…");
  page.setSample(15, 250);
  await page.poll();
  assert.equal(page.value(), "10");
  page.setResponse(() => jsonResponse({ error: "Status unavailable" }, 503));
  await page.poll(20_000);
  assert.equal(page.value(), "Unavailable");
  page.setSample(25, 350);
  await act(async () => findButton(page.rendered, "Refresh safe evidence").click());
  await settlePage();
  assert.equal(page.value(), "Measuring…");
});

test("pre-hidden in-flight results cannot seed rate history after the page becomes visible", async (context) => {
  const page = await setup(context);
  page.setSample(5, 150);
  await page.poll();
  const held = deferred<Response>();
  page.setResponse(() => held.promise);
  await page.poll(10_000);
  const requestCount = page.requests.length;
  await page.visibility("hidden");
  assert.equal(page.value(), "Unavailable");
  await page.visibility("visible");
  assert.equal(page.requests.length, requestCount, "visibility does not overlap the pending read");
  held.resolve(jsonResponse(snapshot(10, 200)));
  await settlePage();
  assert.equal(page.value(), "Unavailable", "the retained pre-hide response is not a new rate sample");
  page.setSample(15, 250);
  await page.poll();
  assert.equal(page.value(), "Measuring…");
  page.setSample(20, 300);
  await page.poll();
  assert.equal(page.value(), "10");
});

test("the existing poll expires a stale rate while a read is pending without another HTTP request", async (context) => {
  const page = await setup(context);
  page.setSample(5, 150);
  await page.poll();
  const held = deferred<Response>();
  page.setResponse(() => held.promise);
  await page.poll(10_000);
  assert.equal(page.value(), "10");
  const requestCount = page.requests.length;
  await page.poll(20_001);
  assert.equal(page.value(), "Unavailable");
  assert.equal(page.requests.length, requestCount);
  held.resolve(jsonResponse(snapshot(20, 300)));
  await settlePage();
  assert.equal(page.value(), "Measuring…");
});

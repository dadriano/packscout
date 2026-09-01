import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { unavailableProviderSourceMeasurements } from "@packscout/contracts";
import { cleanupPage, pageText, renderPage } from "../../testing/react-page-test.tsx";
import { operationSource, operationsOverview } from "../../testing/provider-source-operations-fixture.ts";
import { ProviderPulseOverview } from "./ProviderPulseOverview.tsx";
import { measurementTotal, pulseNeedsAttention, pulseState } from "./provider-pulse-presentation.ts";
import type { RecentRateReading } from "./provider-recent-rate.ts";

Object.assign(globalThis, { React });

test("recent processing rate is readable, explained, and only shown on running provider cards", async (context) => {
  const overview = operationsOverview();
  const providerId = overview.sources[0]!.providerId;
  const render = (reading: RecentRateReading) => <MemoryRouter><ProviderPulseOverview overview={overview} recentRates={{ [providerId]: reading }} canOperate={false} pendingKey={null} onCommand={() => {}} /></MemoryRouter>;
  const rendered = await renderPage(render({ state: "available", recordsPerSecond: 0.05, windowMilliseconds: 20_000, sampleCount: 5 }));
  cleanupPage(context, rendered);
  assert.equal(rendered.container.querySelectorAll(".provider-pulse__rate").length, 1);
  const band = rendered.container.querySelector(".provider-pulse__rate")!;
  assert.equal(band.querySelector("strong")!.textContent, "<0.1");
  assert.match(band.textContent!, /records\/sec/u);
  await act(async () => band.querySelector("button")!.focus());
  const tooltip = rendered.dom.window.document.querySelector('[role="tooltip"]')!;
  assert.match(tooltip.textContent!, /20 seconds from 5 status samples/u);
  assert.match(tooltip.textContent!, /not newly stored rows/u);
  assert.match(tooltip.textContent!, /request timing makes it approximate/u);
  await act(async () => rendered.root.render(render({ state: "measuring" })));
  assert.equal(rendered.container.querySelector(".provider-pulse__rate strong")!.textContent, "Measuring…");
  await act(async () => rendered.root.render(render({ state: "unavailable" })));
  assert.equal(rendered.container.querySelector(".provider-pulse__rate strong")!.textContent, "Unavailable");
});

test("provider overview puts problems first, keeps details collapsed, and links the correct provider data", async (context) => {
  const overview = operationsOverview();
  const rendered = await renderPage(<MemoryRouter><ProviderPulseOverview overview={overview} canOperate={false} pendingKey={null} onCommand={() => {}} /></MemoryRouter>);
  cleanupPage(context, rendered);
  const cards = [...rendered.container.querySelectorAll(".provider-pulse__card")];
  assert.equal(cards.length, 4);
  assert.match(cards[0]!.querySelector("h2")!.textContent!, /ClutchPacks/u);
  assert.deepEqual([...rendered.container.querySelectorAll("details")].map((details) => details.open), [false, false, false, false]);
  assert.equal(rendered.container.querySelectorAll(".provider-pulse__summary > div").length, 4);
  assert.ok(rendered.container.querySelector('a[href="/data/canonical?provider=courtyard"]'));
  assert.match(pageText(rendered), /All retained runs/u);
  assert.ok(![...rendered.container.querySelectorAll("button")].some((button) => button.textContent === "Run now"));
  const firstDetails = cards[0]!.querySelector("details")!;
  await act(async () => firstDetails.querySelector("summary")!.click());
  assert.equal(firstDetails.open, true);
  assert.equal(firstDetails.querySelectorAll("tbody tr").length, 10);
});

test("partial aggregates preserve available counts and missing provider data stays unavailable", async (context) => {
  const overview = operationsOverview();
  overview.sources = overview.sources.slice(0, 2);
  overview.sources[1]!.measurements = unavailableProviderSourceMeasurements("database_unreachable");
  const expected = measurementTotal(overview.sources, "storage");
  assert.equal(expected.value, 1_001_190);
  assert.equal(expected.coverage, "Partial · 1/2 providers");
  const rendered = await renderPage(<MemoryRouter><ProviderPulseOverview overview={overview} canOperate={false} pendingKey={null} onCommand={() => {}} /></MemoryRouter>);
  cleanupPage(context, rendered);
  assert.match(pageText(rendered), /Partial · 1\/2 providers/u);
  const missing = rendered.container.querySelector(`[data-provider-id="${overview.sources[1]!.providerId}"]`)!;
  assert.equal([...missing.querySelectorAll(".provider-pulse__metrics dd")].filter((value) => value.textContent?.startsWith("Unavailable")).length, 4);
  assert.match(missing.textContent!, /Database unreachable/u);
  assert.equal(measurementTotal([overview.sources[1]!], "records").value, null);
  const excessive = operationSource(0);
  if (excessive.measurements.records.state === "available") excessive.measurements.records.processed = Number.MAX_SAFE_INTEGER;
  assert.equal(measurementTotal([excessive, excessive], "records").value, null);
});

test("cached page and quarantine history disclose their older observation separately from fresh lease checks", async (context) => {
  const overview = operationsOverview();
  overview.sources = overview.sources.slice(0, 1);
  overview.refreshedAt = "2026-08-21T12:00:45.000Z";
  const activity = overview.sources[0]!.measurements.activity;
  assert.equal(activity.state, "available");
  if (activity.state !== "available") return;
  activity.measuredAt = overview.refreshedAt;
  activity.historyMeasuredAt = "2026-08-21T12:00:00.000Z";
  activity.importLease.heartbeatAt = overview.refreshedAt;
  activity.importLease.expiresAt = "2026-08-21T12:01:00.000Z";
  const rendered = await renderPage(<MemoryRouter><ProviderPulseOverview overview={overview} canOperate={false} pendingKey={null} onCommand={() => {}} /></MemoryRouter>);
  cleanupPage(context, rendered);
  const card = rendered.container.querySelector(".provider-pulse__card")!;
  assert.match(card.querySelector(".provider-pulse__card-overview")!.textContent!, /Page & quarantine checked 45s ago/u);
  const page = [...card.querySelectorAll(".provider-pulse__metrics > div")].find((metric) => metric.querySelector("dt")!.textContent?.startsWith("Last page"))!;
  assert.equal(page.querySelector("dd")!.textContent, "49s ago", "page age uses the displayed status time, not the cached history time");
  const times = [...card.querySelectorAll(".provider-pulse__details time")];
  assert.deepEqual(times.map((time) => time.getAttribute("datetime")), [activity.historyMeasuredAt, activity.measuredAt]);
  assert.match(times[0]!.parentElement!.textContent!, /Page & quarantine checked.*cached up to 60s/u);
  assert.match(times[1]!.parentElement!.textContent!, /Leases checked/u);
  for (const label of ["Last page", "Open quarantine"]) {
    const indicator = [...card.querySelectorAll("button")].find((button) => button.textContent?.startsWith(label))!;
    await act(async () => indicator.focus());
    const tooltip = rendered.dom.window.document.querySelector('[role="tooltip"]')!;
    assert.match(tooltip.textContent!, /cached for up to 60 seconds; newer/u);
  }
});

test("worker indicators do not claim running from missing, expired, or unavailable leases", () => {
  const source = operationSource(0);
  assert.equal(pulseState(source).label, "Retrying");
  assert.equal(source.measurements.activity.state, "available");
  if (source.measurements.activity.state !== "available") return;
  source.measurements.activity.importLease.state = "expired";
  assert.equal(pulseState(source).label, "Lease expired");
  assert.equal(pulseNeedsAttention(source), true);
  source.measurements.activity.importLease.state = "unowned";
  assert.equal(pulseState(source).label, "No import lease");
  source.measurements.activity = { state: "unavailable", reason: "query_failed" };
  assert.equal(pulseState(source).label, "Activity unverified");
  const paused = operationSource(2);
  paused.freshness.state = "stale";
  if (paused.measurements.activity.state === "available") paused.measurements.activity.quarantine.open = 0;
  assert.equal(pulseNeedsAttention(paused), false, "staleness alone does not alert on intentional pause");
});

test("unsupported configured adapters have distinct guidance from missing configuration", async (context) => {
  const overview = operationsOverview();
  const unsupported = operationSource(0, {
    configured: false, source: null, schedule: null, processor: null, activeRun: null,
    measurements: unavailableProviderSourceMeasurements("unsupported"),
  });
  const absent = operationSource(1, {
    configured: false, source: null, schedule: null, processor: null,
    measurements: unavailableProviderSourceMeasurements("not_configured"),
  });
  overview.sources = [unsupported, absent];
  const rendered = await renderPage(<MemoryRouter><ProviderPulseOverview overview={overview} canOperate={true} pendingKey={null} onCommand={() => {}} /></MemoryRouter>);
  cleanupPage(context, rendered);
  const card = rendered.container.querySelector(`[data-provider-id="${unsupported.providerId}"]`)!;
  assert.match(card.textContent!, /Unsupported adapter/u);
  assert.match(card.textContent!, /Source settings/u);
  assert.doesNotMatch(card.textContent!, /Not configured|Configure this provider|Configure source/u);
  assert.equal(card.querySelector(".provider-pulse__detail-facts dd")!.textContent, "Unavailable");
  const facts = new Map([...card.querySelectorAll(".provider-pulse__detail-facts > div")].map((fact) => [
    fact.querySelector("dt")!.textContent, fact.querySelector("dd")!.textContent,
  ]));
  for (const label of ["Latest run", "Schedule", "Next due"]) assert.equal(facts.get(label), "Unavailable");
  assert.equal(facts.get("Retries / failures"), "Unavailable / Unavailable");
  const indicator = [...card.querySelectorAll("button")].find((button) => button.textContent?.startsWith("Unsupported adapter"))!;
  await act(async () => indicator.focus());
  assert.match(rendered.dom.window.document.querySelector('[role="tooltip"]')!.textContent!, /has a configuration, but its adapter is not supported/u);
  const absentCard = rendered.container.querySelector(`[data-provider-id="${absent.providerId}"]`)!;
  assert.match(absentCard.textContent!, /Not configured/u);
  assert.match(absentCard.textContent!, /Configure this provider to begin importing/u);
  assert.equal(pulseNeedsAttention(unsupported), true);
});

test("distributed providers without managed request settings cannot start or expose legacy lifecycle controls", async (context) => {
  const overview = operationsOverview();
  const distributed = operationSource(0);
  distributed.source!.requestSizePolicy = "adapter_profile";
  distributed.source!.requestSettingsRevisionId = null;
  overview.sources = [distributed];
  const rendered = await renderPage(<MemoryRouter><ProviderPulseOverview overview={overview} canOperate pendingKey={null} onCommand={() => {}} /></MemoryRouter>);
  cleanupPage(context, rendered);
  const card = rendered.container.querySelector(`[data-provider-id="${distributed.providerId}"]`)!;
  await act(async () => card.querySelector("summary")!.click());
  const requestSettingsButton = [...card.querySelectorAll("button")].find((button) => button.textContent === "Request settings unavailable")!;
  assert.equal(requestSettingsButton.disabled, true);
  assert.match(card.textContent!, /Run now requires verified request settings and an authorized worker handoff/u);
  assert.ok(![...card.querySelectorAll("button")].some((button) => /^(Pause|Resume)$/u.test(button.textContent ?? "")));
});

test("terminal and paused state take precedence over historical retries and stale running evidence", () => {
  const source = operationSource(0);
  source.processor!.retryCount = 7;
  source.processor!.activity = "action_required";
  source.processor!.phase = "action_required";
  if (source.measurements.activity.state === "available") source.measurements.activity.importLease.state = "expired";
  assert.equal(pulseState(source).label, "Action required");
  source.processor!.activity = "paused";
  source.processor!.phase = "paused";
  assert.equal(pulseState(source).label, "Paused");
  source.processor!.activity = "running";
  source.source!.lifecycle = "paused";
  assert.equal(pulseState(source).label, "Paused");
  source.source!.lifecycle = "disabled";
  assert.equal(pulseState(source).label, "Disabled");
  source.source!.lifecycle = "active";
  source.source!.pauseRequested = true;
  assert.equal(pulseState(source).label, "Pause requested");
});

test("unreachable runtime does not turn missing history into zero while count-only failures preserve run facts", async (context) => {
  const overview = operationsOverview();
  const unreachable = operationSource(0, {
    activeRun: null, latestRun: null,
    measurements: unavailableProviderSourceMeasurements("database_unreachable"),
  });
  unreachable.schedule!.nextDueAt = null;
  unreachable.processor!.activity = "action_required";
  unreachable.processor!.actionRequiredCode = "PROVIDER_DATABASE_UNREACHABLE";
  const countsFailed = operationSource(3);
  countsFailed.measurements.storage = { state: "unavailable", reason: "query_failed" };
  countsFailed.measurements.records = { state: "unavailable", reason: "query_failed" };
  overview.sources = [unreachable, countsFailed];
  const rendered = await renderPage(<MemoryRouter><ProviderPulseOverview overview={overview} canOperate={false} pendingKey={null} onCommand={() => {}} /></MemoryRouter>);
  cleanupPage(context, rendered);
  const unavailableCard = rendered.container.querySelector(`[data-provider-id="${unreachable.providerId}"]`)!;
  assert.equal(pulseState(unreachable).label, "Database unavailable");
  assert.match(unavailableCard.textContent!, /Quality unavailable/u);
  assert.doesNotMatch(unavailableCard.textContent!, /Healthy quality|Degraded quality/u);
  assert.doesNotMatch(unavailableCard.textContent!, /Administrator recovery required|Disable this source/u);
  const indicator = [...unavailableCard.querySelectorAll("button")].find((button) => button.textContent?.startsWith("Database unavailable"))!;
  await act(async () => indicator.focus());
  assert.match(rendered.dom.window.document.querySelector('[role="tooltip"]')!.textContent!, /ingestion may still be running/u);
  const factsFor = (providerId: string) => new Map([...rendered.container.querySelectorAll(`[data-provider-id="${providerId}"] .provider-pulse__detail-facts > div`)].map((fact) => [fact.querySelector("dt")!.textContent, fact.querySelector("dd")!.textContent]));
  const missingFacts = factsFor(unreachable.providerId);
  assert.equal(missingFacts.get("Latest run"), "Unavailable");
  assert.equal(missingFacts.get("Next due"), "Unavailable");
  assert.equal(missingFacts.get("Phase / wait"), "Unavailable");
  assert.equal(missingFacts.get("Retries / failures"), "Unavailable / Unavailable");
  assert.equal(missingFacts.get("Schedule"), "Every 5m", "known central schedule remains visible");
  const knownFacts = factsFor(countsFailed.providerId);
  assert.equal(knownFacts.get("Latest run"), "Failed");
  assert.match(rendered.container.querySelector(`[data-provider-id="${countsFailed.providerId}"]`)!.textContent!, /Disable this source/u, "real processor failures keep recovery guidance");
  assert.equal(knownFacts.get("Retries / failures"), "0 / 2", "a totals failure does not erase independently available activity");
});

test("provider metric and state explanations are available on focus with associated tooltips", async (context) => {
  const overview = operationsOverview();
  const rendered = await renderPage(<MemoryRouter><ProviderPulseOverview overview={overview} canOperate={false} pendingKey={null} onCommand={() => {}} /></MemoryRouter>);
  cleanupPage(context, rendered);
  const stored = [...rendered.container.querySelectorAll("button")].find((button) => button.textContent?.startsWith("Stored rows"))!;
  await act(async () => stored.focus());
  const explanation = rendered.dom.window.document.getElementById(stored.getAttribute("aria-describedby")!);
  assert.equal(explanation?.getAttribute("role"), "tooltip");
  assert.match(explanation!.textContent!, /including child and relationship rows/u);
  await act(async () => stored.dispatchEvent(new rendered.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(rendered.dom.window.document.querySelector('[role="tooltip"]'), null);
  const action = [...rendered.container.querySelectorAll("button")].find((button) => button.textContent?.startsWith("Action required"))!;
  await act(async () => action.focus());
  assert.match(rendered.dom.window.document.querySelector('[role="tooltip"]')!.textContent!, /cannot recover automatically/u);
});

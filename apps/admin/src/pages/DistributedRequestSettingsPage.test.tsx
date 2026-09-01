import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { act } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { SessionProvider } from "../providers/session.tsx";
import { ToastProvider } from "../providers/toast.tsx";
import { changeControl, cleanupPage, findButton, jsonResponse, pageText, renderPage, settlePage, stubFetch } from "../testing/react-page-test.tsx";
import { diagnosticHistory, operationsDetail, operationsSession } from "../testing/provider-source-operations-fixture.ts";
import { ProviderDetailPage } from "./ProviderDetailPage.tsx";

Object.assign(globalThis, { React });
const revision = (value: number) => `83000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
function detailFixture() {
  const detail = operationsDetail();
  detail.source.source!.requestSizePolicy = "request_settings_revision";
  detail.source.source!.requestSettingsRevisionId = revision(1);
  detail.source.source!.recordsPerRequest = 1_000;
  detail.source.activeRun!.recordsPerRequest = 100;
  return detail;
}
async function render(detail: ReturnType<typeof detailFixture>, session = operationsSession()) {
  return renderPage(<ToastProvider><SessionProvider initialSession={session}>
    <MemoryRouter initialEntries={[`/providers/${detail.source.providerId}`]}>
      <Routes><Route path="/providers/:providerId" element={<ProviderDetailPage />} /></Routes>
    </MemoryRouter>
  </SessionProvider></ToastProvider>);
}

test("distributed request editor saves its independent revision while preserving active-run limits and hiding unsupported actions", async (context) => {
  let detail = detailFixture();
  const bodies: unknown[] = [];
  stubFetch(context, ({ input, init }) => {
    const path = String(input);
    if (path.endsWith("/records-per-request")) {
      bodies.push(JSON.parse(String(init?.body)));
      detail = structuredClone(detail);
      detail.source.source!.requestSettingsRevisionId = revision(2);
      detail.source.source!.recordsPerRequest = 1_250;
      return jsonResponse({ requestSettingsRevisionId: revision(2), recordsPerRequest: 1_250 });
    }
    return jsonResponse(path.includes("/diagnostics") ? { ...diagnosticHistory(), snapshot: detail.source } : detail);
  });
  const rendered = await render(detail);
  cleanupPage(context, rendered); await settlePage();
  assert.match(pageText(rendered), /Current run: 100\. Next run: 1,000\./);
  assert.equal(findButton(rendered, "Run now").disabled, false);
  assert.equal(rendered.container.querySelector("#provider-source-interval"), null);
  assert.ok(![...rendered.container.querySelectorAll("button")].some((button) => /^(Test source|Save timing|Pause|Resume)$/.test(button.textContent ?? "")));
  await act(async () => {
    changeControl(rendered, "provider-source-records-per-request", "1250");
  });
  await act(async () => { findButton(rendered, "Save request size").closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await settlePage();
  assert.deepEqual(bodies, [{ expectedConfigVersionId: detail.source.source!.sourceRevisionId,
    expectedRequestSettingsRevisionId: revision(1), recordsPerRequest: 1_250 }]);
  assert.match(pageText(rendered), /Saved\. Applies to the next import run\./);
  assert.match(pageText(rendered), /Current run: 100\. Next run: 1,250\./);
  await act(async () => { findButton(rendered, "Save request size").closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await settlePage();
  assert.equal((bodies[1] as { expectedRequestSettingsRevisionId: string }).expectedRequestSettingsRevisionId, revision(2));
});

test("distributed conflict retains the dirty value until explicit reload and uses the refreshed settings revision", async (context) => {
  let detail = detailFixture();
  let conflicts = true;
  const bodies: unknown[] = [];
  stubFetch(context, ({ input, init }) => {
    const path = String(input);
    if (path.endsWith("/records-per-request")) {
      bodies.push(JSON.parse(String(init?.body)));
      return conflicts ? jsonResponse({ error: "Changed in another session", code: "SOURCE_CONFLICT" }, 409)
        : jsonResponse({ requestSettingsRevisionId: revision(3), recordsPerRequest: 1_250 });
    }
    return jsonResponse(path.includes("/diagnostics") ? { ...diagnosticHistory(), snapshot: detail.source } : detail);
  });
  const rendered = await render(detail); cleanupPage(context, rendered); await settlePage();
  await act(async () => { changeControl(rendered, "provider-source-records-per-request", "1250"); });
  await act(async () => { findButton(rendered, "Save request size").closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await settlePage();
  assert.equal((rendered.container.querySelector("#provider-source-records-per-request") as HTMLInputElement).value, "1250");
  detail = structuredClone(detail);
  detail.source.source!.recordsPerRequest = 2_000;
  detail.source.source!.requestSettingsRevisionId = revision(2);
  await act(async () => { findButton(rendered, "Reload current value").click(); });
  await settlePage();
  assert.equal((rendered.container.querySelector("#provider-source-records-per-request") as HTMLInputElement).value, "2000");
  conflicts = false;
  await act(async () => { changeControl(rendered, "provider-source-records-per-request", "1250"); });
  await act(async () => { findButton(rendered, "Save request size").closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await settlePage();
  assert.equal((bodies[1] as { expectedRequestSettingsRevisionId: string }).expectedRequestSettingsRevisionId, revision(2));
});

test("unavailable distributed settings retain known active-run evidence but expose no save action", async (context) => {
  const detail = detailFixture();
  detail.source.source!.recordsPerRequest = null;
  detail.source.source!.requestSettingsRevisionId = null;
  const requests = stubFetch(context, ({ input }) => jsonResponse(String(input).includes("/diagnostics")
    ? { ...diagnosticHistory(), snapshot: detail.source } : detail));
  const rendered = await render(detail); cleanupPage(context, rendered); await settlePage();
  assert.match(pageText(rendered), /Current run: 100\. Next run: unavailable\./);
  assert.match(pageText(rendered), /Current request settings are unavailable/);
  assert.equal(findButton(rendered, "Request settings unavailable").disabled, true);
  assert.equal(rendered.container.querySelector("#provider-source-records-per-request"), null);
  assert.ok(![...rendered.container.querySelectorAll("button")].some((button) => /Save request size/.test(button.textContent ?? "")));
  assert.ok(requests.every(({ init }) => !init?.method || init.method === "GET"));
});

test("uninitialized provider shows its verified default but cannot request a new run before worker handoff", async (context) => {
  const detail = detailFixture();
  detail.source.source!.requestSizePolicy = "adapter_profile";
  detail.source.source!.requestSettingsRevisionId = null;
  const requests = stubFetch(context, ({ input }) => jsonResponse(String(input).includes("/diagnostics")
    ? { ...diagnosticHistory(), snapshot: detail.source } : detail));
  const rendered = await render(detail); cleanupPage(context, rendered); await settlePage();
  assert.match(pageText(rendered), /verified adapter default is 1,000 records/);
  assert.match(pageText(rendered), /Run now requires verified request settings and an authorized worker handoff/);
  assert.equal(findButton(rendered, "Request settings unavailable").disabled, true);
  assert.equal(rendered.container.querySelector("#provider-source-records-per-request"), null);
  assert.ok(requests.every(({ init }) => !init?.method || init.method === "GET"));
});

test("distributed failure guidance does not advertise legacy lifecycle actions or imply a setting edit is recovery", async (context) => {
  const detail = detailFixture();
  detail.source.processor!.activity = "action_required";
  detail.source.processor!.phase = "action_required";
  detail.source.processor!.actionRequiredCode = "PROVIDER_IMPORT_EXECUTION_FAILED";
  stubFetch(context, ({ input }) => jsonResponse(String(input).includes("/diagnostics")
    ? { ...diagnosticHistory(), snapshot: detail.source } : detail));
  const rendered = await render(detail); cleanupPage(context, rendered); await settlePage();
  assert.match(pageText(rendered), /Changing request size does not restart work or clear the failure/);
  assert.doesNotMatch(pageText(rendered), /Disable this source|Activate paused|Test source while disabled/);
  assert.equal(findButton(rendered, "Resolve before run").disabled, true);
  assert.ok(findButton(rendered, "Save request size"));
});

import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { ProviderConfigurationSummary } from "@packscout/contracts";
import { ProviderForm } from "./ProviderForm.tsx";
import { ProviderLedger } from "./ProviderLedger.tsx";

const provider: ProviderConfigurationSummary = {
  id: "00000000-0000-4000-8000-000000000020",
  platformKey: "fanatics",
  displayName: "Fanatics cards",
  state: "draft",
  latestRevision: {
    id: "00000000-0000-4000-8000-000000000021",
    version: 2,
    adapterKey: "cursor-http",
    endpoint: "https://feed.packscout.test/cards",
    endpointHost: "feed.packscout.test",
    authMode: "bearer",
    hasBearerSecret: true,
    scheduleSeconds: 300,
    staleAfterSeconds: 900,
    testedAt: null,
    createdAt: "2026-08-06T12:00:00.000Z",
    lastConnectionTest: null,
  },
  activeRevisionId: null,
  nextRunAt: null,
  createdAt: "2026-08-06T12:00:00.000Z",
  updatedAt: "2026-08-06T12:00:00.000Z",
};

test("provider ledger exposes operational evidence with masked authentication", () => {
  Object.assign(globalThis, { React });
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <ProviderLedger items={[{
        provider,
        health: {
          providerId: provider.id,
          freshnessState: "stale",
          qualityState: "warning",
          activeRun: { id: "run-1", state: "running" },
          latestRun: { id: "run-1", state: "running" },
          lastHeadReachedAt: null,
          nextDueAt: "2026-08-06T12:05:00.000Z",
          openQuarantineCount: 2,
          consecutiveFailures: 0,
          latestFailureClass: null,
          recoveryHint: "Run through provider head.",
        },
      }]} />
    </MemoryRouter>,
  );
  assert.match(html, /Fanatics cards/);
  assert.match(html, /Bearer · configured/);
  assert.match(html, /Stale/);
  assert.match(html, /Warning/);
  assert.doesNotMatch(html, /bearerSecret|authorization/i);
});

test("revision form preserves a stored bearer credential without rendering its value", () => {
  Object.assign(globalThis, { React });
  const html = renderToStaticMarkup(
    <ProviderForm
      provider={provider}
      pending={false}
      error={null}
      onSubmit={async () => undefined}
    />,
  );
  assert.match(html, /Save new revision/);
  assert.match(html, /Leave blank to preserve the stored credential/);
  assert.match(html, /type="password"/);
  assert.doesNotMatch(html, /value="[^"]+"[^>]*type="password"/);
  assert.doesNotMatch(html, /secret-value|bearerSecret/);
});

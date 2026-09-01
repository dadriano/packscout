import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { ProviderTransactionClient } from "./provider-database.ts";
import { providerMixedPageDigest } from "./provider-mixed-page-contract.ts";
import { requestSettingsInitializationAdmitted } from "./provider-request-settings-initialization.ts";

test("initialization boundary refuses checkpoint, failed-parent, last-page, generation/fence, live-work and deadline drift", async () => {
  const cursor = { value: "synthetic-checkpoint" }; const hash = providerMixedPageDigest(cursor);
  const configId = randomUUID(); const parentId = randomUUID(); const now = new Date();
  const fixture = () => {
    const state = {
      runtime: { state_generation: 15n, source_cursor: cursor, source_cursor_hash: hash },
      parent: { id: parentId, state: "failed", finished_at: now, page_count: 7,
        config_version_id: configId, config_version_number: 4n, final_cursor: cursor, final_cursor_hash: hash },
      page: { page_number: 7, next_cursor: cursor, next_cursor_hash: hash }, activeRuns: 0, commands: 0,
    };
    const transaction = { provider_runtime: { findUniqueOrThrow: async () => state.runtime },
      provider_runs: { findUnique: async () => state.parent, count: async () => state.activeRuns },
      provider_run_pages: { findFirst: async () => state.page }, control_commands: { count: async () => state.commands },
      $queryRaw: async () => [{ now }],
    } as unknown as ProviderTransactionClient;
    return { state, transaction };
  };
  const input = { configVersionId: configId, configVersionNumber: 4n, importFence: 9n,
    boundary: { expectedGeneration: 15n, expectedCursorFingerprint: hash, expectedImportFence: 9n,
      parentRunId: parentId, deadline: new Date(now.getTime() + 1000) } };
  assert.equal(await requestSettingsInitializationAdmitted(fixture().transaction, input), true);
  const mutations = [
    (s: ReturnType<typeof fixture>["state"]) => { s.runtime.state_generation++; },
    (s: ReturnType<typeof fixture>["state"]) => { s.runtime.source_cursor = { value: "changed-runtime" }; },
    (s: ReturnType<typeof fixture>["state"]) => { s.parent.state = "running"; },
    (s: ReturnType<typeof fixture>["state"]) => { s.parent.config_version_id = randomUUID(); },
    (s: ReturnType<typeof fixture>["state"]) => { s.parent.config_version_number++; },
    (s: ReturnType<typeof fixture>["state"]) => { s.parent.final_cursor = { value: "changed-parent" }; },
    (s: ReturnType<typeof fixture>["state"]) => { s.parent.final_cursor_hash = "a".repeat(64); },
    (s: ReturnType<typeof fixture>["state"]) => { s.page.page_number++; },
    (s: ReturnType<typeof fixture>["state"]) => { s.page.next_cursor = { value: "changed-page" }; },
    (s: ReturnType<typeof fixture>["state"]) => { s.page.next_cursor_hash = "a".repeat(64); },
    (s: ReturnType<typeof fixture>["state"]) => { s.activeRuns++; },
    (s: ReturnType<typeof fixture>["state"]) => { s.commands++; },
  ];
  for (const mutate of mutations) { const f = fixture(); mutate(f.state);
    assert.equal(await requestSettingsInitializationAdmitted(f.transaction, input), false); }
  assert.equal(await requestSettingsInitializationAdmitted(fixture().transaction, { ...input, importFence: 10n }), false);
  assert.equal(await requestSettingsInitializationAdmitted(fixture().transaction, { ...input,
    boundary: { ...input.boundary, deadline: now } }), false);
});

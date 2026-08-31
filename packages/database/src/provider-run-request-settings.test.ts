import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { ProviderTransactionClient } from "./provider-database.ts";
import { providerMixedPageDigest } from "./provider-mixed-page-contract.ts";
import { recoveryProviderRequestSettings } from "./provider-run-request-settings.ts";

test("retry authority compares full terminal checkpoint, config and immutable pin, not only a stored hash", async () => {
  const cursor = { value: "synthetic-saved-page" };
  const hash = providerMixedPageDigest(cursor); const revisionId = randomUUID(); const configId = randomUUID();
  const original = { state: "failed", finished_at: new Date(), records_per_request: 100,
    request_settings_revision_id: revisionId, config_version_id: configId, config_version_number: 3n,
    final_cursor: cursor, final_cursor_hash: hash };
  let parent: typeof original | null = original;
  const transaction = { provider_runs: { findUnique: async () => parent } } as unknown as ProviderTransactionClient;
  const input = { parentRunId: randomUUID(), configVersionId: configId, configVersionNumber: 3n,
    cursor, cursorFingerprint: hash, expectedCursorFingerprint: hash };
  assert.deepEqual(await recoveryProviderRequestSettings(transaction, input), { id: revisionId, recordsPerRequest: 100 });
  for (const patch of [
    { state: "running" }, { state: "queued" }, { finished_at: null },
    { records_per_request: null }, { request_settings_revision_id: null },
    { config_version_id: randomUUID() }, { config_version_number: 4n },
    { final_cursor_hash: "a".repeat(64) }, { final_cursor: { value: "different-full-envelope" } },
  ]) {
    parent = { ...original, ...patch } as typeof original;
    assert.equal(await recoveryProviderRequestSettings(transaction, input), null);
  }
  parent = original;
  assert.equal(await recoveryProviderRequestSettings(transaction, { ...input, cursor: { value: "changed-runtime-envelope" } }), null);
  assert.equal(await recoveryProviderRequestSettings(transaction, { ...input, expectedCursorFingerprint: undefined }), null);
  parent = null;
  assert.equal(await recoveryProviderRequestSettings(transaction, input), null);
});

test("retry keeps explicit unmanaged null pins only while settings remain uninitialized", async () => {
  let initialized = false;
  const configId = randomUUID();
  const transaction = { provider_runs: { findUnique: async () => ({ state: "failed", finished_at: new Date(),
    records_per_request: null, request_settings_revision_id: null, config_version_id: configId,
    config_version_number: 1n, final_cursor: null, final_cursor_hash: null }) },
  provider_request_settings: { findUnique: async () => initialized ? { active_revision_id: randomUUID() } : null },
  } as unknown as ProviderTransactionClient;
  const input = { parentRunId: randomUUID(), configVersionId: configId, configVersionNumber: 1n,
    cursor: null, cursorFingerprint: null, expectedCursorFingerprint: null };
  assert.equal(await recoveryProviderRequestSettings(transaction, input), null);
  assert.deepEqual(await recoveryProviderRequestSettings(transaction, { ...input, requestSettingsPolicy: "unmanaged" }),
    { id: null, recordsPerRequest: null });
  initialized = true;
  assert.equal(await recoveryProviderRequestSettings(transaction, { ...input, requestSettingsPolicy: "unmanaged" }), null);
});

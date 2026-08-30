import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const centralModule = await tsImport("./courtyard-response-budget-handoff-central.mts", import.meta.url);
const plan = await tsImport("./courtyard-response-budget-handoff-plan.mts", import.meta.url);
const { handoffDigest } = await tsImport("./collector-crypt-checkpoint-handoff-plan.mts", import.meta.url);
const { providerMixedPageCanonicalBytes } = await tsImport("@packscout/database", import.meta.url);
const { DATAFORREST_EVENTS_V1_ENDPOINT: endpoint } = await tsImport("@packscout/contracts", import.meta.url);
const p = plan.courtyardHandoff; const operationId = "26c70381-925a-5228-87be-4e6b862fa508";
const providerId = "eeba923b-3d0f-53bc-9006-d84fab651824"; const operatorId = "072d6d2f-1b3b-4363-8a91-422985cad740";
const nextConfigId = plan.courtyardHandoffId(operationId, "config");
const cursor = { sourceInstanceId: providerId, sourceRevisionId: p.previousConfigId, sourceTypeKey: "dataforrest-events-v1",
  adapterVersion: p.previousAdapter, cursorCodecKey: "dataforrest-cursor-v1", cursorGeneration: 1, value: "private-synthetic-checkpoint" };

// Only this exact synthetic old-envelope byte sequence receives the protected live pin.
// Every other hash is real; production hashing/re-enveloping is covered separately without mocking.
function fixtureFingerprint(t) {
  const original = crypto.createHash; const exact = providerMixedPageCanonicalBytes(cursor);
  t.mock.method(crypto, "createHash", (...args) => {
    const hash = original(...args); const chunks = []; const update = hash.update.bind(hash); const digest = hash.digest.bind(hash);
    hash.update = (value, ...rest) => { chunks.push(Buffer.from(value)); update(value, ...rest); return hash; };
    hash.digest = (...args) => args[0] === "hex" && Buffer.concat(chunks).equals(exact) ? p.cursorHash : digest(...args);
    return hash;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}
function harness() {
  const credential = (kind, id) => ({ id, provider_id: providerId, credential_kind: kind, lifecycle: "active", activated_at: new Date("2026-01-01"),
    retired_at: null, revoked_at: null, ciphertext: new Uint8Array([1]), nonce: new Uint8Array(12), auth_tag: new Uint8Array(16), key_version: 1 });
  const source = credential("source", "3cb2cbd8-9a15-4720-b9b4-891c01ec43f5");
  const node = { id: "b4e8f555-bd9d-4f57-a49c-e1f0f59ec3c5", enabled: true, node_role: "primary", host: "127.0.0.1", port: 55433,
    database_name: p.databaseName, ssl_mode: "disable", row_version: 1n, credential: credential("database", "aa65c3fc-b847-4c43-a033-f52aa7c8ca7a") };
  let store = { source, provider: { id: providerId, organization_id: p.organizationId, provider_key: p.providerKey, lifecycle: "active",
    active_config_version_id: p.previousConfigId, row_version: 7n, topology_version: 1n, database_nodes: [node] },
    versions: [{ id: p.previousConfigId, provider_id: providerId, version_number: 2n, adapter_key: p.previousAdapter,
      endpoint_url: endpoint, source_credential_version_id: source.id, expires_at: null, configuration: { platform: p.providerKey },
      schedule_seconds: 60, stale_after_seconds: 300, created_by_operator_id: operatorId }, { id: "44444444-4444-4444-8444-444444444444", version_number: 1n }], audits: [], proofs: [], cas: 1 };
  const writes = []; const sql = [];
  function client(s, log) {
    return {
      provider_config_versions: { findUniqueOrThrow: async () => ({ ...structuredClone(s.versions[0]), source_credential: structuredClone(s.source), provider: structuredClone(s.provider) }),
        findMany: async () => structuredClone(s.versions), create: async ({ data }) => { s.versions.push(data); log.push("config"); return data; } },
      audit_events: { findUnique: async ({ where }) => structuredClone(s.audits.find((a) => a.id === where.id) ?? null),
        create: async ({ data }) => { s.audits.push(data); log.push("audit"); return data; } },
      provider_connection_tests: { create: async ({ data }) => { s.proofs.push(data); log.push("proof"); return data; } },
      operator_memberships: { findFirst: async () => ({ operator_id: operatorId }) },
      providers: { updateMany: async ({ where, data }) => { log.push("activate"); assert.equal(where.active_config_version_id, p.previousConfigId);
        assert.equal(where.row_version, s.provider.row_version); if (s.cas !== 1) return { count: 0 };
        s.provider.active_config_version_id = data.active_config_version_id; s.provider.row_version += 1n; return { count: 1 }; } },
      $queryRaw: async (strings) => { const query = strings.join("?"); sql.push(query); return query.includes("target_digest") ? [{ digest: "a".repeat(64) }] : []; },
      $executeRaw: async (strings) => { sql.push(strings.join("?")); return 1; },
    };
  }
  const central = new Proxy({}, { get(_, key) {
    if (key === "$transaction") return async (action, options) => { assert.equal(options.isolationLevel, "Serializable");
      const copy = structuredClone(store); const pending = []; const result = await action(client(copy, pending)); store = copy; writes.push(...pending); return result; };
    return client(store, writes)[key];
  } });
  return { central, writes, sql, snapshot: () => structuredClone(store), mutate: (action) => action(store) };
}
async function inputs(h) {
  const authority = await centralModule.readCourtyardHandoffAuthority(h.central, operationId);
  const checkpoint = { runtimeState: "paused", generation: "22", cachedConfigId: p.previousConfigId, cachedConfigNumber: "2",
    cursor, cursorHash: p.cursorHash, runHistoryHash: "f".repeat(64), runCount: 82, quarantineCount: 684, ledgerSequence: "1700776",
    run: { id: p.runId, fence: "82", pageCount: 2302, accepted: 230045, duplicates: 0, quarantines: 155,
      materialChanges: 230045, state: "failed", failureCode: p.failureCode, finishedAt: p.finishedAt, finalCursor: cursor, finalCursorHash: p.cursorHash },
    lastPage: { id: operationId } };
  const receipt = { kind: "courtyard_terminal_response_budget", operationId, providerId, operatorId, nextConfigId,
    authorityDigest: authority.authorityDigest, checkpointDigest: handoffDigest(plan.retainedCourtyardCheckpoint(checkpoint)),
    entryRowVersion: "32000", failureCode: p.failureCode, finishedAt: p.finishedAt, previousCursorHash: p.cursorHash };
  const migrated = plan.reEnvelopeCourtyardCursor({ cursor, cursorHash: p.cursorHash, providerId, nextConfigId });
  const sourceProof = { checkKind: "courtyard_response_budget_parser_mapper_inspection", adapterKey: p.nextAdapter, providerId, nextConfigId,
    savedCursorHash: p.cursorHash, opaqueValueHash: migrated.opaqueValueHash, status: 200, recordCount: 100, adapterInvalid: 0,
    mapperQuarantined: 0, collectibleValidated: 100, canonicalQuarantined: 0, requestedRecords: 100, maximumResponseBytes: 33554432, maximumJsonNodes: 640000,
    responseBytes: 300000, durationMilliseconds: 20, checkedAt: new Date().toISOString() };
  return { central: h.central, authority, checkpoint, receipt, sourceProof, migrated };
}
test("Courtyard central stages inactive once, activates only prepared checkpoint last, and replays after lost release/output", async (t) => {
  fixtureFingerprint(t); const h = harness(); const input = await inputs(h);
  await centralModule.stageCourtyardHandoff(input); await centralModule.stageCourtyardHandoff(input);
  assert.deepEqual(h.writes, ["config", "proof", "audit"]); assert.equal(h.snapshot().provider.active_config_version_id, p.previousConfigId);
  assert.equal(h.snapshot().proofs[0].test_kind, "activation"); assert.equal(h.sql.some((q) => q.includes("assert_provider_activation")), false);
  assert.deepEqual(h.snapshot().proofs[0].record_counts, { sourceRecords: 100, canonicalValidCollectibles: 100,
    canonicalQuarantined: 0, mapperQuarantined: 0 });
  await assert.rejects(centralModule.activateCourtyardHandoffLast(input), /COURTYARD_ACTIVATION_NOT_PREPARED/u);
  const prepared = { ...input.checkpoint, cachedConfigId: nextConfigId, cachedConfigNumber: "3", cursor: input.migrated.cursor, cursorHash: input.migrated.cursorHash };
  await centralModule.activateCourtyardHandoffLast({ ...input, checkpoint: prepared });
  await centralModule.activateCourtyardHandoffLast({ ...input, checkpoint: prepared });
  assert.equal(h.snapshot().provider.active_config_version_id, nextConfigId); assert.equal(h.writes.filter((v) => v === "activate").length, 1);
  assert.equal(h.snapshot().versions.length, 3); assert.equal(h.snapshot().proofs.length, 1);
  assert.equal(JSON.stringify(h.snapshot().audits).includes(cursor.value), false);
});
test("Courtyard central staging and final CAS reject authority/history drift with transactional rollback", async (t) => {
  fixtureFingerprint(t); const h = harness(); const input = await inputs(h);
  await assert.rejects(centralModule.stageCourtyardHandoff({ ...input, checkpoint: { ...input.checkpoint, ledgerSequence: "1700777" } }));
  assert.deepEqual(h.writes, []); await centralModule.stageCourtyardHandoff(input);
  const prepared = { ...input.checkpoint, cachedConfigId: nextConfigId, cachedConfigNumber: "3", cursor: input.migrated.cursor, cursorHash: input.migrated.cursorHash };
  h.mutate((s) => { s.cas = 0; }); const before = h.snapshot();
  await assert.rejects(centralModule.activateCourtyardHandoffLast({ ...input, checkpoint: prepared }), /COURTYARD_CENTRAL_CAS_FAILED/u);
  assert.deepEqual(h.snapshot(), before); assert.equal(h.writes.includes("activate"), false);
  h.mutate((s) => { s.cas = 1; s.provider.row_version += 1n; });
  await assert.rejects(centralModule.activateCourtyardHandoffLast({ ...input, checkpoint: prepared }), /COURTYARD_CENTRAL_CAS_FAILED/u);
  h.mutate((s) => { s.source.nonce[0] = 1; });
  await assert.rejects(centralModule.readCourtyardHandoffAuthority(h.central, operationId), /COURTYARD_STAGED_AUTHORITY_CHANGED/u);
});

test("Courtyard central authority refuses crossed organization/provider, route, credential and immutable config pins before writes", async () => {
  const changes = [
    (s) => { s.provider.id = operatorId; }, (s) => { s.provider.organization_id = operatorId; },
    (s) => { s.provider.provider_key = "collector_crypt"; }, (s) => { s.provider.lifecycle = "disabled"; },
    (s) => { s.provider.database_nodes[0].host = "remote.invalid"; },
    (s) => { s.provider.database_nodes[0].port = 55434; },
    (s) => { s.provider.database_nodes[0].database_name = "packscout_collector_crypt"; },
    (s) => { s.provider.database_nodes[0].ssl_mode = "require"; },
    (s) => { s.provider.database_nodes[0].enabled = false; },
    (s) => { s.provider.database_nodes[0].credential.provider_id = operatorId; },
    (s) => { s.provider.database_nodes[0].credential.lifecycle = "revoked"; },
    (s) => { s.source.provider_id = operatorId; }, (s) => { s.source.lifecycle = "retired"; },
    (s) => { s.source.activated_at = new Date("2100-01-01"); },
    (s) => { s.versions[0].adapter_key = p.nextAdapter; },
    (s) => { s.versions[0].version_number = 1n; },
    (s) => { s.versions[0].configuration = { platform: "phygitals" }; },
    (s) => { s.versions[0].endpoint_url = "https://other.invalid/events"; },
    (s) => { s.versions[0].expires_at = new Date(); },
    (s) => { s.provider.active_config_version_id = operatorId; },
  ];
  for (const change of changes) {
    const h = harness(); h.mutate(change);
    await assert.rejects(centralModule.readCourtyardHandoffAuthority(h.central, operationId), /COURTYARD_CENTRAL_AUTHORITY_CHANGED/u);
    assert.deepEqual(h.writes, []);
  }
});

test("Courtyard stage cannot use stale/unbound proof; crash after inactive staging retains exact proof and history", async (t) => {
  fixtureFingerprint(t); const h = harness(); const input = await inputs(h);
  for (const change of [{ adapterKey: p.previousAdapter }, { nextConfigId: operatorId },
    { opaqueValueHash: "c".repeat(64) }, { responseBytes: 33554433 },
    { checkedAt: "2020-01-01T00:00:00.000Z" }]) {
    await assert.rejects(centralModule.stageCourtyardHandoff({ ...input, sourceProof: { ...input.sourceProof, ...change } }));
    assert.deepEqual(h.writes, []);
  }
  const oldCheckpoint = structuredClone(input.checkpoint);
  await centralModule.stageCourtyardHandoff(input);
  const staged = h.snapshot();
  assert.equal(staged.provider.active_config_version_id, p.previousConfigId);
  assert.equal(staged.versions.find((v) => v.id === nextConfigId).version_number, 3n);
  assert.deepEqual(input.checkpoint, oldCheckpoint);
  for (const change of [{ runHistoryHash: "1".repeat(64) }, { pageHistoryHash: "2".repeat(64) },
    { quarantineHistoryHash: "3".repeat(64) }, { ledgerSequence: "changed" }]) {
    await assert.rejects(centralModule.stageCourtyardHandoff({ ...input, checkpoint: { ...input.checkpoint, ...change } }));
    assert.deepEqual(h.snapshot(), staged);
  }
  await centralModule.stageCourtyardHandoff({ ...input, sourceProof: { ...input.sourceProof, checkedAt: "2020-01-01T00:00:00.000Z" } });
  assert.deepEqual(h.snapshot(), staged);
});

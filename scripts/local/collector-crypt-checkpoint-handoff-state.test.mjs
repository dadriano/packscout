import assert from "node:assert/strict";
import { test } from "node:test";
import { tsImport } from "tsx/esm/api";

const state = await tsImport("./collector-crypt-checkpoint-handoff-state.mts", import.meta.url);
const plan = await tsImport("./collector-crypt-checkpoint-handoff-plan.mts", import.meta.url);
const { providerMixedCursorFingerprint } = await tsImport("@packscout/database", import.meta.url);
const { dataforrestLaunchDistributedSourceAdapterManifest: oldManifest } =
  await tsImport("@packscout/contracts", import.meta.url);
const pins = plan.collectorHandoff;
const operationId = "10000000-0000-4000-8000-000000000001";
const previousConfigId = "10000000-0000-4000-8000-000000000002";
const nextConfigId = plan.handoffId(operationId, "config");
const operatorId = "10000000-0000-4000-8000-000000000003";
const foreignId = "10000000-0000-4000-8000-000000000099";
const opaqueValue = "fixture-opaque-value-must-not-enter-audit";

function credential(kind, suffix) {
  return { id: `10000000-0000-4000-8000-${suffix.padStart(12, "0")}`,
    provider_id: pins.providerId, credential_kind: kind, version_number: 1n,
    lifecycle: "active", activated_at: new Date("2026-01-01T00:00:00Z"),
    retired_at: null, revoked_at: null, ciphertext: new Uint8Array([1, 2, 3]),
    nonce: new Uint8Array(12).fill(4), auth_tag: new Uint8Array(16).fill(5), key_version: 1 };
}

function centralStore() {
  const source = credential("source", "4");
  const databaseCredential = credential("database", "5");
  const previous = { id: previousConfigId, provider_id: pins.providerId, version_number: 2n,
    adapter_key: pins.previousAdapter, endpoint_url: pins.endpoint,
    configuration: { platform: pins.providerKey }, source_credential_version_id: source.id,
    source_credential: source, expires_at: null, schedule_seconds: 60, stale_after_seconds: 300,
    created_by_operator_id: operatorId };
  const node = { id: "10000000-0000-4000-8000-000000000006", provider_id: pins.providerId,
    node_role: "primary", enabled: true, host: "127.0.0.1", port: pins.port,
    database_name: pins.databaseName, ssl_mode: "disable", row_version: 1n,
    credential_version_id: databaseCredential.id, credential: databaseCredential };
  return { provider: { id: pins.providerId, organization_id: pins.organizationId,
    provider_key: pins.providerKey, lifecycle: "active", active_config_version_id: previousConfigId,
    row_version: 7n, topology_version: 1n, database_nodes: [node] },
  versions: [{ ...previous, id: "10000000-0000-4000-8000-000000000007", version_number: 1n }, previous],
  audits: [], proofs: [], membership: { operator_id: operatorId }, casCount: 1 };
}

/** In-memory transactional fake only: no runtime, gateway, SQL driver or network. */
function centralHarness(initial = centralStore()) {
  let store = structuredClone(initial);
  const writes = [];
  const sql = [];
  function clientFor(target, pendingWrites) {
    return {
      providers: {
        findUniqueOrThrow: async ({ where }) => {
          assert.deepEqual(where, { id: pins.providerId });
          return structuredClone(target.provider);
        },
        updateMany: async ({ where, data }) => {
          pendingWrites.push({ table: "providers", where, data });
          if (target.casCount !== 1) return { count: target.casCount };
          assert.equal(where.id, pins.providerId);
          assert.equal(where.row_version, target.provider.row_version);
          assert.equal(where.active_config_version_id, previousConfigId);
          target.provider.active_config_version_id = data.active_config_version_id;
          target.provider.row_version += data.row_version.increment;
          return { count: 1 };
        },
      },
      provider_config_versions: {
        findFirst: async ({ where }) => {
          assert.deepEqual(where, { provider_id: pins.providerId, version_number: 2n });
          return structuredClone(target.versions.find((row) => row.version_number === 2n) ?? null);
        },
        findMany: async ({ where }) => {
          assert.deepEqual(where, { provider_id: pins.providerId });
          return structuredClone(target.versions);
        },
        create: async ({ data }) => {
          pendingWrites.push({ table: "provider_config_versions", data });
          target.versions.push(structuredClone(data));
          return data;
        },
      },
      provider_connection_tests: { create: async ({ data }) => {
        pendingWrites.push({ table: "provider_connection_tests", data });
        target.proofs.push(structuredClone(data));
        return data;
      } },
      audit_events: {
        findUnique: async ({ where }) => structuredClone(target.audits.find((row) => row.id === where.id) ?? null),
        create: async ({ data }) => {
          pendingWrites.push({ table: "audit_events", data });
          target.audits.push(structuredClone(data));
          return data;
        },
      },
      operator_memberships: { findFirst: async ({ where }) => {
        assert.deepEqual(where, { organization_id: pins.organizationId, operator_id: operatorId,
          role: "admin", operator: { state: "active" } });
        return structuredClone(target.membership);
      } },
      $queryRaw: async (strings) => {
        const text = strings.join("?");
        sql.push(text);
        return text.includes("packscout_activation_target_digest_nullable_source")
          ? [{ digest: "a".repeat(64) }] : [];
      },
      $executeRaw: async (strings) => { sql.push(strings.join("?")); return 1; },
    };
  }
  const central = new Proxy({}, { get(_target, key) {
    if (key === "$transaction") return async (operation, options) => {
      assert.equal(options.isolationLevel, "Serializable");
      const transactionStore = structuredClone(store);
      const pendingWrites = [];
      const result = await operation(clientFor(transactionStore, pendingWrites));
      store = transactionStore;
      writes.push(...pendingWrites);
      return result;
    };
    return clientFor(store, writes)[key];
  } });
  return { central, writes, sql, snapshot: () => structuredClone(store),
    mutate: (change) => change(store) };
}

function checkpoint() {
  const cursor = { sourceInstanceId: pins.providerId, sourceRevisionId: previousConfigId,
    sourceTypeKey: oldManifest.sourceTypeKey, adapterVersion: pins.previousAdapter,
    cursorCodecKey: oldManifest.cursorCodecKey, cursorGeneration: 1, value: opaqueValue };
  const cursorHash = providerMixedCursorFingerprint(cursor);
  return { providerId: pins.providerId, providerKey: pins.providerKey,
    databaseRole: "provider", schemaVersion: "distributed-provider-v1", runtimeState: "paused",
    generation: "2", runtimeRowVersion: "100", cachedConfigId: previousConfigId, cachedConfigNumber: "2",
    cursor, cursorHash, activeRunCount: 0, actionableCommandCount: 0, otherActiveTransactionCount: 0,
    oldProcessAlive: false, databaseNow: new Date().toISOString(),
    lease: { owner: null, fence: "1", expiresAt: null }, ledgerSequence: "1900",
    run: { id: operationId, state: "incomplete", configId: previousConfigId, configNumber: "2",
      fence: "1", pageCount: 10, accepted: 1000, duplicates: 0, quarantines: 0, materialChanges: 1000,
      reachedHead: false, finishedAt: new Date().toISOString(), failureCode: "PROVIDER_IMPORT_RUNTIME_UNAVAILABLE",
      finalCursor: cursor, finalCursorHash: cursorHash },
    lastPage: { id: foreignId, number: 10, cursor, cursorHash, continuation: "more" } };
}

async function stageInput(harness) {
  const snapshot = checkpoint();
  const migrated = plan.reEnvelopeCollectorCursor({ cursor: snapshot.cursor,
    cursorHash: snapshot.cursorHash, previousConfigId, nextConfigId });
  return { central: harness.central, operationId,
    authority: await state.readCollectorHandoffAuthority(harness.central, operationId),
    checkpoint: snapshot, nextCursorHash: migrated.cursorHash,
    sourceProof: { checkKind: "collector_saved_cursor_1000_record_canary", adapterKey: pins.nextAdapter,
      previousConfigId, nextConfigId, opaqueValueHash: migrated.opaqueValueHash,
      responseStatus: 200, responseBytes: 500_000, durationMilliseconds: 200,
      requestedRecords: 1000, recordCount: 1000, checkedAt: new Date().toISOString() } };
}

function prepared(snapshot) {
  const migrated = plan.reEnvelopeCollectorCursor({ cursor: snapshot.cursor,
    cursorHash: snapshot.cursorHash, previousConfigId, nextConfigId });
  return { ...snapshot, cachedConfigId: nextConfigId, cachedConfigNumber: "3",
    cursor: migrated.cursor, cursorHash: migrated.cursorHash };
}

const refusal = (error) => error?.name === "CollectorCheckpointHandoffError" && /^HANDOFF_[A-Z_]+$/u.test(error.code);

test("handoff authority resolves only the exact active Collector organization, local node and credentials", async () => {
  const harness = centralHarness();
  const authority = await state.readCollectorHandoffAuthority(harness.central, operationId);
  assert.equal(authority.previous.id, previousConfigId);
  assert.equal(authority.nextConfigId, nextConfigId);
  assert.equal(authority.active, false);
  assert.equal(authority.next, undefined);
  assert.equal(authority.operatorId, operatorId);
  assert.match(authority.authorityDigest, /^[a-f0-9]{64}$/u);
  assert.deepEqual(harness.writes, []);
  const changes = [
    ["organization", (s) => { s.provider.organization_id = foreignId; }],
    ["provider key", (s) => { s.provider.provider_key = "courtyard"; }],
    ["provider lifecycle", (s) => { s.provider.lifecycle = "inactive"; }],
    ["duplicate node", (s) => { s.provider.database_nodes.push(structuredClone(s.provider.database_nodes[0])); }],
    ...Object.entries({ host: "remote.invalid", port: 55433, database_name: "packscout_courtyard",
      ssl_mode: "require", enabled: false, node_role: "replica" }).map(([field, value]) =>
      [field, (s) => { s.provider.database_nodes[0][field] = value; }]),
    ...["source", "database"].flatMap((kind) => Object.entries({ provider_id: foreignId,
      credential_kind: "other", lifecycle: "revoked", activated_at: null,
      retired_at: new Date(), revoked_at: new Date() }).map(([field, value]) =>
      [`${kind} ${field}`, (s) => {
        const credential = kind === "source" ? s.versions[1].source_credential : s.provider.database_nodes[0].credential;
        credential[field] = value;
      }])),
    ["future source credential", (s) => { s.versions[1].source_credential.activated_at = new Date(Date.now() + 60_000); }],
    ["future database credential", (s) => { s.provider.database_nodes[0].credential.activated_at = new Date(Date.now() + 60_000); }],
    ...Object.entries({ adapter_key: pins.nextAdapter, endpoint_url: "https://other.invalid",
      configuration: { platform: "courtyard" }, expires_at: new Date() }).map(([field, value]) =>
      [field, (s) => { s.versions[1][field] = value; }]),
    ["unexpected active revision", (s) => { s.provider.active_config_version_id = foreignId; }],
    ["unexpected extra revision", (s) => { s.versions.push({ ...s.versions[1], id: foreignId, version_number: 4n }); }],
    ["missing admin membership", (s) => { s.membership = null; }],
  ];
  for (const [label, change] of changes) {
    const invalid = centralHarness();
    invalid.mutate(change);
    await assert.rejects(state.readCollectorHandoffAuthority(invalid.central, operationId), refusal, label);
    assert.deepEqual(invalid.writes, [], label);
  }
});

test("staging attests exact source and checkpoint evidence without activating, and exact retries are idempotent", async () => {
  const harness = centralHarness();
  const input = await stageInput(harness);
  await state.stageCollectorHandoff(input);
  const staged = harness.snapshot();
  assert.equal(staged.provider.active_config_version_id, previousConfigId);
  assert.equal(staged.provider.row_version, 7n);
  assert.deepEqual(harness.writes.map(({ table }) => table),
    ["provider_config_versions", "provider_connection_tests", "audit_events"]);
  const next = staged.versions.find((row) => row.id === nextConfigId);
  assert.equal(next.adapter_key, pins.nextAdapter);
  assert.equal(next.version_number, 3n);
  assert.equal(staged.proofs[0].result_summary.checkKind, "bounded_source_and_paused_database_checkpoint");
  assert.deepEqual(staged.proofs[0].result_summary.sourceProof, input.sourceProof);
  assert.deepEqual(staged.proofs[0].result_summary.checkpoint, state.retainedCollectorCheckpoint(input.checkpoint));
  assert.equal(JSON.stringify(staged.audits).includes(opaqueValue), false);
  assert.equal(harness.sql.some((sql) => sql.includes("packscout_assert_provider_activation")), false);
  await state.stageCollectorHandoff(input);
  assert.equal(harness.writes.length, 3);
});

test("fresh staging refuses mismatched, oversized or nonfresh source proofs before any durable attestation", async () => {
  const changes = [
    { checkKind: "other" }, { adapterKey: pins.previousAdapter }, { previousConfigId: foreignId },
    { nextConfigId: foreignId }, { opaqueValueHash: "f".repeat(64) }, { requestedRecords: 100 },
    { recordCount: 999 }, { recordCount: 1001 }, { responseStatus: 500 },
    { responseBytes: 8_388_609 }, { responseBytes: 0 }, { responseBytes: -1 },
    { responseBytes: 1.5 }, { responseBytes: Number.NaN },
    { durationMilliseconds: Number.NaN }, { durationMilliseconds: -1 },
    { checkedAt: "invalid-time" }, { checkedAt: new Date(Date.now() + 60_000).toISOString() },
    { checkedAt: new Date(Date.now() - 121_000).toISOString() },
  ];
  for (const change of changes) {
    const harness = centralHarness();
    const input = await stageInput(harness);
    await assert.rejects(state.stageCollectorHandoff({ ...input, sourceProof: { ...input.sourceProof, ...change } }),
      refusal, Object.keys(change).join());
    assert.deepEqual(harness.writes, []);
    assert.equal(harness.snapshot().provider.active_config_version_id, previousConfigId);
  }
  const harness = centralHarness();
  const input = await stageInput(harness);
  await assert.rejects(state.stageCollectorHandoff({ ...input, nextCursorHash: "f".repeat(64) }), refusal);
  assert.deepEqual(harness.writes, []);
});

test("staging detects changed central CAS authority and changed replay checkpoint without activation", async () => {
  const stale = centralHarness();
  const staleInput = await stageInput(stale);
  stale.mutate((s) => { s.provider.row_version += 1n; });
  await assert.rejects(state.stageCollectorHandoff(staleInput), { code: "HANDOFF_CENTRAL_CAS_FAILED" });
  assert.deepEqual(stale.writes, []);
  const harness = centralHarness();
  const input = await stageInput(harness);
  await state.stageCollectorHandoff(input);
  await assert.rejects(state.stageCollectorHandoff({ ...input,
    checkpoint: { ...input.checkpoint, ledgerSequence: "1901" } }), refusal);
  await assert.rejects(state.stageCollectorHandoff({ ...input,
    sourceProof: { ...input.sourceProof, adapterKey: pins.previousAdapter } }), refusal);
  assert.equal(harness.writes.length, 3);
  assert.equal(harness.snapshot().provider.active_config_version_id, previousConfigId);
});

test("staged authority refuses altered revision, route, credential and audit bindings", async () => {
  const changes = [
    ...Object.entries({ version_number: 4n, adapter_key: pins.previousAdapter,
      endpoint_url: "https://other.invalid", source_credential_version_id: foreignId,
      schedule_seconds: 120, stale_after_seconds: 600,
      configuration: { platform: pins.providerKey, pageLimit: 1000 }, expires_at: new Date() }).map(([field, value]) =>
      [`next ${field}`, (s) => { s.versions.find((row) => row.id === nextConfigId)[field] = value; }]),
    ["changed topology", (s) => { s.provider.topology_version += 1n; }],
    ["changed node version", (s) => { s.provider.database_nodes[0].row_version += 1n; }],
    ["changed database credential", (s) => { s.provider.database_nodes[0].credential.ciphertext[0] = 9; }],
    ["changed source credential", (s) => { s.versions[1].source_credential.ciphertext[0] = 9; }],
    ...Object.entries({ action: "other", organization_id: foreignId,
      subject_id: foreignId, outcome: "failure" }).map(([field, value]) =>
      [`audit ${field}`, (s) => { s.audits[0][field] = value; }]),
    ["changed authority digest", (s) => { s.audits[0].metadata_json.authorityDigest = "f".repeat(64); }],
    ["missing stage", (s) => { s.audits = []; }],
  ];
  for (const [label, change] of changes) {
    const harness = centralHarness();
    await state.stageCollectorHandoff(await stageInput(harness));
    harness.mutate(change);
    await assert.rejects(state.readCollectorHandoffAuthority(harness.central, operationId), refusal, label);
    assert.equal(harness.writes.length, 3, label);
    assert.equal(harness.snapshot().provider.active_config_version_id, previousConfigId, label);
  }
});

test("activation requires a prepared checkpoint, performs exact central CAS last and is idempotent", async () => {
  const harness = centralHarness();
  const input = await stageInput(harness);
  const activation = { central: harness.central, operationId, authorityDigest: input.authority.authorityDigest,
    checkpoint: prepared(input.checkpoint) };
  await assert.rejects(state.activateCollectorHandoffLast(activation), { code: "HANDOFF_ACTIVATION_NOT_PREPARED" });
  await state.stageCollectorHandoff(input);
  await assert.rejects(state.activateCollectorHandoffLast({ ...activation, authorityDigest: "f".repeat(64) }), refusal);
  for (const change of [{ runtimeState: "idle" }, { cachedConfigId: previousConfigId },
    { cachedConfigNumber: "2" }, { cursorHash: "f".repeat(64) }, { ledgerSequence: "1901" },
    { cursor: { ...activation.checkpoint.cursor, adapterVersion: pins.previousAdapter } },
    { cursor: { ...activation.checkpoint.cursor, value: "different-fixture-value" } },
    { cursor: { ...activation.checkpoint.cursor, sourceRevisionId: previousConfigId } }]) {
    await assert.rejects(state.activateCollectorHandoffLast({ ...activation,
      checkpoint: { ...activation.checkpoint, ...change } }), refusal, Object.keys(change).join());
    assert.equal(harness.snapshot().provider.active_config_version_id, previousConfigId);
  }
  await state.activateCollectorHandoffLast(activation);
  assert.equal(harness.snapshot().provider.active_config_version_id, nextConfigId);
  assert.equal(harness.snapshot().provider.row_version, 8n);
  assert.deepEqual(harness.writes.map(({ table }) => table),
    ["provider_config_versions", "provider_connection_tests", "audit_events", "providers", "audit_events"]);
  assert.equal(harness.sql.some((sql) => sql.includes("packscout_assert_provider_activation")), true);
  await state.activateCollectorHandoffLast(activation);
  assert.equal(harness.writes.length, 5);
});

test("activation refuses stale provider row versions and failed CAS without a partial active pointer", async () => {
  for (const change of [(s) => { s.provider.row_version += 1n; }, (s) => { s.casCount = 0; }]) {
    const harness = centralHarness();
    const input = await stageInput(harness);
    await state.stageCollectorHandoff(input);
    harness.mutate(change);
    await assert.rejects(state.activateCollectorHandoffLast({ central: harness.central, operationId,
      authorityDigest: input.authority.authorityDigest, checkpoint: prepared(input.checkpoint) }),
    { code: "HANDOFF_CENTRAL_CAS_FAILED" });
    assert.equal(harness.snapshot().provider.active_config_version_id, previousConfigId);
    assert.equal(harness.writes.length, 3);
  }
});

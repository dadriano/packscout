import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { classifyClutchpacksReplayCentralSnapshot } = await tsImport(
  "./prepare-clutchpacks-dataforrest-replay-central.mts",
  import.meta.url,
);

const organizationId = "20000000-0000-4000-8000-000000000001";
const providerId = "20000000-0000-4000-8000-000000000002";
const operatorId = "20000000-0000-4000-8000-000000000003";
const v3Id = "20000000-0000-4000-8000-000000000004";
const v4Id = "20000000-0000-4000-8000-000000000005";
const sourceCredentialId = "20000000-0000-4000-8000-000000000006";
const nodeId = "20000000-0000-4000-8000-000000000007";
const databaseCredentialId = "20000000-0000-4000-8000-000000000008";
const adapterKey = "dataforrest-clutchpacks-distributed-adapter-v1";
const endpoint = "https://198.204.245.26.sslip.io/v1/events";

function config(version, overrides = {}) {
  return {
    id: version === "3" ? v3Id : version === "4" ? v4Id
      : `20000000-0000-4000-8000-00000000000${version}`,
    version_number: version,
    adapter_key: version === "3" || version === "4"
      ? adapterKey
      : `historical-v${version}`,
    endpoint_url: version === "3" || version === "4"
      ? endpoint
      : "https://historical.invalid",
    source_credential_version_id: version === "3" || version === "4"
      ? sourceCredentialId
      : null,
    schedule_seconds: 3_600,
    stale_after_seconds: 86_400,
    configuration: version === "3" || version === "4"
      ? { platform: "clutchpacks" }
      : {},
    expires_at: null,
    created_by_operator_id: operatorId,
    ...overrides,
  };
}

function snapshot(phase = "v3_active") {
  const v4 = phase !== "v3_active";
  return {
    provider: {
      id: providerId,
      organization_id: organizationId,
      provider_key: "clutchpacks",
      lifecycle: "active",
      active_config_version_id: phase === "v4_active" ? v4Id : v3Id,
      topology_version: "2",
      row_version: phase === "v4_active" ? "8" : "7",
    },
    configs: [config("1"), config("2"), config("3"),
      ...(v4 ? [config("4")] : [])],
    node: {
      id: nodeId,
      node_key: "primary",
      node_role: "primary",
      host: "127.0.0.1",
      port: 55_432,
      database_name: "packscout_clutchpacks",
      ssl_mode: "disable",
      credential_version_id: databaseCredentialId,
      enabled: true,
      row_version: "1",
      credential_kind: "database",
      credential_lifecycle: "active",
    },
    sourceCredential: {
      id: sourceCredentialId,
      credential_kind: "source",
      version_number: "1",
      ciphertext: Buffer.from([1]),
      nonce: Buffer.alloc(12),
      auth_tag: Buffer.alloc(16),
      key_version: 1,
      lifecycle: "active",
      activated_at: new Date("2026-08-29T12:00:00.000Z"),
      retired_at: null,
      revoked_at: null,
    },
    v4Tests: phase === "v4_active" ? [{
      id: "20000000-0000-4000-8000-000000000009",
      source_credential_version_id: sourceCredentialId,
      database_credential_version_id: databaseCredentialId,
      topology_version: "2",
      database_node_id: nodeId,
      database_node_row_version: "1",
      target_digest: "a".repeat(64),
      test_kind: "activation",
      outcome: "succeeded",
      result_summary: {
        checkKind: "bounded_source_and_current_topology",
        observedProviderSchemaVersion: "distributed-provider-v1",
        platform: "clutchpacks",
        responseBytes: 400,
      },
    }] : [],
    v4Audits: phase === "v4_active" ? [{
      id: "20000000-0000-4000-8000-000000000010",
      actor_key: "system:local-clutchpacks-dataforrest-replay",
      outcome: "success",
      metadata_json: {
        adapterKey,
        configVersionId: v4Id,
        configVersionNumber: 4,
        fromConfigVersionId: v3Id,
        fromConfigVersionNumber: 3,
        replayCursorPolicy: "clear_on_provider_version_advance",
        reusedSourceCredentialVersion: 1,
        topologyVersion: "2",
      },
    }] : [],
    creatorIsActiveAdmin: true,
  };
}

test("classifier admits only exact v3, copied v4 candidate, and tested v4", () => {
  assert.equal(
    classifyClutchpacksReplayCentralSnapshot(snapshot()).phase,
    "v3_active",
  );
  assert.equal(
    classifyClutchpacksReplayCentralSnapshot(snapshot("v4_candidate")).phase,
    "v4_candidate",
  );
  const active = classifyClutchpacksReplayCentralSnapshot(
    snapshot("v4_active"),
  );
  assert.equal(active.phase, "v4_active");
  assert.equal(active.configVersionId, v4Id);
  assert.equal(active.configVersionNumber, 4n);
});

test("v4 must reuse every v3 authority field with no expiration", () => {
  for (const drift of [
    { adapter_key: "other-adapter" },
    { endpoint_url: "https://other.invalid" },
    { source_credential_version_id:
      "20000000-0000-4000-8000-000000000011" },
    { schedule_seconds: 3_601 },
    { stale_after_seconds: 86_401 },
    { configuration: { platform: "courtyard" } },
    { expires_at: new Date("2026-09-01T00:00:00.000Z") },
    { created_by_operator_id:
      "20000000-0000-4000-8000-000000000012" },
  ]) {
    const candidate = snapshot("v4_candidate");
    candidate.configs[3] = config("4", drift);
    assert.equal(
      classifyClutchpacksReplayCentralSnapshot(candidate).phase,
      "unexpected",
    );
  }
});

test("v4 activation evidence is exact to current topology and central audit", () => {
  for (const mutate of [
    (candidate) => { candidate.v4Tests[0].topology_version = "3"; },
    (candidate) => { candidate.v4Tests[0].database_node_row_version = "2"; },
    (candidate) => { candidate.v4Tests[0].outcome = "failed"; },
    (candidate) => { candidate.v4Audits[0].actor_key = "unexpected"; },
    (candidate) => {
      candidate.v4Audits[0].metadata_json.replayCursorPolicy = "retain";
    },
  ]) {
    const active = snapshot("v4_active");
    mutate(active);
    assert.equal(
      classifyClutchpacksReplayCentralSnapshot(active).phase,
      "unexpected",
    );
  }
});

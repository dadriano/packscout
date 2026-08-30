import assert from "node:assert/strict";
import { test } from "node:test";
import { tsImport } from "tsx/esm/api";

const {
  ProviderReviewActivationDatabaseProofError,
  assertProviderReviewActivationDatabaseRoute,
  assertProviderReviewActivationDatabaseSnapshot,
} = await tsImport("./provider-review-activation-database-proof.mts", import.meta.url);

const pins = Object.freeze({
  organizationId: "00000000-0000-4000-8000-000000000001",
  providerId: "00000000-0000-4000-8000-000000000002",
  providerKey: "phygitals",
  configVersionId: "00000000-0000-4000-8000-000000000003",
  providerRowVersion: 3n,
  topologyVersion: 2n,
  nodeId: "00000000-0000-4000-8000-000000000004",
  nodeRowVersion: 1n,
  databaseCredentialVersionId: "00000000-0000-4000-8000-000000000005",
  host: "127.0.0.1",
  port: 55_435,
  databaseName: "packscout_phygitals",
  sslMode: "disable",
});

function route() {
  return {
    organizationId: pins.organizationId,
    target: {
      providerId: pins.providerId, providerKey: pins.providerKey,
      databaseName: pins.databaseName, databaseRole: "provider",
      schemaVersion: "distributed-provider-v1",
    },
    configVersionId: pins.configVersionId,
    providerRowVersion: pins.providerRowVersion,
    topologyVersion: pins.topologyVersion,
    node: {
      nodeId: pins.nodeId, rowVersion: pins.nodeRowVersion,
      credentialVersionId: pins.databaseCredentialVersionId,
      host: pins.host, port: pins.port, sslMode: pins.sslMode,
    },
  };
}

const snapshot = Object.freeze({
  providerId: pins.providerId, providerKey: pins.providerKey,
  databaseRole: "provider", schemaVersion: "distributed-provider-v1",
  runtimeProviderId: pins.providerId, runtimeProviderKey: pins.providerKey,
  runtimeState: "idle", activeRunCount: 0, actionableCommandCount: 0,
  ownedLeaseCount: 0, runCount: 0, commandCount: 0, canonicalCount: 0,
  quarantineCount: 0,
});

test("activation proof binds every provider, config, topology, node, and credential pin", () => {
  assert.doesNotThrow(() => assertProviderReviewActivationDatabaseRoute(route(), pins));
  for (const change of [
    { organizationId: "00000000-0000-4000-8000-000000000099" },
    { configVersionId: "00000000-0000-4000-8000-000000000099" },
    { providerRowVersion: 4n },
    { topologyVersion: 3n },
    { node: { ...route().node, nodeId: "00000000-0000-4000-8000-000000000099" } },
    { node: { ...route().node, rowVersion: 2n } },
    { node: { ...route().node, credentialVersionId: "00000000-0000-4000-8000-000000000099" } },
    { node: { ...route().node, host: "example.test" } },
    { node: { ...route().node, port: 55_434 } },
    { target: { ...route().target, providerKey: "collector_crypt" } },
  ]) {
    assert.throws(
      () => assertProviderReviewActivationDatabaseRoute({ ...route(), ...change }, pins),
      ProviderReviewActivationDatabaseProofError,
    );
  }
});

test("pre-activation proof refuses wrong identity and any active local authority", () => {
  assert.doesNotThrow(() => assertProviderReviewActivationDatabaseSnapshot({
    snapshot, pins, requireIdle: true,
  }));
  for (const change of [
    { providerKey: "courtyard" }, { runtimeProviderId: "wrong" },
    { schemaVersion: "wrong" }, { runtimeState: "running" },
    { activeRunCount: 1 }, { actionableCommandCount: 1 }, { ownedLeaseCount: 1 },
    { canonicalCount: Number.NaN },
  ]) {
    assert.throws(
      () => assertProviderReviewActivationDatabaseSnapshot({
        snapshot: { ...snapshot, ...change }, pins, requireIdle: true,
      }),
      ProviderReviewActivationDatabaseProofError,
    );
  }
});

test("already-active inspection allows ongoing work without weakening identity pins", () => {
  assert.doesNotThrow(() => assertProviderReviewActivationDatabaseSnapshot({
    snapshot: {
      ...snapshot, runtimeState: "running", activeRunCount: 1,
      ownedLeaseCount: 1, runCount: 1, commandCount: 1, canonicalCount: 100,
    },
    pins,
    requireIdle: false,
  }));
  assert.throws(() => assertProviderReviewActivationDatabaseSnapshot({
    snapshot: { ...snapshot, runtimeProviderKey: "clutchpacks" },
    pins, requireIdle: false,
  }), ProviderReviewActivationDatabaseProofError);
});

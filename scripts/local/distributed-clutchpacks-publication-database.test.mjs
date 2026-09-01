import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { readClutchpacksPublicationDatabaseConfiguration: configuration,
  readClutchpacksPublicationAuthority: authority,
  loadClutchpacksPublicationSnapshot: snapshot } = await tsImport(
  "./distributed-clutchpacks-publication-database.mts", import.meta.url);
const { loadStableSnapshot } = await tsImport("./distributed-clutchpacks-publication-snapshot.mts", import.meta.url);

const scope = Object.freeze({ configVersionId: "11111111-1111-4111-8111-111111111111",
  configVersionNumber: "4", operatorId: "22222222-2222-4222-8222-222222222222",
  organizationId: "33333333-3333-4333-8333-333333333333", providerId: "44444444-4444-4444-8444-444444444444" });
const otherId = "55555555-5555-4555-8555-555555555555";
function environment() {
  return { NODE_ENV: "development", PACKSCOUT_DATABASE_MODE: "remote",
    PACKSCOUT_CENTRAL_DATABASE_URL: "postgresql://app:synthetic-secret@control.example.test:5432/packscout?sslmode=verify-full",
    PACKSCOUT_CENTRAL_DATABASE_ALLOWED_HOSTS: "control.example.test",
    PACKSCOUT_PROVIDER_DATABASE_ALLOWED_HOSTS: "clutch.example.test",
    PACKSCOUT_LOCAL_CLUTCHPACKS_PUBLICATION_SCOPE_JSON: JSON.stringify(scope) };
}
function fixture() {
  const calls = [];
  const provider = { id: scope.providerId, organization_id: scope.organizationId, provider_key: "clutchpacks",
    lifecycle: "active", active_config_version_id: scope.configVersionId,
    active_config_version: { id: scope.configVersionId, version_number: 4n, expires_at: null },
    row_version: 2n, topology_version: 3n, config_versions: [],
    database_nodes: [{ id: otherId, host: "clutch.example.test", port: 5432, database_name: "packscout_clutchpacks",
      ssl_mode: "verify-full", credential_version_id: otherId, row_version: 2n,
      credential: { credential_kind: "database", lifecycle: "active", ciphertext: new Uint8Array([1]),
        nonce: new Uint8Array(12), auth_tag: new Uint8Array(16), key_version: 1 } }] };
  const state = { provider, membership: { organization_id: scope.organizationId, operator_id: scope.operatorId,
    role: "admin", operator: { state: "active" } } };
  const central = {
    providers: { async findUnique(input) {
      calls.push(["provider-read", input.where]);
      assert.deepEqual(input.where.id_organization_id, { id: scope.providerId, organization_id: scope.organizationId });
      return state.provider;
    } },
    operator_memberships: { async findFirst(input) {
      calls.push(["membership-read", input.where]);
      assert.deepEqual(input.where, { organization_id: scope.organizationId, operator_id: scope.operatorId,
        role: "admin", operator: { state: "active" } });
      return state.membership;
    } },
  };
  const source = { facts: { organizationId: scope.organizationId, providerId: scope.providerId,
    activeConfigVersionId: scope.configVersionId, activeConfigVersionNumber: 4n }, stabilityFingerprint: "a".repeat(64) };
  return { state, central, calls, source, input: { central, gateway: {}, approvedPublicAssetOrigins: [],
    databaseConfiguration: configuration(environment()) } };
}
function publicError(error) {
  assert.match(error.code, /^CLUTCHPACKS_PUBLICATION_[A-Z_]+$/u);
  assert.equal(error.message.includes("synthetic-secret"), false);
  return true;
}

test("explicit remote publication uses verified central TLS and the exact provider allowlist", () => {
  const env = Object.freeze(environment());
  const parsed = configuration(env);
  assert.equal(parsed.runtimePolicy.mode, "remote");
  assert.deepEqual(parsed.scope, scope);
  assert.doesNotThrow(() => parsed.runtimePolicy.destinationPolicy.assertAllowed({
    host: "clutch.example.test", port: 5432, sslMode: "verify-full" }));
  assert.equal(env.PACKSCOUT_LOCAL_CLUTCHPACKS_PUBLICATION_SCOPE_JSON, JSON.stringify(scope));
  assert.doesNotThrow(() => configuration({ ...env, PACKSCOUT_CENTRAL_DATABASE_URL:
    env.PACKSCOUT_CENTRAL_DATABASE_URL.replace("sslmode=verify-full", "sslmode=require&sslaccept=strict") }));
});

test("missing explicit remote mode, insecure TLS, destination overrides and production fail before access", () => {
  const env = environment();
  for (const patch of [
    { NODE_ENV: "production" }, { PACKSCOUT_DATABASE_MODE: undefined }, { PACKSCOUT_DATABASE_MODE: "remtoe" },
    { PACKSCOUT_DATABASE_MODE: "" }, { PACKSCOUT_PROVIDER_DATABASE_ALLOWED_HOSTS: undefined },
    { PACKSCOUT_PROVIDER_DATABASE_ALLOWED_HOSTS: "*.example.test" },
    { PACKSCOUT_CENTRAL_DATABASE_ALLOWED_HOSTS: "*.example.test" },
    { PACKSCOUT_CENTRAL_DATABASE_ALLOWED_HOSTS: undefined },
    ...["sslmode=disable", "sslmode=require", "sslmode=verify-ca", "sslmode=verify-full&sslaccept=accept_invalid_certs",
      "sslmode=verify-full&host=other.example.test", "sslmode=verify-full&sslmode=disable"]
      .map(query => ({ PACKSCOUT_CENTRAL_DATABASE_URL: env.PACKSCOUT_CENTRAL_DATABASE_URL.split("?")[0] + "?" + query })),
    ...["other.example.test", "control.example.test.attacker.test", "127.0.0.1"]
      .map(host => ({ PACKSCOUT_CENTRAL_DATABASE_URL: env.PACKSCOUT_CENTRAL_DATABASE_URL.replace("control.example.test", host) })),
    { PACKSCOUT_CENTRAL_DATABASE_URL: env.PACKSCOUT_CENTRAL_DATABASE_URL.replace(":5432/", ":55431/") },
    { PACKSCOUT_CENTRAL_DATABASE_URL: env.PACKSCOUT_CENTRAL_DATABASE_URL.replace("/packscout?", "/postgres?") },
  ]) assert.throws(() => configuration({ ...env, ...patch }), publicError);
});

test("remote scope must be complete, canonical and bounded rather than inferred from a provider row", () => {
  for (const raw of [undefined, "null", "[]", "{}", JSON.stringify({ ...scope, operatorId: "" }),
    JSON.stringify({ ...scope, organizationId: "not-a-uuid" }), JSON.stringify({ ...scope, providerId: otherId, extra: true }),
    JSON.stringify({ ...scope, configVersionNumber: "0" }), JSON.stringify({ ...scope, configVersionNumber: "04" }),
    JSON.stringify({ ...scope, configVersionNumber: "9223372036854775808" }),
    JSON.stringify(scope, null, 2), JSON.stringify({ ...scope, configVersionNumber: 4 })]) {
    assert.throws(() => configuration({ ...environment(), PACKSCOUT_LOCAL_CLUTCHPACKS_PUBLICATION_SCOPE_JSON: raw }), publicError);
  }
});

test("existing local mode retains only the historical central and Clutch provider ports", () => {
  const parsed = configuration({ PACKSCOUT_CENTRAL_DATABASE_URL: "postgresql://app:synthetic-secret@127.0.0.1:55431/packscout" });
  assert.equal(parsed.runtimePolicy.mode, "local");
  assert.equal(parsed.scope, null);
  assert.doesNotThrow(() => parsed.runtimePolicy.destinationPolicy.assertAllowed({ host: "127.0.0.1", port: 55432, sslMode: "disable" }));
  for (const port of [5432, 55433, 55434, 55435]) assert.throws(() =>
    parsed.runtimePolicy.destinationPolicy.assertAllowed({ host: "127.0.0.1", port, sslMode: "disable" }));
});

test("authority resolves exact tenant, active operator, configuration and provider logical identity using reads only", async () => {
  const f = fixture();
  assert.equal(typeof await authority(f.central, f.input.databaseConfiguration), "string");
  assert.equal(f.calls.length, 3);
});

test("foreign, revoked, expired or changed authority refuses before the provider snapshot", async () => {
  const changes = [
    f => { f.state.provider = null; }, f => { f.state.membership = null; },
    f => { f.state.membership.role = "viewer"; }, f => { f.state.membership.operator.state = "disabled"; },
    f => { f.state.membership.organization_id = otherId; }, f => { f.state.membership.operator_id = otherId; },
    f => { f.state.provider.id = otherId; }, f => { f.state.provider.organization_id = otherId; },
    f => { f.state.provider.provider_key = "courtyard"; }, f => { f.state.provider.lifecycle = "disabled"; },
    f => { f.state.provider.active_config_version_id = otherId; },
    f => { f.state.provider.active_config_version.version_number = 5n; },
    f => { f.state.provider.active_config_version.expires_at = new Date(0); },
    f => { f.state.provider.database_nodes[0].database_name = "packscout_courtyard"; },
    f => { f.state.provider.database_nodes[0].credential.lifecycle = "revoked"; },
    ...["disable", "require", "verify-ca"].map(value => f => { f.state.provider.database_nodes[0].ssl_mode = value; }),
    ...["other.example.test", "clutch.example.test.attacker.test", "127.0.0.1"]
      .map(value => f => { f.state.provider.database_nodes[0].host = value; }),
    f => { f.state.provider.database_nodes[0].port = 55432; },
  ];
  for (const change of changes) {
    const f = fixture(); change(f); let accessed = false;
    await assert.rejects(snapshot(f.input, async () => { accessed = true; return f.source; }), publicError);
    assert.equal(accessed, false);
  }
});

test("snapshot validates returned tenant/config and refuses a route transition during its read", async () => {
  for (const patch of [{ organizationId: otherId }, { providerId: otherId },
    { activeConfigVersionId: otherId }, { activeConfigVersionNumber: 5n }]) {
    const f = fixture(); Object.assign(f.source.facts, patch);
    await assert.rejects(snapshot(f.input, async () => f.source), publicError);
  }
  const f = fixture();
  await assert.rejects(snapshot(f.input, async () => {
    f.state.provider.database_nodes[0].row_version += 1n; return f.source;
  }), error => error.code === "CLUTCHPACKS_PUBLICATION_AUTHORITY_CHANGED");
});

test("the actual snapshot gateway boundary rejects central scope drift before opening a provider connection", async () => {
  for (const patch of [{ organization_id: otherId }, { id: otherId },
    { active_config_version_id: otherId, active_config_version: { id: otherId, version_number: 4n } },
    { active_config_version: { id: scope.configVersionId, version_number: 5n } }]) {
    const f = fixture(); let accessed = false;
    const provider = { ...f.state.provider, active_public_profile_version_id: null,
      _count: { category_correlations: 0, collectible_correlations: 0 }, ...patch };
    await assert.rejects(loadStableSnapshot({ expectedScope: scope, approvedPublicAssetOrigins: [],
      central: { providers: { async findUnique() { return provider; } },
        global_categories: { async count() { return 0; } }, global_collectibles: { async count() { return 0; } } },
      gateway: { async runWithProviderDatabase() { accessed = true; throw new Error("should not connect"); } },
    }), error => error.code === "CLUTCHPACKS_PUBLICATION_AUTHORITY_UNAVAILABLE");
    assert.equal(accessed, false);
  }
});

test("route changes between stable reads cannot reuse an earlier publication fingerprint", async () => {
  const f = fixture();
  const first = await snapshot(f.input, async () => f.source);
  f.state.provider.topology_version += 1n;
  const second = await snapshot(f.input, async () => f.source);
  assert.notEqual(first.stabilityFingerprint, second.stabilityFingerprint);
});

test("snapshot preparation acquires no write authority and forwards the exact already-owned publication fence", async () => {
  const f = fixture(); const lease = Object.freeze({ role: "import", owner: "publication-fixture", fence: 482n });
  await snapshot({ ...f.input, expectedImportLease: lease }, async input => {
    assert.equal(input.expectedImportLease, lease); assert.equal(input.gateway, f.input.gateway);
    assert.deepEqual(input.expectedScope, scope);
    return f.source;
  });
  assert.equal(f.calls.length, 6);
  await assert.rejects(snapshot(f.input, async () => { throw Object.assign(new Error("fence lost"), {
    code: "LOCAL_PUBLICATION_IMPORT_LEASE_UNAVAILABLE" }); }), error => error.code === "LOCAL_PUBLICATION_IMPORT_LEASE_UNAVAILABLE");
});

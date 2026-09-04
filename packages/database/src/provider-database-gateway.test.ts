import assert from "node:assert/strict";
import { test } from "node:test";
import type { CentralDatabaseLifecycle } from "./central-database.ts";
import { providerDatabaseTarget } from "./database-topology.ts";
import type { ProviderDatabaseLifecycle } from "./provider-database.ts";
import { ProviderDatabaseDestinationPolicy } from "./provider-database-destination-policy.ts";
import { BoundedProviderDatabaseGateway, type BoundedProviderDatabaseGatewayOptions } from "./provider-database-gateway.ts";
import type { ProviderDatabaseRoute } from "./provider-database-locator.ts";

const route: ProviderDatabaseRoute = {
  target: providerDatabaseTarget({
    providerId: "20000000-0000-4000-8000-000000000002",
    providerKey: "alpha",
  }),
  organizationId: "20000000-0000-4000-8000-000000000001",
  configVersionId: "20000000-0000-4000-8000-000000000003",
  providerRowVersion: 1n,
  topologyVersion: 1n,
  node: {
    nodeId: "20000000-0000-4000-8000-000000000004",
    host: "provider.example.test",
    port: 5432,
    sslMode: "verify-full",
    credentialVersionId: "20000000-0000-4000-8000-000000000005",
    encryptedCredential: {
      ciphertext: new Uint8Array([1]),
      nonce: new Uint8Array(12),
      authTag: new Uint8Array(16),
      keyVersion: 1,
    },
    rowVersion: 1n,
  },
};
const credential = { username: "synthetic@role", password: "synthetic:@/?#password" };

function fixture(input: {
  allowedModes?: ("disable" | "require" | "verify-ca" | "verify-full")[];
  allowedHost?: string;
  operationProfile?: BoundedProviderDatabaseGatewayOptions["operationProfile"];
  operationTimeoutMs?: number;
} = {}) {
  const opened: { databaseUrl: string; providerId: string; providerKey: string; connectionLimit: number }[] = [];
  let resolved = 0;
  let closed = 0;
  const gateway = new BoundedProviderDatabaseGateway({
    central: {} as CentralDatabaseLifecycle,
    credentialResolver: {
      async resolve(request) {
        resolved += 1;
        assert.equal(request.providerId, route.target.providerId);
        assert.equal(request.organizationId, route.organizationId);
        assert.equal(request.credentialVersionId, route.node.credentialVersionId);
        return credential;
      },
    },
    destinationPolicy: new ProviderDatabaseDestinationPolicy({
      allowedHosts: [input.allowedHost ?? route.node.host],
      allowedPorts: [5432],
      allowedSslModes: input.allowedModes ?? ["verify-full"],
    }),
    createLifecycle(configuration) {
      opened.push(configuration);
      return {
        client: {},
        async readiness() {
          return { state: "ready", target: route.target,
            observedSchemaVersion: route.target.schemaVersion, observedAt: new Date() };
        },
        async close() { closed += 1; },
      } as unknown as ProviderDatabaseLifecycle;
    },
    connectionLimitPerProvider: 2,
    maximumCachedProviders: 1,
    connectionTimeoutMs: 1500,
    ...(input.operationProfile === undefined ? {} : { operationProfile: input.operationProfile }),
    operationTimeoutMs: input.operationTimeoutMs ?? 1000,
  });
  return { gateway, opened, resolved: () => resolved, closed: () => closed };
}

test("long atomic page operations require explicit opt-in and retain strict destination checks", async () => {
  assert.throws(() => fixture({ operationTimeoutMs: 60_001 }), /bounds are invalid/u);
  assert.throws(() => fixture({ operationProfile: "atomic_import_page", operationTimeoutMs: 600_001 }), /bounds are invalid/u);
  assert.throws(() => fixture({ operationProfile: "unknown" as "standard" }), /bounds are invalid/u);
  const state = fixture({ operationProfile: "atomic_import_page", operationTimeoutMs: 600_000 });
  try {
    const denied = await state.gateway.runWithCachedProviderDatabase({
      ...route, node: { ...route.node, host: "unapproved.example.test" },
    }, async () => assert.fail("Long operation windows do not grant destination authority."));
    assert.equal(denied.state, "unreachable");
    assert.equal(state.resolved(), 0);
    const permitted = await state.gateway.runWithCachedProviderDatabase(route, async () => "committed");
    assert.equal(permitted.state, "reachable");
    assert.equal(state.opened[0]!.connectionLimit, 2);
  } finally { await state.gateway.close(); }
});

test("gateway preserves verify-full authorization and encodes strict native Prisma TLS without changing cache bounds", async () => {
  const state = fixture();
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await state.gateway.runWithCachedProviderDatabase(route, async () => "metadata");
      assert.equal(result.state, "reachable");
      if (result.state === "reachable") assert.equal(result.value, "metadata");
    }
    assert.equal(state.opened.length, 1);
    assert.equal(state.resolved(), 1);
    const configuration = state.opened[0]!;
    const url = new URL(configuration.databaseUrl);
    assert.equal(route.node.sslMode, "verify-full");
    assert.equal(url.searchParams.get("sslmode"), "require");
    assert.equal(url.searchParams.get("sslaccept"), "strict");
    assert.equal(url.searchParams.get("connect_timeout"), "2");
    assert.equal(configuration.connectionLimit, 2);
    assert.equal(configuration.providerId, route.target.providerId);
    assert.equal(configuration.providerKey, route.target.providerKey);
    assert.equal(url.hostname, route.node.host);
    assert.equal(url.port, "5432");
    assert.equal(url.pathname, `/${route.target.databaseName}`);
    assert.equal(decodeURIComponent(url.username), credential.username);
    assert.equal(decodeURIComponent(url.password), credential.password);
  } finally { await state.gateway.close(); }
  assert.equal(state.closed(), 1);
});

test("gateway rejects a weaker route policy before resolving credentials or opening a client", async () => {
  const state = fixture();
  try {
    const result = await state.gateway.runWithCachedProviderDatabase({
      ...route, node: { ...route.node, sslMode: "require" },
    }, async () => { assert.fail("A denied destination must not reach the operation."); });
    assert.equal(result.state, "unreachable");
    if (result.state === "unreachable") assert.equal(result.failureCode, "destination_not_allowed");
    assert.equal(state.resolved(), 0);
    assert.equal(state.opened.length, 0);
  } finally { await state.gateway.close(); }
});

test("gateway rejects CA-only mode unsupported by native Prisma instead of silently downgrading it", async () => {
  const state = fixture({ allowedModes: ["verify-ca"] });
  try {
    const result = await state.gateway.runWithCachedProviderDatabase({
      ...route, node: { ...route.node, sslMode: "verify-ca" },
    }, async () => { assert.fail("An unsupported TLS mode must not reach the operation."); });
    assert.equal(result.state, "unreachable");
    if (result.state === "unreachable") assert.equal(result.failureCode, "database_unreachable");
    assert.equal(state.opened.length, 0);
    assert.equal(JSON.stringify(result).includes(credential.password), false);
  } finally { await state.gateway.close(); }
});

test("gateway retains explicit destination-approved plaintext behavior for local callers", async () => {
  const state = fixture({ allowedModes: ["disable"], allowedHost: "127.0.0.1" });
  try {
    const result = await state.gateway.runWithCachedProviderDatabase({
      ...route, node: { ...route.node, host: "127.0.0.1", sslMode: "disable" },
    }, async () => "local metadata");
    assert.equal(result.state, "reachable");
    const url = new URL(state.opened[0]!.databaseUrl);
    assert.equal(url.searchParams.get("sslmode"), "disable");
    assert.equal(url.searchParams.has("sslaccept"), false);
  } finally { await state.gateway.close(); }
});

test("an operation that never settles retires its slot instead of poisoning the provider for the process lifetime", async () => {
  const state = fixture({ operationTimeoutMs: 1000 });

  // A query hung on a dropped connection never settles. The gateway abandons it
  // at the deadline, but it must not keep holding the cached entry's reference:
  // that made every later call short-circuit to database_unreachable and made the
  // entry unclosable, wedging all three import residents until a process restart.
  const hung = await state.gateway.runWithCachedProviderDatabase(
    route, () => new Promise<never>(() => {}));
  assert.equal(hung.state, "unreachable");
  assert.equal(hung.state === "unreachable" ? hung.failureCode : null, "database_unreachable");

  // The very next call must succeed on a FRESH lifecycle, exactly as a restarted
  // process would. Before the fix this returned unreachable forever.
  const after = await state.gateway.runWithCachedProviderDatabase(route, async () => "recovered");
  assert.equal(after.state, "reachable");
  assert.equal(after.state === "reachable" ? after.value : null, "recovered");
  assert.equal(state.opened.length, 2, "the poisoned lifecycle must be replaced, not reused");

  // And a third call keeps working, so recovery is not a one-shot.
  const again = await state.gateway.runWithCachedProviderDatabase(route, async () => "still-working");
  assert.equal(again.state, "reachable");
  assert.equal(state.opened.length, 2, "a healthy cached lifecycle is still reused");
});

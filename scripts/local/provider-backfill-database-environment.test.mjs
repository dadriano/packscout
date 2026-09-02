import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { readBackfillEnvironment, readLocalBackfillEnvironment, assertBackfillDestination } = await tsImport(
  "./provider-backfill-supervisor-authority.mts", import.meta.url);
const { readProviderManualImportDatabaseConfiguration } = await tsImport(
  "../../apps/worker/src/provider-manual-import-database-configuration.ts", import.meta.url);

function environment() {
  return {
    NODE_ENV: "development",
    PACKSCOUT_DATABASE_MODE: "remote",
    PACKSCOUT_CENTRAL_DATABASE_URL: "postgresql://app:synthetic-secret@control.example.test:5432/packscout?sslmode=require&sslaccept=strict",
    PACKSCOUT_CENTRAL_DATABASE_ALLOWED_HOSTS: "control.example.test",
    PACKSCOUT_PROVIDER_DATABASE_ALLOWED_HOSTS: "provider.example.test,second.example.test",
    PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64: Buffer.alloc(32, 1).toString("base64"),
    PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION: "1",
  };
}
function route(providerKey = "phygitals") {
  return { node: { host: "provider.example.test", port: 5432, sslMode: "verify-full" },
    target: { databaseName: `packscout_${providerKey}` } };
}

test("explicit remote development policy is forwarded intact from .env to the generic child", async () => {
  const env = await readBackfillEnvironment({ PATH: "/synthetic/bin",
    PACKSCOUT_PROVIDER_DATABASE_URL: "must-not-forward", DATAFORREST_BEARER_TOKEN: "must-not-forward" }, environment());
  assert.equal(env.runtimePolicy.mode, "remote");
  assert.equal(env.workerEnvironment.NODE_ENV, "development");
  assert.equal(env.workerEnvironment.PATH, "/synthetic/bin");
  for (const name of ["PACKSCOUT_DATABASE_MODE", "PACKSCOUT_CENTRAL_DATABASE_ALLOWED_HOSTS",
    "PACKSCOUT_PROVIDER_DATABASE_ALLOWED_HOSTS"]) assert.equal(env.workerEnvironment[name], environment()[name]);
  assert.equal(env.workerEnvironment.PACKSCOUT_PROVIDER_DATABASE_URL, undefined);
  assert.equal(env.workerEnvironment.DATAFORREST_BEARER_TOKEN, undefined);
  const child = readProviderManualImportDatabaseConfiguration(env.workerEnvironment);
  assert.equal(child.centralDatabaseUrl, env.centralDatabaseUrl);
  assert.doesNotThrow(() => child.runtimePolicy.destinationPolicy.assertAllowed(route().node));
  env.key.fill(0);
});

test("remote routes retain the exact provider database identity and reject TLS/host/port substitution", async () => {
  const env = await readBackfillEnvironment(environment(), {});
  for (const providerKey of ["clutchpacks", "courtyard", "collector_crypt", "phygitals"]) {
    assert.doesNotThrow(() => assertBackfillDestination(providerKey, route(providerKey), env.runtimePolicy));
    for (const bad of [
      { ...route(providerKey), target: { databaseName: "packscout_alpha" } },
      { ...route(providerKey), target: { databaseName: "packscout" } },
      { ...route(providerKey), node: { ...route().node, host: "other.example.test" } },
      { ...route(providerKey), node: { ...route().node, host: "provider.example.test.attacker.test" } },
      { ...route(providerKey), node: { ...route().node, host: "127.0.0.1" } },
      { ...route(providerKey), node: { ...route().node, port: 55435 } },
      ...["disable", "require", "verify-ca"].map(sslMode => ({ ...route(providerKey), node: { ...route().node, sslMode } })),
    ]) assert.throws(() => assertBackfillDestination(providerKey, bad, env.runtimePolicy), /BACKFILL_REMOTE_PROVIDER_ROUTE_REQUIRED/);
  }
  env.key.fill(0);
});

test("remote launch configuration fails closed for implicit mode, wildcards, missing allowlists and insecure central TLS", async () => {
  for (const patch of [
    { PACKSCOUT_DATABASE_MODE: undefined }, { PACKSCOUT_DATABASE_MODE: "remtoe" },
    { PACKSCOUT_DATABASE_MODE: "" }, { NODE_ENV: "production" },
    { PACKSCOUT_PROVIDER_DATABASE_ALLOWED_HOSTS: "*.example.test" },
    { PACKSCOUT_PROVIDER_DATABASE_ALLOWED_HOSTS: undefined },
    { PACKSCOUT_CENTRAL_DATABASE_ALLOWED_HOSTS: "*.example.test" },
    { PACKSCOUT_CENTRAL_DATABASE_ALLOWED_HOSTS: undefined },
    { PACKSCOUT_CENTRAL_DATABASE_URL: environment().PACKSCOUT_CENTRAL_DATABASE_URL.replace("control.example.test", "other.example.test") },
    { PACKSCOUT_CENTRAL_DATABASE_URL: environment().PACKSCOUT_CENTRAL_DATABASE_URL.replace(":5432/", ":55431/") },
    { PACKSCOUT_CENTRAL_DATABASE_URL: environment().PACKSCOUT_CENTRAL_DATABASE_URL.replace("/packscout?", "/postgres?") },
    { PACKSCOUT_CENTRAL_DATABASE_URL: environment().PACKSCOUT_CENTRAL_DATABASE_URL.replace("&sslaccept=strict", "") },
    { PACKSCOUT_CENTRAL_DATABASE_URL: environment().PACKSCOUT_CENTRAL_DATABASE_URL.replace("sslaccept=strict", "sslaccept=accept_invalid_certs") },
    { PACKSCOUT_CENTRAL_DATABASE_URL: environment().PACKSCOUT_CENTRAL_DATABASE_URL.replace("sslmode=require", "sslmode=disable") },
  ]) await assert.rejects(readBackfillEnvironment({ ...environment(), ...patch }, {}), error => {
    assert.match(error.message, /^BACKFILL_[A-Z_]+$/u);
    assert.equal(error.message.includes("synthetic-secret"), false);
    return true;
  });
});

test("local defaults stay pinned and a remote mode in the file cannot override explicit local intent", async () => {
  const env = await readBackfillEnvironment({ ...environment(), PACKSCOUT_DATABASE_MODE: "local",
    PACKSCOUT_CENTRAL_DATABASE_URL: "postgresql://app:synthetic-secret@127.0.0.1:55431/packscout" }, environment());
  assert.equal(env.runtimePolicy.mode, "local");
  assert.equal(env.workerEnvironment.PACKSCOUT_DATABASE_MODE, "local");
  assert.doesNotThrow(() => assertBackfillDestination("phygitals", {
    node: { host: "127.0.0.1", port: 55435, sslMode: "disable" }, target: { databaseName: "packscout_phygitals" },
  }, env.runtimePolicy));
  assert.throws(() => assertBackfillDestination("phygitals", route(), env.runtimePolicy), /BACKFILL_LOCAL_PROVIDER_ROUTE_REQUIRED/);
  env.key.fill(0);
});

test("historical review loader refuses valid remote configurations without changing generic remote support", async () => {
  await assert.rejects(readLocalBackfillEnvironment(environment(), {}), /BACKFILL_LOCAL_CENTRAL_REQUIRED/);
  await assert.rejects(readLocalBackfillEnvironment({}, environment()), /BACKFILL_LOCAL_CENTRAL_REQUIRED/);
  const local = await readLocalBackfillEnvironment({ ...environment(), PACKSCOUT_DATABASE_MODE: "local",
    PACKSCOUT_CENTRAL_DATABASE_URL: "postgresql://app:synthetic-secret@127.0.0.1:55431/packscout" }, {});
  assert.equal(local.runtimePolicy.mode, "local");
  local.key.fill(0);
  const remote = await readBackfillEnvironment(environment(), {});
  assert.equal(remote.runtimePolicy.mode, "remote");
  remote.key.fill(0);
});

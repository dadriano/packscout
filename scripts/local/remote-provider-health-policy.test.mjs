import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { tsImport } from "tsx/esm/api";
import { remoteHealthFixture, centralAuthorityFixture, environmentFixture, id, secret } from "./remote-provider-health-test-fixture.mjs";
const policy = await tsImport("./remote-provider-health-policy.mts", import.meta.url);
const { readRemoteHealthPrivateFile, assertRemoteHealthSourceState, assertRemoteHealthEvidence } = await tsImport("./remote-provider-health-files.mts", import.meta.url);
const { parseRemoteHealthArguments, inspectRemoteHealthProviders } = await tsImport("./inspect-remote-provider-import-health.mts", import.meta.url);
const { readBackfillEnvironment } = await tsImport("./provider-backfill-supervisor-authority.mts", import.meta.url);

test("strict private scope pins each provider once and refuses unknown fields or weak pins", async () => {
  const f = await remoteHealthFixture();
  assert.deepEqual(policy.parseRemoteHealthScope(f.scope), f.scope);
  for (const change of [s => { s.sourceCommit = "main"; }, s => { s.migrationEvidence.sha256 = "unknown"; },
    s => { s.centralHost = "*.example.test"; }, s => { s.providers = []; }, s => { s.providers.push(s.providers[0]); },
    s => { s.providers[0].configNumber = "0"; }, s => { s.providers[0].routeDigest = "short"; },
    s => { s.operatorId = "not-an-operator"; }, s => { s.credential = secret; }]) {
    const scope = structuredClone(f.scope); change(scope);
    assert.throws(() => policy.parseRemoteHealthScope(scope), /REMOTE_HEALTH_SCOPE_INVALID/);
  }
  assert.equal(parseRemoteHealthArguments(["--scope-file", "/private/scope.json"]), "/private/scope.json");
  for (const args of [[], ["--scope-file", "relative.json"], ["--scope-file", "/private/scope.json", "--apply"]]) {
    assert.throws(() => parseRemoteHealthArguments(args), /REMOTE_HEALTH_ARGUMENTS_INVALID/);
  }
});
test("wrong mode, host or TLS is refused before any authority read or provider connection", async () => {
  const f = await remoteHealthFixture(); let calls = 0;
  const dependencies = { readAuthority: async () => { calls++; }, run: async () => { calls++; } };
  for (const patch of [
    { runtimePolicy: { ...f.environment.runtimePolicy, mode: "local" } },
    { centralDatabaseUrl: f.environment.centralDatabaseUrl.replace("central.example.test", "other.example.test") },
    { centralDatabaseUrl: f.environment.centralDatabaseUrl.replace("&sslaccept=strict", "") },
    { centralDatabaseUrl: f.environment.centralDatabaseUrl.replace("sslmode=require", "sslmode=disable") },
  ]) await assert.rejects(inspectRemoteHealthProviders(f.scope, { ...f.environment, ...patch }, dependencies), /REMOTE_HEALTH_/);
  const scope = { ...f.scope, centralHost: "other.example.test" };
  await assert.rejects(inspectRemoteHealthProviders(scope, f.environment, dependencies), /REMOTE_HEALTH_CENTRAL_HOST_CHANGED/);
  await assert.rejects(inspectRemoteHealthProviders({ ...f.scope, providers: [{ ...f.pin, routeHost: "other.example.test" }] },
    f.environment, dependencies), /REMOTE_HEALTH_DATABASE_POLICY_INVALID/);
  assert.equal(calls, 0);
  // Exercise the real environment parser, explicitly supplying synthetic file contents (never reading .env).
  await assert.rejects(readBackfillEnvironment({ ...environmentFixture(), PACKSCOUT_DATABASE_MODE: "local" }, {}));
});
test("full route digest binds tenant, host, TLS, revisions and encrypted credential bytes", async () => {
  const f = await remoteHealthFixture();
  policy.assertRemoteHealthAuthority(f.scope, f.pin, f.authority, f.environment.runtimePolicy);
  for (const change of [a => { a.route.organizationId = id(50); }, a => { a.route.target.providerId = id(50); },
    a => { a.route.target.providerKey = "courtyard"; }, a => { a.route.node.host = "other.example.test"; },
    a => { a.route.node.sslMode = "require"; }, a => { a.route.node.port = 55432; },
    a => { a.route.node.encryptedCredential.ciphertext[0] ^= 1; }, a => { a.route.node.rowVersion++; },
    a => { a.route.configVersionId = id(50); }, a => { a.configNumber++; }]) {
    const authority = structuredClone(f.authority); change(authority);
    assert.throws(() => policy.assertRemoteHealthAuthority(f.scope, f.pin, authority, f.environment.runtimePolicy), /REMOTE_HEALTH_AUTHORITY_CHANGED/);
  }
  const safe = JSON.stringify(policy.remoteHealthRoutePins(f.authority.route), (_key, value) => typeof value === "bigint" ? String(value) : value);
  assert.equal(safe.includes(secret), false); assert.equal(safe.includes("encryptedCredential"), false);
});
test("shared authority enforces active admin, organization, provider, configuration and integration registry", async () => {
  const f = await remoteHealthFixture();
  assert.equal((await centralAuthorityFixture(f).read()).configNumber, 3n);
  for (const change of [d => { d.membership = null; }, d => { d.provider = null; },
    d => { d.provider.organization_id = id(50); }, d => { d.provider.provider_key = "courtyard"; },
    d => { d.provider.lifecycle = "disabled"; }, d => { d.provider.active_config_version_id = id(50); },
    d => { d.config.adapter_key = "unregistered-adapter"; }, d => { d.config.configuration.platform = "courtyard"; },
    d => { d.config.provider_id = id(50); }, d => { d.config.source_credential.lifecycle = "revoked"; }]) {
    const fixture = centralAuthorityFixture(f); change(fixture.data);
    await assert.rejects(fixture.read());
  }
});
test("private scope and evidence readers reject symlinks, broad modes and oversized files", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "remote-health-files-"));
  const file = path.join(directory, "proof.json"), link = path.join(directory, "link.json");
  try {
    await writeFile(file, "proof", { mode: 0o600 });
    assert.equal((await readRemoteHealthPrivateFile(file, 5)).toString(), "proof");
    await assert.rejects(readRemoteHealthPrivateFile(file, 4), /REMOTE_HEALTH_PRIVATE_FILE_INVALID/);
    await symlink(file, link); await assert.rejects(readRemoteHealthPrivateFile(link, 5));
    await chmod(file, 0o644); await assert.rejects(readRemoteHealthPrivateFile(file, 5), /REMOTE_HEALTH_PRIVATE_FILE_INVALID/);
  } finally { await rm(directory, { recursive: true, force: true }); }
  const f = await remoteHealthFixture();
  assertRemoteHealthSourceState(f.scope, f.scope.sourceCommit, "");
  const evidence = Buffer.from("reviewed opaque evidence");
  f.scope.migrationEvidence.sha256 = createHash("sha256").update(evidence).digest("hex");
  assertRemoteHealthEvidence(f.scope, evidence);
  assert.throws(() => assertRemoteHealthEvidence(f.scope, Buffer.from("changed evidence")), /REMOTE_HEALTH_MIGRATION_EVIDENCE_CHANGED/);
  for (const [head, status] of [["b".repeat(40), ""], [f.scope.sourceCommit, " M scripts/local/example.mts"],
    [f.scope.sourceCommit, "?? scripts/local/unreviewed.mts"]]) {
    assert.throws(() => assertRemoteHealthSourceState(f.scope, head, status), /REMOTE_HEALTH_SOURCE_REVISION_CHANGED/);
  }
  assert.equal(policy.remoteHealthFailureCode(new Error(`postgres://${secret}@host`)), "REMOTE_HEALTH_READ_UNAVAILABLE");
});

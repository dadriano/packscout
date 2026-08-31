import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, chmod, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { tsImport } from "tsx/esm/api";
const { canonicalJson } = await tsImport("@packscout/contracts", import.meta.url);
const { providerHeadPeerScopeOption, verifyProviderHeadPeerProcessScope, readProviderHeadPeerFile,
  ProviderHeadPeerScopeError } = await tsImport("./provider-head-process-scope.mts", import.meta.url);
const digest = value => createHash("sha256").update(value).digest("hex");
const id = n => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const now = "2026-08-31T16:00:30.000Z";
function fixture({ active = false, peers = 1 } = {}) {
  const protectedPins = { organizationId: id(1), operatorId: id(2), providerId: id(3),
    providerKey: "clutchpacks", configId: id(4), initialRunId: id(5), operationId: id(6) };
  const scope = { schemaVersion: 1, issuedAt: "2026-08-31T16:00:00.000Z", notAfter: "2026-08-31T16:02:00.000Z", protectedPins, peers: [] };
  const files = new Map(), authorities = [], gates = [], plists = [], processes = [];
  const pin = (file, value) => { const bytes = typeof value === "string" ? value : JSON.stringify(value); files.set(file, bytes); return { path: file, sha256: digest(bytes) }; };
  for (let i = 0; i < peers; i++) {
    const checkout = `/review/peer-${i}`;
    const pins = { ...protectedPins, providerId: id(10 + i), providerKey: ["courtyard", "collector_crypt", "phygitals"][i], configId: id(20 + i),
      initialRunId: id(30 + i), operationId: id(40 + i) };
    const argv = ["/usr/bin/node", "--import", "tsx", `${checkout}/scripts/local/run-provider-continuous-poller.mts`,
      "--run", "--launchd", "--bootstrap-backfill", "--organization-id", pins.organizationId, "--provider-id", pins.providerId,
      "--provider-key", pins.providerKey, "--config-id", pins.configId, "--initial-run-id", pins.initialRunId,
      "--operation-id", pins.operationId, "--operator-id", pins.operatorId];
    const root = { pid: 100 + i * 10, parentPid: 1, startedAt: "Sun Aug 30 10:00:00 2026", cwd: checkout, argv };
    const child = active ? { pid: root.pid + 1, parentPid: root.pid, startedAt: "Sun Aug 30 10:00:01 2026", cwd: checkout,
      argv: [argv[0], "--import", "tsx", `${checkout}/apps/worker/src/provider-manual-import-local.ts`] } : null;
    const sourceCommit = "a".repeat(40), routeDigest = "b".repeat(64), authorityDigest = "c".repeat(64);
    const owner = active ? `local:backfill:${pins.operationId}:${id(50 + i)}` : null;
    const authority = { schemaVersion: 1, observedAt: "2026-08-31T15:59:59.000Z", pins, configNumber: "4", routeDigest, authorityDigest,
      database: { organizationId: pins.organizationId, providerId: pins.providerId, providerKey: pins.providerKey,
        databaseName: `packscout_${pins.providerKey}`, role: "provider", schemaVersion: "distributed-provider-v1" },
      operation: { operationId: pins.operationId, authorityDigest, pinsSha256: digest(canonicalJson(pins)) },
      lease: { role: "import", owner, fence: "12", expiresAt: active ? "2026-08-31T16:05:00.000Z" : null },
      executionClaim: active ? { operationId: pins.operationId, owner, fence: "12", authorityDigest, outcome: "success" } : null };
    const gate = { schemaVersion: 1, sourceCommit, command: "npm run verify:framework", exitCode: 0,
      completedAt: "2026-08-31T15:00:00.000Z", logSha256: "d".repeat(64) };
    const plist = { ProgramArguments: argv, WorkingDirectory: checkout, EnvironmentVariables: { NODE_ENV: "development", PATH: "/usr/bin" } };
    const peer = { pins, checkout, sourceCommit, routeDigest, authorityDigest, configNumber: "4",
      environment: pin(`${checkout}/.env`, "SYNTHETIC_SECRET=never-print-this\n"),
      plist: pin(`/review/peer-${i}.plist`, "synthetic-plist"),
      gateEvidence: pin(`/review/peer-${i}-gate.json`, gate), authorityEvidence: pin(`/review/peer-${i}-authority.json`, authority),
      expectedWorkerOwner: owner, expectedWorkerFence: "12", root, child };
    scope.peers.push(peer); authorities.push(authority); gates.push(gate); plists.push(plist);
    processes.push(root); if (child) processes.push(child);
  }
  const options = { file: "/review/scope.json", digest: "", protectedPins, ownPid: 999 };
  const state = { time: now, psReads: 0, commands: [], hook: undefined };
  const refresh = () => {
    scope.peers.forEach((peer, i) => { peer.authorityEvidence = pin(peer.authorityEvidence.path, authorities[i]); peer.gateEvidence = pin(peer.gateEvidence.path, gates[i]); });
    options.digest = pin(options.file, scope).sha256;
  };
  const dep = { now: () => new Date(state.time),
    read: async file => { if (!files.has(file)) throw new Error("unexpected fixture read"); return Buffer.from(files.get(file)); },
    command: async (file, args) => {
      state.commands.push({ file, args }); state.hook?.(file, args);
      if (file === "/bin/ps") { state.psReads++; return processes.map(p => `${p.pid} ${p.parentPid} ${p.startedAt} ${p.argv.join(" ")}`).join("\n"); }
      if (file === "/usr/bin/git") return args.includes("rev-parse") ? scope.peers[0].sourceCommit : "";
      if (file === "/usr/bin/plutil") return JSON.stringify(plists[scope.peers.findIndex(p => p.plist.path === args.at(-1))]);
      if (file === "/usr/sbin/lsof") return `p${args[2]}\nn${processes.find(p => p.pid === Number(args[2])).cwd}\n`;
      throw new Error("unexpected fixture command");
    } };
  refresh(); return { scope, options, dep, files, authorities, gates, plists, processes, state, refresh, pin };
}
function code(expected) { return error => error instanceof ProviderHeadPeerScopeError && error.code === expected; }
test("peer scope is opt-in and both reviewed environment pins are required together", () => {
  assert.equal(providerHeadPeerScopeOption({}), null);
  assert.deepEqual(providerHeadPeerScopeOption({ PACKSCOUT_PROVIDER_HEAD_PEER_SCOPE_FILE: "/review/scope.json",
    PACKSCOUT_PROVIDER_HEAD_PEER_SCOPE_SHA256: "a".repeat(64) }), { file: "/review/scope.json", digest: "a".repeat(64) });
  for (const environment of [{ PACKSCOUT_PROVIDER_HEAD_PEER_SCOPE_FILE: "/review/scope.json" },
    { PACKSCOUT_PROVIDER_HEAD_PEER_SCOPE_SHA256: "a".repeat(64) }, { PACKSCOUT_PROVIDER_HEAD_PEER_SCOPE_FILE: "relative",
      PACKSCOUT_PROVIDER_HEAD_PEER_SCOPE_SHA256: "a".repeat(64) }]) assert.throws(() => providerHeadPeerScopeOption(environment), code("PEER_SCOPE_OPTION_INVALID"));
});
test("private reviewed waiting and active peer trees pass without database or source calls", async () => {
  for (const active of [false, true]) {
    const f = fixture({ active, peers: 3 }); const result = await verifyProviderHeadPeerProcessScope(f.options, f.dep);
    assert.equal(result.acceptedPeerCount, 3); assert.equal(result.acceptedProcessCount, active ? 6 : 3);
    assert.equal(f.state.psReads, 2);
    assert.ok(f.state.commands.every(c => ["/bin/ps", "/usr/bin/git", "/usr/bin/plutil", "/usr/sbin/lsof"].includes(c.file)));
    assert.ok(!JSON.stringify(result).includes("never-print-this"));
  }
});
test("authority identity, config, route, operation and exact lease claim are mandatory", async () => {
  const changes = [a => { a.database.providerId = id(900); }, a => { a.database.organizationId = id(901); },
    a => { a.database.databaseName = "packscout_other"; }, a => { a.configNumber = "5"; }, a => { a.routeDigest = "f".repeat(64); },
    a => { a.authorityDigest = "f".repeat(64); }, a => { a.operation.operationId = id(902); },
    a => { a.operation.pinsSha256 = "f".repeat(64); }, a => { a.lease.fence = "13"; }, a => { a.lease.owner = "foreign"; }];
  for (const change of changes) {
    const f = fixture({ active: true }); change(f.authorities[0]); f.refresh();
    await assert.rejects(verifyProviderHeadPeerProcessScope(f.options, f.dep), code("PEER_SCOPE_AUTHORITY_CHANGED"));
  }
  for (const change of [a => { a.executionClaim = null; }, a => { a.executionClaim.fence = "13"; },
    a => { a.executionClaim.owner = "foreign"; }, a => { a.lease.expiresAt = now; }]) {
    const f = fixture({ active: true }); change(f.authorities[0]); f.refresh();
    await assert.rejects(verifyProviderHeadPeerProcessScope(f.options, f.dep), code("PEER_SCOPE_UNPROVEN_LEASE"));
  }
});
test("waiting peers cannot hide a leased worker and active children cannot lack a lease", async () => {
  for (const active of [false, true]) {
    const f = fixture({ active });
    f.scope.peers[0].expectedWorkerOwner = active ? null : `local:backfill:${f.scope.peers[0].pins.operationId}:${id(50)}`;
    f.authorities[0].lease.owner = f.scope.peers[0].expectedWorkerOwner; f.refresh();
    await assert.rejects(verifyProviderHeadPeerProcessScope(f.options, f.dep), code("PEER_SCOPE_UNPROVEN_LEASE"));
  }
});
test("stale evidence and expired first-peer lease during later peer checks fail final revalidation", async () => {
  const stale = fixture(); stale.authorities[0].observedAt = "2026-08-31T15:58:00.000Z"; stale.refresh();
  await assert.rejects(verifyProviderHeadPeerProcessScope(stale.options, stale.dep), code("PEER_SCOPE_AUTHORITY_CHANGED"));
  const f = fixture({ active: true, peers: 2 }); f.authorities[0].lease.expiresAt = "2026-08-31T16:00:40.000Z"; f.refresh();
  f.state.hook = (file, args) => { if (file === "/usr/sbin/lsof" && args[2] === "110") f.state.time = "2026-08-31T16:00:41.000Z"; };
  await assert.rejects(verifyProviderHeadPeerProcessScope(f.options, f.dep), code("PEER_SCOPE_UNPROVEN_LEASE"));
  assert.equal(f.state.psReads, 2);
});
test("proof expiration and newly appeared writer during verification fail closed", async () => {
  for (const expire of [true, false]) {
    const f = fixture(); f.state.hook = file => { if (file === "/bin/ps" && f.state.psReads === 1) {
      if (expire) f.state.time = f.scope.notAfter;
      else f.processes.push({ pid: 555, parentPid: 1, startedAt: f.processes[0].startedAt,
        argv: ["/usr/bin/node", "--import", "tsx", "/other/apps/worker/src/provider-manual-import-local.ts"] });
    } };
    await assert.rejects(verifyProviderHeadPeerProcessScope(f.options, f.dep), code(expire ? "PEER_SCOPE_EXPIRED" : "PEER_SCOPE_UNKNOWN_WRITER"));
  }
});
test("changed reviewed files, dirty source, environment lanes and plist injection are rejected", async () => {
  for (const field of ["environment", "plist", "authorityEvidence", "gateEvidence"]) {
    const f = fixture(); f.files.set(f.scope.peers[0][field].path, "changed-never-print-this");
    await assert.rejects(verifyProviderHeadPeerProcessScope(f.options, f.dep), code("PEER_SCOPE_FILE_CHANGED"));
  }
  const dirty = fixture(); const command = dirty.dep.command;
  dirty.dep.command = async (file, args) => file === "/usr/bin/git" && args.includes("status") ? " M source.ts\n" : command(file, args);
  await assert.rejects(verifyProviderHeadPeerProcessScope(dirty.options, dirty.dep), code("PEER_SCOPE_SOURCE_CHANGED"));
  for (const content of ["PACKSCOUT_PROVIDER_LANES_JSON=[]\n", "PACKSCOUT_PROVIDER_ID=wrong\n", "PACKSCOUT_PROVIDER_KEY=wrong\n"]) {
    const f = fixture(); f.scope.peers[0].environment = f.pin(f.scope.peers[0].environment.path, content); f.refresh();
    await assert.rejects(verifyProviderHeadPeerProcessScope(f.options, f.dep), code("PEER_SCOPE_ENVIRONMENT_INVALID"));
  }
  const injected = fixture(); injected.plists[0].EnvironmentVariables.NODE_OPTIONS = "--require unwanted";
  await assert.rejects(verifyProviderHeadPeerProcessScope(injected.options, injected.dep), code("PEER_SCOPE_PLIST_CHANGED"));
});
test("wrong final cwd, source commit and invalid JSON retain stable redacted failures", async () => {
  for (const [program, output, expected] of [["/usr/sbin/lsof", "p100\nn/other\n", "PEER_SCOPE_CWD_CHANGED"],
    ["/usr/bin/git", "b".repeat(40), "PEER_SCOPE_SOURCE_CHANGED"]]) {
    const f = fixture(); const command = f.dep.command;
    f.dep.command = async (file, args) => file === program ? output : command(file, args);
    await assert.rejects(verifyProviderHeadPeerProcessScope(f.options, f.dep), code(expected));
  }
  const invalid = fixture(); invalid.options.digest = invalid.pin(invalid.options.file, '{"secret":"never-print-this"').sha256;
  await assert.rejects(verifyProviderHeadPeerProcessScope(invalid.options, invalid.dep), error =>
    code("PEER_SCOPE_DOCUMENT_INVALID")(error) && !error.message.includes("never-print-this"));
  const unavailable = fixture(); unavailable.dep.command = async () => { throw new Error("never-print-this"); };
  await assert.rejects(verifyProviderHeadPeerProcessScope(unavailable.options, unavailable.dep), error =>
    code("PEER_SCOPE_VERIFICATION_UNAVAILABLE")(error) && !error.message.includes("never-print-this"));
});
test("private file reader refuses symlinks, permissive mode and oversized evidence", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "packscout-peer-scope-"));
  try {
    const file = path.join(directory, "scope.json"), link = path.join(directory, "link.json");
    await writeFile(file, "{}", { mode: 0o600 }); assert.equal(Buffer.from(await readProviderHeadPeerFile(file, true)).toString(), "{}");
    await symlink(file, link); await assert.rejects(readProviderHeadPeerFile(link, true));
    await chmod(file, 0o644); await assert.rejects(readProviderHeadPeerFile(file, true), code("PEER_SCOPE_PRIVATE_FILE_INVALID"));
    assert.equal(Buffer.from(await readProviderHeadPeerFile(file, false)).toString(), "{}");
    await chmod(file, 0o600); await writeFile(file, "x".repeat(262145));
    await assert.rejects(readProviderHeadPeerFile(file, true), code("PEER_SCOPE_PRIVATE_FILE_INVALID"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

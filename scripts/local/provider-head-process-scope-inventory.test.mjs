import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const { providerHeadPeerScopeSchema, parseProviderHeadProcesses, assertProviderHeadProcessScope,
  providerHeadWriterCommand, ProviderHeadPeerScopeError } = await tsImport("./provider-head-process-scope.mts", import.meta.url);

const uuid = value => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const protectedPins = { organizationId: uuid(1), providerId: uuid(2), providerKey: "clutchpacks",
  configId: uuid(3), initialRunId: uuid(4), operationId: uuid(5), operatorId: uuid(6) };
const rootStarted = "Mon Aug 31 09:00:00 2026", childStarted = "Mon Aug 31 09:00:10 2026";
const now = new Date("Mon Aug 31 09:01:00 2026"), node = "/fixture/bin/node";
const file = name => ({ path: name, sha256: "a".repeat(64) });
function peer(index = 0, child = true) {
  const key = ["courtyard", "collector_crypt", "phygitals"][index], checkout = `/fixture/${key}`;
  const pins = { ...protectedPins, providerId: uuid(10 + index * 10), providerKey: key,
    configId: uuid(11 + index * 10), initialRunId: uuid(12 + index * 10), operationId: uuid(13 + index * 10) };
  const root = { pid: 100 + index * 10, parentPid: 1, startedAt: rootStarted, cwd: checkout,
    argv: [node, "--import", "tsx", `${checkout}/scripts/local/run-provider-continuous-poller.mts`,
      "--run", "--launchd", "--bootstrap-backfill", "--organization-id", pins.organizationId,
      "--provider-id", pins.providerId, "--provider-key", pins.providerKey, "--config-id", pins.configId,
      "--initial-run-id", pins.initialRunId, "--operation-id", pins.operationId, "--operator-id", pins.operatorId] };
  return { pins, checkout, sourceCommit: "b".repeat(40), environment: file(`${checkout}/.env`),
    plist: file(`/fixture/${key}.plist`), gateEvidence: file(`/fixture/${key}-gate.json`),
    authorityEvidence: file(`/fixture/${key}-authority.json`), routeDigest: "c".repeat(64), authorityDigest: "d".repeat(64),
    configNumber: "4", expectedWorkerOwner: child ? `local:backfill:${pins.operationId}:${uuid(90 + index)}` : null,
    expectedWorkerFence: "51", root, child: child ? { pid: root.pid + 1, parentPid: root.pid, startedAt: childStarted,
      cwd: checkout, argv: [node, "--import", "tsx", `${checkout}/apps/worker/src/provider-manual-import-local.ts`] } : null };
}
const processRow = pin => ({ pid: pin.pid, parentPid: pin.parentPid, startedAt: pin.startedAt, command: pin.argv.join(" ") });
function fixture(peers = [peer()]) {
  const scope = providerHeadPeerScopeSchema.parse({ schemaVersion: 1, issuedAt: now.toISOString(),
    notAfter: new Date(now.getTime() + 60_000).toISOString(), protectedPins, peers });
  return { scope, protectedPins: structuredClone(protectedPins), now: new Date(now), ownPid: 900,
    processes: peers.flatMap(value => [value.root, value.child].filter(Boolean).map(processRow)) };
}
const refuses = (input, code) => assert.throws(() => assertProviderHeadProcessScope(input),
  error => error instanceof ProviderHeadPeerScopeError && error.code === code);
function productionFixture() {
  const value = peer(0, false); value.pins.providerKey = "clutchpacks";
  value.root.argv[3] = `${value.checkout}/scripts/live/run-clutchpacks-production-poller.mts`;
  value.root.argv.splice(value.root.argv.indexOf("--bootstrap-backfill"), 1);
  value.root.argv[value.root.argv.indexOf("--provider-key") + 1] = value.pins.providerKey;
  value.root.argv.push("--poll-interval-seconds", "60");
  const input = fixture([value]); input.protectedPins.providerKey = "courtyard";
  input.scope.protectedPins.providerKey = "courtyard";
  return input;
}

test("exact initial-bootstrap roots and their direct worker children are the only admitted peer inventory", () => {
  const one = fixture();
  assert.deepEqual(assertProviderHeadProcessScope(one), { acceptedPeerCount: 1, acceptedProcessCount: 2 });
  const three = fixture([peer(0), peer(1, false), peer(2)]);
  assert.deepEqual(assertProviderHeadProcessScope(three), { acceptedPeerCount: 3, acceptedProcessCount: 5 });
  const waiting = fixture([peer(0, false)]);
  assert.deepEqual(assertProviderHeadProcessScope(waiting), { acceptedPeerCount: 1, acceptedProcessCount: 1 });
  waiting.processes.push(processRow(peer().child));
  refuses(waiting, "PEER_SCOPE_UNKNOWN_WRITER");
});

test("only the exact reviewed live production wrapper is admitted with its pinned continuous cadence", () => {
  const input = productionFixture();
  assert.deepEqual(assertProviderHeadProcessScope(input), { acceptedPeerCount: 1, acceptedProcessCount: 1 });
  const bootstrap = productionFixture(); bootstrap.scope.peers[0].root.argv.splice(6, 0, "--bootstrap-backfill");
  bootstrap.processes[0] = processRow(bootstrap.scope.peers[0].root);
  refuses(bootstrap, "PEER_SCOPE_ROOT_INVALID");
  const local = fixture(); local.scope.peers[0].root.argv.push("--poll-interval-seconds", "60");
  local.processes[0] = processRow(local.scope.peers[0].root);
  refuses(local, "PEER_SCOPE_ROOT_INVALID");
  local.scope.peers[0].root.argv.splice(6, 1);
  local.processes[0] = processRow(local.scope.peers[0].root);
  assert.equal(assertProviderHeadProcessScope(local).acceptedPeerCount, 1);
  for (const change of [p => { p.root.argv[3] = `${p.checkout}/scripts/local/run-clutchpacks-production-poller.mts`; },
    p => { p.root.argv[3] = "/foreign/scripts/live/run-clutchpacks-production-poller.mts"; },
    p => { p.root.argv[3] = `${p.checkout}/scripts/live/unreviewed-production-poller.mts`; },
    p => { p.root.argv[p.root.argv.indexOf("--provider-key") + 1] = "phygitals"; },
    p => { p.root.argv[p.root.argv.indexOf("--config-id") + 1] = uuid(999); },
    p => { p.root.argv[p.root.argv.indexOf("--operation-id") + 1] = uuid(998); },
    p => { p.root.argv[p.root.argv.indexOf("--poll-interval-seconds") + 1] = "59"; },
    p => { p.root.argv[p.root.argv.indexOf("--poll-interval-seconds") + 1] = "86401"; },
    p => { p.root.argv[p.root.argv.indexOf("--poll-interval-seconds") + 1] = "060"; },
    p => { p.root.argv.push("--poll-interval-seconds", "60"); },
    p => { p.root.argv.push("--unknown"); }, p => { p.root.argv.splice(p.root.argv.indexOf("--launchd"), 1); }]) {
    const changed = productionFixture(); change(changed.scope.peers[0]);
    changed.processes[0] = processRow(changed.scope.peers[0].root);
    refuses(changed, "PEER_SCOPE_ROOT_INVALID");
  }
});

test("production wrapper basenames cannot hide foreign or ambiguous writers behind provider flags or check-only", () => {
  for (const entry of ["/foreign/scripts/live/run-clutchpacks-production-poller.mts",
    "/foreign/scripts/local/run-clutchpacks-production-poller.mts", "run-clutchpacks-production-poller.mts"]) {
    for (const flags of ["--run --provider-key courtyard", "--check-only", "--run --check-only", "--unknown"]) {
      const input = fixture(), command = `${node} --import tsx ${entry} ${flags}`;
      assert.equal(providerHeadWriterCommand(command), true);
      input.processes.push({ pid: 777, parentPid: 1, startedAt: childStarted, command });
      refuses(input, "PEER_SCOPE_UNKNOWN_WRITER");
    }
  }
});

test("a detached or active production publisher never becomes an implicitly admitted peer child", () => {
  for (const parentPid of [1, 100]) for (const flags of ["--publish /private/synthetic-bundle.json", "--check-only"]) {
    const input = productionFixture();
    const command = `${node} --import tsx /foreign/scripts/live/promote-clutchpacks-production.mts ${flags}`;
    assert.equal(providerHeadWriterCommand(command), true);
    input.processes.push({ pid: 777, parentPid, startedAt: childStarted, command });
    refuses(input, "PEER_SCOPE_UNKNOWN_WRITER");
  }
  const input = productionFixture(); input.scope.peers[0].child = { pid: 777, parentPid: 100, startedAt: childStarted,
    cwd: input.scope.peers[0].checkout, argv: [node, "--import", "tsx",
      `${input.scope.peers[0].checkout}/scripts/live/promote-clutchpacks-production.mts`, "--publish", "/private/synthetic-bundle.json"] };
  input.processes.push(processRow(input.scope.peers[0].child));
  refuses(input, "PEER_SCOPE_CHILD_INVALID");
});

test("scope schema rejects unbounded, unknown and malformed process evidence", () => {
  const good = fixture().scope;
  for (const change of [value => { value.schemaVersion = 2; }, value => { value.extra = true; },
    value => { value.peers = []; }, value => { value.peers.push(peer(1), peer(2), peer(0)); },
    value => { value.peers[0].root.pid = 0; }, value => { value.peers[0].root.parentPid = -1; },
    value => { value.peers[0].root.argv = []; }, value => { value.peers[0].root.extra = true; },
    value => { value.peers[0].environment.path = "relative/.env"; }, value => { value.peers[0].sourceCommit = "bad"; },
    value => { value.peers[0].root.startedAt = "unknown"; }, value => { value.protectedPins.extra = true; }]) {
    const value = structuredClone(good); change(value); assert.equal(providerHeadPeerScopeSchema.safeParse(value).success, false);
  }
});

test("protected provider, organization, operator, operation and duplicate peer identities cannot be excepted", () => {
  for (const key of ["providerId", "providerKey", "organizationId", "operatorId", "operationId"]) {
    const input = fixture();
    input.scope.peers[0].pins[key] = ["organizationId", "operatorId"].includes(key) ? uuid(999) : protectedPins[key];
    refuses(input, "PEER_SCOPE_PROVIDER_INVALID");
  }
  for (const key of ["providerId", "providerKey"]) {
    const input = fixture([peer(), peer(1)]); input.scope.peers[1].pins[key] = input.scope.peers[0].pins[key];
    refuses(input, "PEER_SCOPE_PROVIDER_INVALID");
  }
  const changed = fixture(); changed.protectedPins.operationId = uuid(999);
  refuses(changed, "PEER_SCOPE_PROTECTED_OPERATION_CHANGED");
});

test("PID reuse, changed parentage, exits and changed argv refuse the observed process", () => {
  for (const index of [0, 1]) for (const change of [row => { row.pid += 1000; }, row => { row.parentPid += 1000; },
    row => { row.startedAt = "Mon Aug 31 09:00:11 2026"; }, row => { row.command += " --unexpected"; }]) {
    const input = fixture(); change(input.processes[index]); refuses(input, "PEER_SCOPE_PROCESS_CHANGED");
  }
  for (const index of [0, 1]) {
    const input = fixture(); input.processes.splice(index, 1); refuses(input, "PEER_SCOPE_PROCESS_CHANGED");
  }
});

test("reviewed lineage must retain the exact bootstrap entry, flags, cwd and direct-child binding", () => {
  for (const change of [p => { p.root.cwd = "/foreign"; }, p => { p.environment.path = "/foreign/.env"; },
    p => { p.root.argv[0] = "/fixture/bin/tsx"; }, p => { p.root.argv.splice(6, 1); },
    p => { p.root.argv[5] = "--check-only"; }, p => { p.root.argv[9] = "--foreign-provider"; },
    p => { p.root.argv.push("--extra"); }, p => { p.root.startedAt = "Mon Aug 31 10:00:00 2026"; }]) {
    const input = fixture(); change(input.scope.peers[0]); refuses(input, "PEER_SCOPE_ROOT_INVALID");
  }
  for (const change of [p => { p.child.parentPid = 1; }, p => { p.child.cwd = "/foreign"; },
    p => { p.child.argv[3] = "/foreign/provider-manual-import-local.ts"; }, p => { p.child.argv.push("--lanes"); },
    p => { p.child.startedAt = "Mon Aug 31 08:59:59 2026"; }, p => { p.child.startedAt = "Mon Aug 31 10:00:00 2026"; },
    p => { p.child.pid = p.root.pid; }]) {
    const input = fixture(); change(input.scope.peers[0]); refuses(input, "PEER_SCOPE_CHILD_INVALID");
  }
  const ownRoot = fixture(); ownRoot.ownPid = ownRoot.scope.peers[0].root.pid;
  refuses(ownRoot, "PEER_SCOPE_ROOT_INVALID");
  const ownChild = fixture(); ownChild.ownPid = ownChild.scope.peers[0].child.pid;
  refuses(ownChild, "PEER_SCOPE_CHILD_INVALID");
});

test("all unreviewed import, source, promotion and multi-lane-capable worker entries refuse", () => {
  for (const entry of ["apps/worker/src/provider-manual-import-local.ts", "apps/worker/src/clutchpacks-manual-import-local.ts",
    "apps/worker/src/source-supervisor-local.ts", "scripts/local/start-provider-source-task010-supervisor.mts",
    "scripts/local/provider-promotion-local.mts", "scripts/local/promote-distributed-courtyard-to-local-convex.mts",
    "apps/worker/src/index.ts", "apps/worker/src/main.mts", "scripts/local/run-provider-backfill-supervisor.mts",
    "scripts/local/provider-resident-maintenance.mts", "scripts/local/provider-failed-head-resume.mts"]) {
    const input = fixture(), command = `${node} --import tsx /foreign/${entry}`;
    assert.equal(providerHeadWriterCommand(command), true, entry);
    input.processes.push({ pid: 777, parentPid: 1, startedAt: childStarted, command });
    refuses(input, "PEER_SCOPE_UNKNOWN_WRITER");
  }
});

test("check-only inspectors and this guarded command remain excluded, without admitting their running peers", () => {
  const input = fixture(), own = `${node} --import tsx /fixture/scripts/local/provider-paused-head-resume.mts --run`;
  input.processes.push({ pid: input.ownPid, parentPid: 1, startedAt: childStarted, command: own });
  const inspection = `${node} --import tsx /foreign/scripts/local/run-provider-continuous-poller.mts --check-only`;
  assert.equal(providerHeadWriterCommand(inspection), false);
  input.processes.push({ pid: 777, parentPid: 1, startedAt: childStarted, command: inspection });
  assert.deepEqual(assertProviderHeadProcessScope(input), { acceptedPeerCount: 1, acceptedProcessCount: 2 });
  input.processes.at(-1).command = inspection.replace("--check-only", "--run");
  refuses(input, "PEER_SCOPE_UNKNOWN_WRITER");
  assert.equal(providerHeadWriterCommand("/usr/bin/python /fixture/provider-manual-import-local.ts"), false);
});

test("check-only text cannot hide worker entries that ignore that flag or an unrelated argument substring", () => {
  for (const entry of ["apps/worker/src/provider-manual-import-local.ts", "apps/worker/src/clutchpacks-manual-import-local.ts",
    "apps/worker/src/source-supervisor-local.ts", "apps/worker/src/index.ts", "apps/worker/src/main.mts",
    "scripts/local/start-provider-source-task010-supervisor.mts"]) {
    const input = fixture(), command = `${node} --import tsx /foreign/${entry} --check-only`;
    assert.equal(providerHeadWriterCommand(command), true, entry);
    input.processes.push({ pid: 777, parentPid: 1, startedAt: childStarted, command });
    refuses(input, "PEER_SCOPE_UNKNOWN_WRITER");
  }
  for (const suffix of ["--reason=contains--check-only", "--check-only-suffix", "prefix--check-only", "--file=/fixture/--check-only/proof.json"]) {
    assert.equal(providerHeadWriterCommand(`${node} --import tsx /foreign/scripts/local/run-provider-continuous-poller.mts --run ${suffix}`), true);
  }
  for (const argument of ["/ignored/run-provider-continuous-poller.mts", "/ignored/provider-failed-head-resume.mts", "--file=/ignored/provider-failed-head-resume.mts"]) {
    const input = fixture(), command = `${node} --import tsx /foreign/apps/worker/src/provider-manual-import-local.ts ${argument} --check-only`;
    assert.equal(providerHeadWriterCommand(command), true, "A safe CLI filename in ignored worker arguments is not the process entrypoint.");
    input.processes.push({ pid: 777, parentPid: 1, startedAt: childStarted, command });
    refuses(input, "PEER_SCOPE_UNKNOWN_WRITER");
  }
  assert.equal(providerHeadWriterCommand(`${node} --import tsx --require /ignored/provider-failed-head-resume.mts /foreign/apps/worker/src/provider-manual-import-local.ts --check-only`), true,
    "A control filename in a Node preload option cannot hide a worker entrypoint.");
});

test("system inventory parsing normalizes date whitespace and rejects incomplete, duplicate or oversized censuses", () => {
  const input = fixture(), text = input.processes.map(row => `${row.pid} ${row.parentPid} ${row.startedAt.replace("Aug 31", "Aug  31")} ${row.command}`).join("\n");
  assert.deepEqual(parseProviderHeadProcesses(`\n${text}\n`), input.processes);
  for (const value of ["", "unparsed process", `100 1 ${rootStarted}`, `${text}\n${text.split("\n")[0]}`,
    Array.from({ length: 10001 }, (_, index) => `${index + 1} 1 ${rootStarted} /usr/bin/true`).join("\n")]) {
    assert.throws(() => parseProviderHeadProcesses(value), error => error instanceof ProviderHeadPeerScopeError && error.code === "PEER_SCOPE_PROCESS_INVENTORY_INVALID");
  }
  input.processes.push(structuredClone(input.processes[0])); refuses(input, "PEER_SCOPE_PROCESS_INVENTORY_INVALID");
});

test("expired, future-issued and longer-than-two-minute scopes cannot admit otherwise valid peers", () => {
  for (const [issued, expiry] of [[-1000, 0], [1000, 60000], [0, 120001], [0, -1]]) {
    const input = fixture(); input.scope.issuedAt = new Date(now.getTime() + issued).toISOString();
    input.scope.notAfter = new Date(now.getTime() + expiry).toISOString(); refuses(input, "PEER_SCOPE_EXPIRED");
  }
  const invalid = fixture(); invalid.now = new Date(NaN); refuses(invalid, "PEER_SCOPE_EXPIRED");
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import path from "node:path";
import { tsImport } from "tsx/esm/api";

const plan = await tsImport("./dataforrest-catalog-bridge-plan.mts", import.meta.url);
const stateModule = await tsImport("./dataforrest-catalog-bridge-state.mts", import.meta.url);
const bootstrapModule = await tsImport("./dataforrest-catalog-bridge-bootstrap-macos.mts", import.meta.url);

const operationId = "51000000-0000-4000-8000-000000000001";
const operatorId = "51000000-0000-4000-8000-000000000002";

function fixture(providerKey = "collector_crypt") {
  const definition = plan.catalogBridgeProvider(providerKey);
  const staged = Buffer.from(`private exact ${providerKey} successor plist\n`);
  const residentCheckout = "/private/catalog-resident";
  const nodePath = "/private/node/bin/node";
  const logPath = `/private/logs/${providerKey}-successor.log`;
  const state = {
    operationId, providerKey, eventSuccessorConfigId: "51000000-0000-4000-8000-000000000003",
  };
  const policy = {
    pins: { residentCheckout, operatorId },
    successorLaunchAgent: {
      stagedPath: `/private/staged/${definition.launchdLabel}.plist`,
      installedPath: `/private/installed/${definition.launchdLabel}.plist`,
      fileSha256: createHash("sha256").update(staged).digest("hex"), nodePath, logPath,
      bootstrapPollMilliseconds: 50, bootstrapTimeoutMilliseconds: 1_000,
    },
  };
  const args = [nodePath, "--import", "tsx",
    path.join(residentCheckout, "scripts/local/run-provider-continuous-poller.mts"),
    "--run", "--launchd", "--bootstrap-backfill", "--await-initial-run",
    "--organization-id", definition.organizationId,
    "--provider-id", definition.providerId, "--provider-key", definition.providerKey,
    "--config-id", state.eventSuccessorConfigId, "--initial-run-id",
    stateModule.catalogBridgeResumeRunId(operationId, providerKey), "--operation-id", operationId,
    "--operator-id", operatorId];
  const plist = {
    Label: definition.launchdLabel, ProgramArguments: args, WorkingDirectory: residentCheckout,
    EnvironmentVariables: { NODE_ENV: "development",
      PATH: `${path.dirname(nodePath)}:/usr/bin:/bin:/usr/sbin:/sbin` },
    RunAtLoad: true, KeepAlive: { SuccessfulExit: false }, ThrottleInterval: 30,
    ExitTimeOut: 60, Umask: 63, StandardOutPath: logPath, StandardErrorPath: logPath,
  };
  const offline = { launchdLabel: definition.launchdLabel, launchdLoaded: false,
    processCount: 0, pids: [], processIdentitySha256: null,
    residencyPort: definition.residencyPort, residencyPortListening: false };
  const online = { ...offline, launchdLoaded: true, processCount: 1, pids: [81234],
    processIdentitySha256: "a".repeat(64), residencyPortListening: true };
  return { definition, staged, state, policy, plist, offline, online };
}

function harness(value, input = {}) {
  const calls = [];
  let installed = input.installed ?? null;
  const observations = [...(input.observations ?? [value.offline, value.online])];
  let clock = 0;
  const runner = { async run(executable, args) {
    calls.push(`${path.basename(executable)}:${args[0]}`);
    if (executable === "/usr/bin/plutil") {
      return { exitCode: input.plutilExitCode ?? 0,
        stdout: JSON.stringify(input.plist ?? value.plist), stderr: "" };
    }
    assert.equal(executable, "/bin/launchctl");
    assert.equal(calls.includes("observe:offline"), true,
      "launchctl bootstrap must follow an exact offline process proof");
    return { exitCode: input.bootstrapExitCode ?? 0, stdout: "", stderr: "" };
  } };
  const files = {
    async readPrivate(filePath) {
      calls.push(filePath === value.policy.successorLaunchAgent.stagedPath
        ? "read:staged" : "read:installed");
      if (filePath === value.policy.successorLaunchAgent.stagedPath) return value.staged;
      if (installed === null) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return installed;
    },
    async readIfPresent() { calls.push("read-if-present:installed"); return installed; },
    async installAtomic({ source }) { calls.push("install:atomic"); installed = Buffer.from(source); },
  };
  const observeProcess = async () => {
    const observation = observations.shift() ?? input.fallbackObservation ?? value.offline;
    calls.push(`observe:${observation.launchdLoaded ? "online" : "offline"}`);
    return observation;
  };
  const adapter = bootstrapModule.createCatalogBridgeMacosBootstrapAdapter({
    policy: value.policy, state: value.state, runner, files, observeProcess,
    platform: "darwin", uid: 501, now: () => clock,
    wait: async (milliseconds) => { calls.push("wait"); clock += milliseconds; },
  });
  return { adapter, calls, installed: () => installed };
}

test("successor launch-agent check proves exact private bytes and semantics without bootstrap", async () => {
  const value = fixture();
  const h = harness(value);
  await h.adapter.check();
  assert.deepEqual(h.calls, ["read:staged", "plutil:-convert"]);
});

test("bootstrap installs atomically only after proof and accepts one exact process and port", async () => {
  const value = fixture();
  const h = harness(value);
  const result = await h.adapter.bootstrap();
  assert.deepEqual(result, value.online);
  assert.deepEqual(h.calls, ["read:staged", "plutil:-convert", "observe:offline",
    "read-if-present:installed", "install:atomic", "read:installed", "launchctl:bootstrap",
    "observe:online"]);
  assert.equal(Buffer.compare(h.installed(), value.staged), 0);
});

test("bootstrap is idempotent only for an exact installed plist and exact online process", async () => {
  const value = fixture();
  const h = harness(value, { installed: value.staged, observations: [value.online] });
  assert.deepEqual(await h.adapter.bootstrap(), value.online);
  assert.equal(h.calls.includes("launchctl:bootstrap"), false);
  const changed = harness(value, { installed: Buffer.from("changed"), observations: [value.online] });
  await assert.rejects(changed.adapter.bootstrap(),
    { code: "CATALOG_BRIDGE_BOOTSTRAP_RUNNING_PLIST_CHANGED" });
  assert.equal(changed.calls.includes("launchctl:bootstrap"), false);

  const wrongPort = harness(value, { installed: value.staged,
    observations: [{ ...value.online, residencyPort: 56_432 }] });
  await assert.rejects(wrongPort.adapter.bootstrap(),
    { code: "CATALOG_BRIDGE_BOOTSTRAP_PROCESS_NOT_OFFLINE" });
  assert.equal(wrongPort.calls.includes("launchctl:bootstrap"), false);
});

test("plist drift, bootstrap refusal and startup timeout never report a successor", async () => {
  const value = fixture();
  const invalid = harness(value, { plist: { ...value.plist, Label: "wrong" } });
  await assert.rejects(invalid.adapter.bootstrap(), { code: "CATALOG_BRIDGE_BOOTSTRAP_PLIST_INVALID" });
  assert.equal(invalid.calls.includes("launchctl:bootstrap"), false);

  const refused = harness(value, { bootstrapExitCode: 1, observations: [value.offline] });
  await assert.rejects(refused.adapter.bootstrap(), { code: "CATALOG_BRIDGE_BOOTSTRAP_REFUSED" });

  const timeout = harness(value, { observations: [value.offline], fallbackObservation: value.offline });
  await assert.rejects(timeout.adapter.bootstrap(), { code: "CATALOG_BRIDGE_BOOTSTRAP_TIMEOUT" });
  assert.equal(timeout.calls.includes("observe:online"), false);
});

test("catalog successor ports preserve the three provider assignments and exclude Clutch", () => {
  const ports = Object.fromEntries(plan.catalogBridgeProviderDefinitions.map((entry) =>
    [entry.providerKey, entry.residencyPort]));
  assert.deepEqual(ports, { collector_crypt: 56_434, courtyard: 56_433, phygitals: 56_435 });
  assert.equal(Object.values(ports).includes(56_432), false);
});

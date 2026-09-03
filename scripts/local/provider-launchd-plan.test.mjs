import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import { pins } from "./provider-resident-test-fixture.mjs";
const { createProviderLaunchdPlan } = await tsImport("./provider-launchd-plan.mts", import.meta.url);
const { parseContinuousArguments, runContinuousCli, runContinuousPoller } = await tsImport("./run-provider-continuous-poller.mts", import.meta.url);
const input = { pins, checkoutRoot: "/synthetic/reviewed & coherent tree", nodeExecutable: "/synthetic/node/bin/node",
  logPath: "/synthetic/private/provider.log", bootstrapBackfill: true, platform: "darwin" };
test("launchd plan preserves exact pins, checkout and selective crash restart without secrets", () => {
  const plan = createProviderLaunchdPlan(input);
  assert.equal(plan.label, "com.packscout.provider-import.clutchpacks");
  assert.equal(plan.workingDirectory, input.checkoutRoot);
  assert.equal(plan.restartPolicy, "unexpected_exit_only");
  assert.deepEqual(parseContinuousArguments(plan.arguments.slice(4)), { mode: "--run", pins, bootstrapBackfill: true,
    awaitInitialRun: false, launchd: true, cadence: { kind: "central" } });
  assert.match(plan.plist, /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/);
  assert.match(plan.plist, /reviewed &amp; coherent tree/);
  assert.equal(/DATABASE_URL|CREDENTIAL|TOKEN|PASSWORD|SECRET/u.test(plan.plist), false);
  const headOnly = createProviderLaunchdPlan({ ...input, bootstrapBackfill: false });
  assert.equal(parseContinuousArguments(headOnly.arguments.slice(4)).bootstrapBackfill, false);
  const awaited = createProviderLaunchdPlan({ ...input, awaitInitialRun: true });
  assert.deepEqual(parseContinuousArguments(awaited.arguments.slice(4)), { mode: "--run", pins, bootstrapBackfill: true,
    awaitInitialRun: true, launchd: true, cadence: { kind: "central" } });
});
test("explicit minute cadence survives launchd planning with unchanged source and checkpoint pins", () => {
  const cadence = { kind: "operator_interval", intervalSeconds: 60 };
  const plan = createProviderLaunchdPlan({ ...input, bootstrapBackfill: false, cadence });
  const parsed = parseContinuousArguments(plan.arguments.slice(4));
  assert.deepEqual(parsed.cadence, cadence);
  assert.deepEqual(parsed.pins, pins);
  assert.equal(parsed.bootstrapBackfill, false);
  assert.deepEqual(plan.cadence, cadence);
  assert.match(plan.plist, /<string>--poll-interval-seconds<\/string><string>60<\/string>/);
  const check = plan.arguments.slice(4).filter(value => value !== "--launchd").map(value => value === "--run" ? "--check-only" : value);
  assert.deepEqual(parseContinuousArguments(check).cadence, cadence);
});
test("cadence CLI rejects missing, repeated, malformed and out-of-range intervals", () => {
  const args = createProviderLaunchdPlan(input).arguments.slice(4);
  for (const value of ["", "0", "59", "86401", "1.5", "NaN", "Infinity", "060", "-60", "9007199254740993"]) {
    assert.throws(() => parseContinuousArguments([...args, "--poll-interval-seconds", value]));
  }
  assert.throws(() => parseContinuousArguments([...args, "--poll-interval-seconds"]));
  assert.throws(() => parseContinuousArguments([...args, "--poll-interval-seconds", "60", "--poll-interval-seconds", "120"]));
  for (const intervalSeconds of [0, 59, 86401, NaN]) {
    assert.throws(() => createProviderLaunchdPlan({ ...input, cadence: { kind: "operator_interval", intervalSeconds } }));
  }
});
test("bootstrap refuses custom policy before environment reads or source work", async () => {
  const cadence = { kind: "operator_interval", intervalSeconds: 60 };
  assert.throws(() => createProviderLaunchdPlan({ ...input, cadence }), /CONTINUOUS_BOOTSTRAP_POLICY_UNSUPPORTED/);
  const argv = createProviderLaunchdPlan(input).arguments.slice(4);
  assert.throws(() => parseContinuousArguments([...argv, "--poll-interval-seconds", "60"]), /CONTINUOUS_BOOTSTRAP_POLICY_UNSUPPORTED/);
  const args = parseContinuousArguments(argv);
  await assert.rejects(runContinuousPoller(args, new AbortController().signal, { postHead: {
    policyFingerprint: "a".repeat(64), timeoutMilliseconds: 1000, run: async () => assert.fail("callback must not run"),
  } }), /CONTINUOUS_BOOTSTRAP_POLICY_UNSUPPORTED/);
  await assert.rejects(runContinuousPoller({ ...args, cadence }, new AbortController().signal), /CONTINUOUS_BOOTSTRAP_POLICY_UNSUPPORTED/);
});
test("launchd rejects invalid host/path/pins and CLI rejects duplicated or invalid activation flags", () => {
  for (const changed of [{ platform: "linux" }, { checkoutRoot: "relative" }, { nodeExecutable: "node" },
    { logPath: "/private/log\nextra" }, { pins: { ...pins, providerKey: "unknown" } },
    { bootstrapBackfill: false, awaitInitialRun: true }]) {
    assert.throws(() => createProviderLaunchdPlan({ ...input, ...changed }));
  }
  const args = createProviderLaunchdPlan(input).arguments.slice(4);
  assert.throws(() => parseContinuousArguments([...args, "--bootstrap-backfill"]));
  assert.throws(() => parseContinuousArguments([...args, "--launchd"]));
  assert.throws(() => parseContinuousArguments(args.map(value => value === "--run" ? "--check-only" : value)));
});
test("known startup failures produce sanitized successful launchd stop, default CLI still fails", () => {
  const args = createProviderLaunchdPlan(input).arguments.slice(4);
  const script = new URL("./run-provider-continuous-poller.mts", import.meta.url);
  for (const launchd of [true, false]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", script.pathname,
      ...args.filter(value => launchd || value !== "--launchd")], {
      env: { PATH: process.env.PATH, NODE_ENV: "production" }, encoding: "utf8", timeout: 15000 });
    assert.equal(result.error, undefined); assert.equal(result.status, launchd ? 0 : 1);
    assert.deepEqual(JSON.parse(result.stderr), { outcome: "blocked", code: "BACKFILL_LOCAL_SINGLE_PROVIDER_REQUIRED" });
  }
});
test("unknown startup throw and controlled signal exit cleanly without exposing unsafe detail", async () => {
  const args = createProviderLaunchdPlan(input).arguments.slice(4); const errors = [];
  const output = { result: () => assert.fail(), error: value => errors.push(value) };
  const code = await runContinuousCli(args, new AbortController().signal, output,
    async () => { throw new Error("private database connection password"); });
  assert.equal(code, 0);
  assert.deepEqual(errors, [{ outcome: "blocked", code: "CONTINUOUS_OPERATION_FAILED" }]);
  const stop = new AbortController(); stop.abort();
  assert.equal(await runContinuousCli(args.filter(value => value !== "--launchd"), stop.signal, output,
    async () => { throw new Error("interrupted"); }), 0);
});

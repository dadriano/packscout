import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import { pins } from "./provider-resident-test-fixture.mjs";
const { createProviderLaunchdPlan } = await tsImport("./provider-launchd-plan.mts", import.meta.url);
const { parseContinuousArguments, runContinuousCli } = await tsImport("./run-provider-continuous-poller.mts", import.meta.url);
const input = { pins, checkoutRoot: "/synthetic/reviewed & coherent tree", nodeExecutable: "/synthetic/node/bin/node",
  logPath: "/synthetic/private/provider.log", bootstrapBackfill: true, platform: "darwin" };
test("launchd plan preserves exact pins, checkout and selective crash restart without secrets", () => {
  const plan = createProviderLaunchdPlan(input);
  assert.equal(plan.label, "com.packscout.provider-import.clutchpacks");
  assert.equal(plan.workingDirectory, input.checkoutRoot);
  assert.equal(plan.restartPolicy, "unexpected_exit_only");
  assert.deepEqual(parseContinuousArguments(plan.arguments.slice(4)), { mode: "--run", pins, bootstrapBackfill: true, launchd: true });
  assert.match(plan.plist, /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/);
  assert.match(plan.plist, /reviewed &amp; coherent tree/);
  assert.equal(/DATABASE_URL|CREDENTIAL|TOKEN|PASSWORD|SECRET/u.test(plan.plist), false);
  const headOnly = createProviderLaunchdPlan({ ...input, bootstrapBackfill: false });
  assert.equal(parseContinuousArguments(headOnly.arguments.slice(4)).bootstrapBackfill, false);
});
test("launchd rejects invalid host/path/pins and CLI rejects duplicated or invalid activation flags", () => {
  for (const changed of [{ platform: "linux" }, { checkoutRoot: "relative" }, { nodeExecutable: "node" },
    { logPath: "/private/log\nextra" }, { pins: { ...pins, providerKey: "unknown" } }]) {
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

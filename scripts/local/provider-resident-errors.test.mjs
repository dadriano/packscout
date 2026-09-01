import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import { pins } from "./provider-resident-test-fixture.mjs";
const { residentFailureCode, withResidentStartup } = await tsImport("./provider-resident-errors.mts", import.meta.url);
const { createProviderLaunchdPlan } = await tsImport("./provider-launchd-plan.mts", import.meta.url);
const { runContinuousCli } = await tsImport("./run-provider-continuous-poller.mts", import.meta.url);
test("resident error sanitization never evaluates getters or throwing/revoked proxies", () => {
  let getters = 0;
  const withGetter = Object.defineProperty(new Error("secret"), "code", { get() { getters++; throw new Error("secret getter"); } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const hostile = new Proxy({}, { getPrototypeOf() { throw new Error("secret prototype"); }, getOwnPropertyDescriptor() { throw new Error("secret descriptor"); } });
  for (const value of [withGetter, revoked.proxy, hostile, Object.create({ code: "CONTINUOUS_FORGED" }), null, "secret"]) {
    assert.equal(residentFailureCode(value), "CONTINUOUS_OPERATION_FAILED");
  }
  assert.equal(getters, 0);
  assert.equal(residentFailureCode({ code: "BACKFILL_PERMANENT_FAILURE" }), "BACKFILL_PERMANENT_FAILURE");
});
test("only positively known startup connection errors get launchd retry status", async () => {
  const args = createProviderLaunchdPlan({ pins, checkoutRoot: "/synthetic/reviewed", nodeExecutable: "/synthetic/node",
    logPath: "/synthetic/private/log", bootstrapBackfill: true, platform: "darwin" }).arguments.slice(4);
  for (const code of ["P1001", "P1002", "P1017", "P2024", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"]) {
    const events = [];
    const status = await runContinuousCli(args, new AbortController().signal,
      { result: () => assert.fail(), error: event => events.push(event) },
      () => withResidentStartup(async () => { throw Object.assign(new Error("secret connection string"), { code }); }));
    assert.equal(status, 75); assert.deepEqual(events, [{ outcome: "startup_unavailable", code: "CONTINUOUS_STARTUP_UNAVAILABLE" }]);
  }
  await assert.rejects(withResidentStartup(async () => { throw { errorCode: "P1001" }; }), /CONTINUOUS_STARTUP_UNAVAILABLE/);
  for (const code of ["P1000", "P1010", "P2028", "CONTINUOUS_PROVIDER_UNAVAILABLE", "UNKNOWN"]) {
    assert.equal(await runContinuousCli(args, new AbortController().signal, { result: () => assert.fail(), error() {} },
      () => withResidentStartup(async () => { throw { code }; })), 0);
  }
  // A similarly coded failure outside the startup boundary gains no retry capability.
  assert.equal(await runContinuousCli(args, new AbortController().signal, { result: () => assert.fail(), error() {} },
    async () => { throw { code: "ECONNRESET" }; }), 0);
});

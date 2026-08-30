import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const { parseCourtyardHandoffArguments, courtyardGatewayBounds, courtyardResumeReviewAvailable } =
  await tsImport("./handoff-courtyard-native-profile.mts", import.meta.url);
const diagnostics = await tsImport("./handoff-courtyard-native-profile.mts", import.meta.url);
const { BoundedProviderDatabaseGateway, ProviderDatabaseDestinationPolicy } = await tsImport("@packscout/database", import.meta.url);
const { readCollectorCryptDataforrestActivationEnvironment: readEnvironment } = await import("./activate-collector-crypt-dataforrest-source-plan.mjs");
const operationId = "1dd59a1b-79c2-4b18-a881-edafe7b897dd";
test("Courtyard CLI admits only explicit operation/review phases, never provider/token/PID overrides", () => {
  const args = ["--check-only", "--operation-id", operationId];
  assert.equal(parseCourtyardHandoffArguments(args).operationId, operationId);
  for (const mode of ["--pause", "--prepare", "--resume"]) {
    assert.throws(() => parseCourtyardHandoffArguments([mode, ...args.slice(1)]));
    assert.equal(parseCourtyardHandoffArguments([mode, ...args.slice(1), "--review-digest", "a".repeat(64)]).mode, mode);
  }
  for (const extra of [["--provider", "collector_crypt"], ["--token", "private-token"], ["--old-worker-pid", "1234"],
    ["--operation-id", operationId], ["--review-digest", "not-hash"]]) {
    assert.throws(() => parseCourtyardHandoffArguments([...args, ...extra]), (error) => !error.message.includes("private-token"));
  }
  assert.throws(() => parseCourtyardHandoffArguments(["--check-only", "--operation-id", "invalid"]));
});
test("Courtyard interrupted acquire/local commit/central activation require own-lease cleanup before resume review", () => {
  const owner = `local:courtyard:handoff:${operationId}`;
  for (const active of [false, true]) assert.equal(courtyardResumeReviewAvailable(active, owner, owner), false);
  assert.equal(courtyardResumeReviewAvailable(true, null, owner), true);
  assert.equal(courtyardResumeReviewAvailable(false, null, owner), false);
  // Classifier only selects a phase. The plan's exact SQL-time lease guard separately rejects live/foreign leases.
});
test("Courtyard bounded gateway is constructible and local-only bootstrap rejects alternate routes/bearers", async () => {
  const gateway = new BoundedProviderDatabaseGateway({ central: { client: {} }, credentialResolver: {},
    destinationPolicy: new ProviderDatabaseDestinationPolicy({ allowedHosts: ["127.0.0.1"], allowedPorts: [55433], allowedSslModes: ["disable"] }),
    ...courtyardGatewayBounds });
  assert.equal(courtyardGatewayBounds.operationTimeoutMs, 60000); await gateway.close();
  const fileEnvironment = { PACKSCOUT_CENTRAL_DATABASE_URL: "postgresql://packscout_control_app:fixture-password@127.0.0.1:55431/packscout",
    PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64: Buffer.alloc(32, 7).toString("base64") };
  assert.equal(readEnvironment({ processEnvironment: { NODE_ENV: "development" }, fileEnvironment }).credentialKey.byteLength, 32);
  for (const change of [{ PACKSCOUT_CENTRAL_DATABASE_URL: "postgresql://app:fixture-password@remote.test/packscout" },
    { PACKSCOUT_CENTRAL_DATABASE_URL: "postgresql://packscout_control_app:fixture-password@127.0.0.1:55434/packscout" },
    { PACKSCOUT_DATA_API_TOKEN: "private-token" }]) {
    assert.throws(() => readEnvironment({ processEnvironment: { NODE_ENV: "development" }, fileEnvironment: { ...fileEnvironment, ...change } }),
      (error) => !error.message.includes("private-token") && !error.message.includes("fixture-password"));
  }
  assert.throws(() => readEnvironment({ processEnvironment: { NODE_ENV: "production" }, fileEnvironment }));
});

test("Courtyard gateway preserves only closed domain codes and redacts arbitrary errors, messages and causes", async () => {
  const { captureCourtyardHandoffResult, courtyardHandoffFailureCode, CourtyardHandoffError } = diagnostics;
  const gateway = async (action) => { try { return { state: "reachable", value: await action() }; } catch { return { state: "unreachable" }; } };
  const secret = "private-token-body-cursor";
  const error = new CourtyardHandoffError("COURTYARD_CANARY_ADMISSION_FAILED"); error.message = secret; error.cause = new Error(secret);
  const result = await gateway(() => captureCourtyardHandoffResult(async () => { throw error; }));
  assert.deepEqual(result, { state: "reachable", value: { ok: false, code: "COURTYARD_CANARY_ADMISSION_FAILED" } });
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(await captureCourtyardHandoffResult(async () => ({ phase: "prepared_paused" })), { ok: true, value: { phase: "prepared_paused" } });
  for (const untrusted of [new Error(secret), { code: "COURTYARD_CANARY_ADMISSION_FAILED", message: secret },
    new CourtyardHandoffError(`COURTYARD_${secret}`), new CourtyardHandoffError("COURTYARD_UNREVIEWED_NEW_CODE")]) {
    assert.equal(courtyardHandoffFailureCode(untrusted), undefined);
    assert.deepEqual(await gateway(() => captureCourtyardHandoffResult(async () => { throw untrusted; })), { state: "unreachable" });
  }
});

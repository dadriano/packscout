import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const { parseCollectorHandoffArguments, collectorHandoffGatewayBounds, collectorResumeReviewAvailable } =
  await tsImport("./handoff-collector-crypt-page-profile.mts", import.meta.url);
const diagnostics = await tsImport("./handoff-collector-crypt-page-profile.mts", import.meta.url);
const { BoundedProviderDatabaseGateway, ProviderDatabaseDestinationPolicy } = await tsImport("@packscout/database", import.meta.url);
const { readCollectorCryptDataforrestActivationEnvironment } = await import("./activate-collector-crypt-dataforrest-source-plan.mjs");
const args = ["--check-only", "--operation-id", "721049d1-eb7c-4f5d-b7e5-bf12eaa76189",
  "--old-worker-pid", "12345", "--expected-worker-owner", "local:collector:original"];

test("Collector handoff requires explicit reviewed mutations and rejects unknown/secret arguments", () => {
  assert.equal(parseCollectorHandoffArguments(args).mode, "--check-only");
  assert.throws(() => parseCollectorHandoffArguments(["--prepare", ...args.slice(1)]), /HANDOFF_REVIEW_REQUIRED/u);
  assert.equal(parseCollectorHandoffArguments(["--prepare", ...args.slice(1), "--review-digest", "a".repeat(64)]).mode, "--prepare");
  for (const bad of [[], [...args, "--provider", "phygitals"], [...args, "--token", "secret-do-not-print"],
    [...args, "--operation-id", args[2]], ["--run", ...args.slice(1)], [...args, "--review-digest", "not-a-hash"]]) {
    assert.throws(() => parseCollectorHandoffArguments(bad), (error) => !error.message.includes("secret-do-not-print"));
  }
});

test("Collector terminal-timeout entry uses explicit operation authority without unchecked PID arguments", () => {
  const terminal = ["--check-only", "--entry", "terminal-timeout", "--operation-id", args[2]];
  assert.equal(parseCollectorHandoffArguments(terminal).entry, "terminal-timeout");
  assert.throws(() => parseCollectorHandoffArguments([...terminal, "--old-worker-pid", "12345"]));
  assert.throws(() => parseCollectorHandoffArguments([...terminal, "--expected-worker-owner", "unverified"]));
  assert.throws(() => parseCollectorHandoffArguments(["--check-only", "--entry", "any-failure", "--operation-id", args[2]]));
});

test("Collector gateway has supported bounded options and only the exact local provider destination", async () => {
  const gateway = new BoundedProviderDatabaseGateway({ central: { client: {} }, credentialResolver: {},
    destinationPolicy: new ProviderDatabaseDestinationPolicy({ allowedHosts: ["127.0.0.1"], allowedPorts: [55434], allowedSslModes: ["disable"] }),
    ...collectorHandoffGatewayBounds });
  assert.equal(collectorHandoffGatewayBounds.operationTimeoutMs, 60000);
  await gateway.close();
});

test("Collector crashed prepare exposes cleanup review after acquire, local commit and central activation", () => {
  const operationOwner = "local:collector:handoff:fixture";
  for (const active of [false, true]) {
    assert.equal(collectorResumeReviewAvailable({ active, staged: true, leaseOwner: operationOwner, operationOwner }), false);
  }
  assert.equal(collectorResumeReviewAvailable({ active: true, staged: true, leaseOwner: null, operationOwner }), true);
  assert.equal(collectorResumeReviewAvailable({ active: false, staged: true, leaseOwner: null, operationOwner }), false);
});

test("Collector inherited local-only bootstrap rejects nonlocal DSNs and any process/file bearer", () => {
  const fileEnvironment = { PACKSCOUT_CENTRAL_DATABASE_URL: "postgresql://packscout_control_app:protected@127.0.0.1:55431/packscout",
    PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64: Buffer.alloc(32, 1).toString("base64") };
  assert.equal(readCollectorCryptDataforrestActivationEnvironment({ processEnvironment: { NODE_ENV: "development" },
    fileEnvironment }).credentialKey.byteLength, 32);
  for (const change of [{ PACKSCOUT_CENTRAL_DATABASE_URL: "postgresql://app:protected@example.org/packscout" },
    { PACKSCOUT_DATA_API_TOKEN: "secret-do-not-print" }]) {
    assert.throws(() => readCollectorCryptDataforrestActivationEnvironment({ processEnvironment: { NODE_ENV: "development" },
      fileEnvironment: { ...fileEnvironment, ...change } }), (error) => !error.message.includes("secret-do-not-print") && !error.message.includes("protected"));
  }
  assert.throws(() => readCollectorCryptDataforrestActivationEnvironment({ processEnvironment: { NODE_ENV: "production" }, fileEnvironment }));
  assert.throws(() => readCollectorCryptDataforrestActivationEnvironment({ processEnvironment: {
    NODE_ENV: "development", PACKSCOUT_DATA_API_TOKEN: "secret-do-not-print" }, fileEnvironment }),
  (error) => !error.message.includes("secret-do-not-print"));
});

test("Collector gateway callback preserves only allowlisted domain refusal codes, not errors or protected data", async () => {
  const { captureCollectorHandoffResult, collectorHandoffFailureCode, CollectorCheckpointHandoffError } = diagnostics;
  const gateway = async (operation) => {
    try { return { state: "reachable", value: await operation() }; }
    catch { return { state: "unreachable" }; }
  };
  const protectedValue = "private-token-body-cursor";
  const refusal = new CollectorCheckpointHandoffError("HANDOFF_CANARY_PAGE_INVALID");
  refusal.message = protectedValue; refusal.cause = new Error(protectedValue);
  const preserved = await gateway(() => captureCollectorHandoffResult(async () => { throw refusal; }));
  assert.deepEqual(preserved, { state: "reachable", value: { ok: false, code: "HANDOFF_CANARY_PAGE_INVALID" } });
  assert.equal(JSON.stringify(preserved).includes(protectedValue), false);
  assert.deepEqual(await captureCollectorHandoffResult(async () => ({ phase: "prepared_paused" })),
    { ok: true, value: { phase: "prepared_paused" } });
  for (const error of [new Error(protectedValue), { code: "HANDOFF_CANARY_PAGE_INVALID", message: protectedValue },
    new CollectorCheckpointHandoffError(`HANDOFF_${protectedValue}`), new CollectorCheckpointHandoffError("HANDOFF_UNREVIEWED_NEW_CODE")]) {
    assert.equal(collectorHandoffFailureCode(error), undefined);
    assert.deepEqual(await gateway(() => captureCollectorHandoffResult(async () => { throw error; })), { state: "unreachable" });
  }
});

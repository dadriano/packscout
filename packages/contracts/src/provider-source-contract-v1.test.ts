import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalKindByLaunchScope,
  launchRecordIdScopeDeclarations,
  normalizedContinuationSchema,
  OPAQUE_CURSOR_VALUE_INVALID_TEXT_ERROR,
  OPAQUE_CURSOR_VALUE_MAXIMUM_UTF8_BYTES,
  opaqueCursorEnvelopeSchema,
  opaqueCursorValueSchema,
  providerSourceControlPlaneRetry,
  providerSourceDiagnosticCursorFingerprintSchema,
  providerSourceDiagnosticCommandCorrelationKeySchema,
  providerSourceDiagnosticCorrelationKinds,
  providerSourceDiagnosticEventKindByCorrelationKind,
  providerSourceDiagnosticSeverities,
  providerSourceLaunchBounds,
  providerSourceRetention,
  providerSourceSingletonTiming,
  sourceLifecycleStates,
  sourceAdapterFailureSchema,
  sourceAdapterSafeDiagnosticSchema,
  sourceAdapterManifestV1Schema,
  validateSourceIntervalSeconds,
} from "./provider-source-contract-v1.ts";
import {
  dataforrestEventsV1SourceAdapterManifest,
} from "./dataforrest-events-v1.ts";

test("launch source constants retain the evidence-backed operating envelope", () => {
  assert.deepEqual(providerSourceLaunchBounds, {
    pageTargetRecords: 250,
    maximumResponseBytes: 8_388_608,
    requestTimeoutMilliseconds: 10_000,
    stableProfileRequestCap: 2,
    genericExecutionSlots: 4,
    sourceIntervalSeconds: { minimum: 60, default: 60, maximum: 86_400 },
    freshnessGraceSeconds: 900,
  });
  assert.deepEqual(providerSourceRetention, {
    protectedRawPageDays: 7,
    protectedQuarantineDays: 30,
    sanitizedDiagnosticDays: 30,
    terminalRequestAttemptDays: 30,
  });
  assert.deepEqual(providerSourceSingletonTiming, {
    leaseSeconds: 60,
    maximumRenewalIntervalSeconds: 5,
    takeoverGraceSeconds: 15,
  });
  assert.deepEqual(providerSourceControlPlaneRetry, {
    maximumAttempts: 3,
    backoffMilliseconds: [0, 100, 400],
    transactionTimeoutMilliseconds: 750,
    wallClockLimitMilliseconds: 3_000,
  });
  assert.deepEqual(sourceLifecycleStates, [
    "draft",
    "paused",
    "active",
    "disabled",
    "replaced",
  ]);
});

test("continuation is a strict discriminated union with bounded integer delay", () => {
  assert.deepEqual(normalizedContinuationSchema.parse({ kind: "continue" }), {
    kind: "continue",
  });
  assert.deepEqual(
    normalizedContinuationSchema.parse({
      kind: "poll_after",
      minimumDelaySeconds: 86_400,
    }),
    { kind: "poll_after", minimumDelaySeconds: 86_400 },
  );
  for (const invalid of [
    { kind: "continue", minimumDelaySeconds: 0 },
    { kind: "poll_after" },
    { kind: "poll_after", minimumDelaySeconds: -1 },
    { kind: "poll_after", minimumDelaySeconds: 1.5 },
    { kind: "poll_after", minimumDelaySeconds: 86_401 },
  ]) {
    assert.equal(normalizedContinuationSchema.safeParse(invalid).success, false);
  }
});

test("opaque cursors share one exact 16 KiB UTF-8 byte bound", () => {
  assert.equal(OPAQUE_CURSOR_VALUE_MAXIMUM_UTF8_BYTES, 16_384);
  const exactAscii = "a".repeat(16_384);
  const exactMultibyte = "é".repeat(8_192);
  const oversizedMultibyte = `${exactMultibyte}a`;
  const exactAstral = "🙂".repeat(4_096);
  assert.equal(opaqueCursorValueSchema.safeParse(exactAscii).success, true);
  assert.equal(
    opaqueCursorValueSchema.safeParse(exactMultibyte).success,
    true,
  );
  assert.equal(opaqueCursorValueSchema.safeParse(exactAstral).success, true);
  assert.equal(
    opaqueCursorValueSchema.safeParse(`${exactAstral}a`).success,
    false,
  );
  assert.equal(
    opaqueCursorValueSchema.safeParse(oversizedMultibyte).success,
    false,
  );
  assert.equal(opaqueCursorEnvelopeSchema.safeParse({
    sourceInstanceId: "source-1",
    sourceRevisionId: "source-revision-1",
    sourceTypeKey: "fixture-source-v1",
    adapterVersion: "fixture-adapter-v1",
    cursorCodecKey: "fixture-cursor-v1",
    cursorGeneration: 1,
    value: oversizedMultibyte,
  }).success, false);
});

test("opaque cursors reject text that cannot round-trip losslessly through PostgreSQL UTF-8", () => {
  for (const invalid of [
    "cursor\u0000value",
    "cursor-\ud800-value",
    "cursor-\udfff-value",
  ]) {
    const parsed = opaqueCursorValueSchema.safeParse(invalid);
    assert.equal(parsed.success, false);
    if (!parsed.success) {
      assert.equal(
        parsed.error.issues.some(
          ({ message }) =>
            message === OPAQUE_CURSOR_VALUE_INVALID_TEXT_ERROR,
        ),
        true,
      );
    }
  }

  for (const valid of ["cursor-🙂-value", "\ufeffcursor-value"]) {
    assert.equal(opaqueCursorValueSchema.safeParse(valid).success, true);
  }
});

test("adapter failure codes cannot cross their durable disposition boundary", () => {
  for (const valid of [
    { disposition: "cancelled", code: "lost_ownership" },
    { disposition: "retryable", code: "request_timeout", safeStatus: 408 },
    {
      disposition: "retryable",
      code: "rate_limited",
      retryAfterSeconds: 60,
      safeStatus: 429,
    },
    {
      disposition: "source_action_required",
      code: "invalid_cursor",
      safeStatus: 422,
    },
    {
      disposition: "connection_action_required",
      code: "authentication_failed",
      safeStatus: 401,
    },
  ]) {
    assert.equal(sourceAdapterFailureSchema.safeParse(valid).success, true);
  }
  for (const invalid of [
    { disposition: "connection_action_required", code: "invalid_response" },
    { disposition: "source_action_required", code: "tls_failed" },
    { disposition: "retryable", code: "authentication_failed" },
    { disposition: "cancelled", code: "server_failure" },
    {
      disposition: "retryable",
      code: "request_timeout",
      retryAfterSeconds: 1,
    },
    {
      disposition: "cancelled",
      code: "cancelled",
      safeStatus: 499,
    },
    {
      disposition: "source_action_required",
      code: "invalid_response",
      safeStatus: 200,
    },
  ]) {
    assert.equal(sourceAdapterFailureSchema.safeParse(invalid).success, false);
  }
});

test("source interval accepts only the shared 60 second through one day range", () => {
  assert.equal(validateSourceIntervalSeconds(60), 60);
  assert.equal(validateSourceIntervalSeconds(86_400), 86_400);
  for (const invalid of [59, 86_401, 60.5, "60"]) {
    assert.throws(() => validateSourceIntervalSeconds(invalid));
  }
});

test("diagnostic vocabulary and safe references stay contract-owned", () => {
  assert.deepEqual(providerSourceDiagnosticSeverities, [
    "info",
    "warning",
    "critical",
  ]);
  assert.deepEqual(providerSourceDiagnosticCorrelationKinds, [
    "lifecycle",
    "connection_test",
    "source_test",
    "run",
    "page",
    "connection_episode",
  ]);
  assert.deepEqual(providerSourceDiagnosticEventKindByCorrelationKind, {
    lifecycle: "source_lifecycle",
    connection_test: "connection_test",
    source_test: "source_test",
    run: "source_run",
    page: "source_page",
    connection_episode: "connection_episode",
  });
  assert.equal(sourceAdapterSafeDiagnosticSchema.safeParse({
    severity: "critical",
    phase: "request",
    code: "connection_blocked",
  }).success, true);
  assert.equal(sourceAdapterSafeDiagnosticSchema.safeParse({
    severity: "error",
    phase: "request",
    code: "connection_blocked",
  }).success, false);

  assert.equal(
    providerSourceDiagnosticCursorFingerprintSchema.parse("a".repeat(64)),
    "a".repeat(64),
  );
  for (const unsafeFingerprint of [
    "a".repeat(63),
    "A".repeat(64),
    "cursor:reusable-provider-value",
  ]) {
    assert.equal(
      providerSourceDiagnosticCursorFingerprintSchema.safeParse(
        unsafeFingerprint,
      ).success,
      false,
    );
  }

  assert.equal(
    providerSourceDiagnosticCommandCorrelationKeySchema.parse(
      "command:01j5yr0m2v8q7y3k9h6w4n1c0b",
    ),
    "command:01j5yr0m2v8q7y3k9h6w4n1c0b",
  );
  for (const unsafeCommandKey of [
    "Bearer reusable-secret",
    "UPPERCASE-COMMAND",
    `command:${"a".repeat(121)}`,
  ]) {
    assert.equal(
      providerSourceDiagnosticCommandCorrelationKeySchema.safeParse(
        unsafeCommandKey,
      ).success,
      false,
    );
  }
});

test("launch record scopes map injectively to canonical identity domains", () => {
  assert.equal(launchRecordIdScopeDeclarations.length, 4);
  const canonicalKinds = Object.values(canonicalKindByLaunchScope);
  assert.equal(new Set(canonicalKinds).size, canonicalKinds.length);
  assert.deepEqual(canonicalKindByLaunchScope, {
    "catalog-pack-v1": "pack",
    "catalog-card-v1": "catalog_asset",
    "pull-v1": "pull",
    "trade-v1": "market_event",
  });
});

test("record scopes cannot relabel their frozen source kind", () => {
  const manifest = structuredClone(dataforrestEventsV1SourceAdapterManifest);
  manifest.supportedProviders[0]!.recordIdScopes[2]!.sourceKind = "trade";
  assert.equal(sourceAdapterManifestV1Schema.safeParse(manifest).success, false);
});

test("the adapter manifest is credential-free, strict, and uses the launch bound", () => {
  const parsedV1 = sourceAdapterManifestV1Schema.parse(
    dataforrestEventsV1SourceAdapterManifest,
  );
  assert.equal(parsedV1.sourceTypeKey, "dataforrest-events-v1");
  assert.deepEqual(parsedV1.requestBounds, {
    pageLimit: 250,
    maximumResponseBytes: 8_388_608,
    timeoutMilliseconds: 10_000,
  });
  assert.equal(parsedV1.maximumConnectionRequestCap, 2);
  assert.deepEqual(
    parsedV1.supportedProviders.map(({ provider }) => provider),
    ["courtyard", "collector_crypt", "phygitals", "clutchpacks"],
  );
  assert.equal(JSON.stringify(parsedV1).match(
    /credential|authorization|token/iu,
  ), null);
  assert.equal(
    sourceAdapterManifestV1Schema.safeParse({ ...parsedV1, token: "forbidden" }).success,
    false,
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
  PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY,
  PACKSCOUT_BUYBACK_EV_SCHEMA_VERSION,
  type PackScoutBuybackEvInputV1,
} from "@packscout/contracts";
import { calculatePackScoutBuybackAdjustedEvV1 } from "./buyback-adjusted-ev-calculator.ts";
import {
  BUYBACK_EV_TEST_CALCULATED_AT,
  BUYBACK_EV_TEST_OBSERVED_AT,
  buildBuybackEvInput,
} from "./buyback-adjusted-ev-calculator.test-support.ts";
import { evaluatePackScoutBuybackEvConfidenceV1 } from "./buyback-adjusted-ev-confidence.ts";
import {
  computePackScoutBuybackEvEffectiveFingerprintV1,
  type PackScoutBuybackEvCalculationIdentityV1,
  type PackScoutBuybackEvRevisionRecordV1,
} from "./buyback-adjusted-ev-revision-contracts.ts";
import {
  PackScoutBuybackEvRevisionStore,
  PackScoutBuybackEvRevisionStoreError,
  type PackScoutBuybackEvRevisionPersistencePortV1,
  type PersistBuybackEvRevisionPortInput,
  type PersistPackScoutBuybackEvRevisionCommandV1,
} from "./buyback-adjusted-ev-revision-store.ts";
import type {
  OperationalLog,
  OperationalMetric,
} from "./operational-events.ts";

const ids = {
  organization: "40000000-0000-4000-8000-000000000001",
  provider: "40000000-0000-4000-8000-000000000002",
  configuration: "40000000-0000-4000-8000-000000000003",
  sourceInstance: "40000000-0000-4000-8000-000000000004",
  revision: "40000000-0000-4000-8000-0000000000aa",
} as const;

function identityFor(
  input: PackScoutBuybackEvInputV1,
): PackScoutBuybackEvCalculationIdentityV1 {
  return {
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    platformKey: input.observation.providerKey,
    productKey: input.product.productKey,
    productRevisionId: input.product.productRevisionId,
    sourceRevisionId: input.observation.sourceRevisionId,
    sourceManifestSha256: input.observation.sourceManifestSha256,
    observationCoherence: input.observation.coherenceKind,
    providerSourceRevisionId: ids.configuration,
  };
}

function availableCommand(
  overrides: Partial<PersistPackScoutBuybackEvRevisionCommandV1> = {},
  calculatedAt: string = BUYBACK_EV_TEST_CALCULATED_AT,
): PersistPackScoutBuybackEvRevisionCommandV1 {
  const input = buildBuybackEvInput();
  const calculation = calculatePackScoutBuybackAdjustedEvV1({
    input,
    calculatedAt,
  });
  const evaluation =
    calculation.status === "available"
      ? evaluatePackScoutBuybackEvConfidenceV1(calculation.confidenceInput)
      : null;
  return {
    organizationId: ids.organization,
    providerId: ids.provider,
    providerSourceRevisionId: ids.configuration,
    calculation,
    confidenceEvaluation: evaluation,
    effectiveFingerprint: computePackScoutBuybackEvEffectiveFingerprintV1({
      identity: identityFor(input),
      evidence: { kind: "complete_input", input },
    }),
    sourceRevisions: [
      {
        sourceRevisionId: input.observation.sourceRevisionId,
        sourceManifestSha256: input.observation.sourceManifestSha256,
      },
    ],
    ...overrides,
  };
}

function gateFailedFreshCommand(): PersistPackScoutBuybackEvRevisionCommandV1 {
  const input = buildBuybackEvInput();
  const calculation = {
    schemaVersion: PACKSCOUT_BUYBACK_EV_SCHEMA_VERSION,
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    visibility: PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY,
    status: "unavailable",
    grossEvMoney: null,
    grossReturnBasisPoints: null,
    evDollars: null,
    evPercentBasisPoints: null,
    calculatedAt: BUYBACK_EV_TEST_CALCULATED_AT,
    dataAsOf: { state: "known", observedAt: BUYBACK_EV_TEST_OBSERVED_AT },
    provenance: {
      providerKey: input.observation.providerKey,
      productKey: input.product.productKey,
      productRevisionId: input.product.productRevisionId,
      sourceRevisionId: "catalog-revision-200",
      sourceManifestSha256: null,
      observationCoherence: "provider_revision",
      oddsSource: "current_remaining_inventory",
      usedClosedRangeMidpoint: false,
    },
    protectedEvidence: null,
    confidenceInput: {
      schemaVersion: PACKSCOUT_BUYBACK_EV_SCHEMA_VERSION,
      methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
      confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
      visibility: PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY,
      oddsSource: "current_remaining_inventory",
      usedClosedRangeMidpoint: false,
      oldestEssentialObservedAt: BUYBACK_EV_TEST_OBSERVED_AT,
      calculatedAt: BUYBACK_EV_TEST_CALCULATED_AT,
      availabilityGate: {
        status: "failed",
        internalReasons: ["MISSING_BUYBACK"],
      },
    },
    internalReasons: ["MISSING_BUYBACK"],
    publicPrimaryReason: "BUYBACK_UNAVAILABLE",
  };
  return {
    organizationId: ids.organization,
    providerId: ids.provider,
    providerSourceRevisionId: ids.configuration,
    calculation,
    confidenceEvaluation: null,
    effectiveFingerprint: computePackScoutBuybackEvEffectiveFingerprintV1({
      identity: {
        ...identityFor(input),
        sourceRevisionId: "catalog-revision-200",
        sourceManifestSha256: null,
      },
      evidence: {
        kind: "unavailable_evidence",
        dataAsOf: { state: "known", observedAt: BUYBACK_EV_TEST_OBSERVED_AT },
        internalReasons: ["MISSING_BUYBACK"],
      },
    }),
    sourceRevisions: [{ sourceRevisionId: "catalog-revision-200" }],
  };
}

class FakePort implements PackScoutBuybackEvRevisionPersistencePortV1 {
  persistInputs: PersistBuybackEvRevisionPortInput[] = [];
  persistOutcomes: Awaited<
    ReturnType<PackScoutBuybackEvRevisionPersistencePortV1["persistCompletedRevision"]>
  >[] = [];
  failures = new Map<string, { reasonCode: string; occurrenceCount: number }>();
  currentRow: PackScoutBuybackEvRevisionRecordV1 | null = null;

  rowFor(
    input: PersistBuybackEvRevisionPortInput,
    revisionNumber: number,
  ): PackScoutBuybackEvRevisionRecordV1 {
    return {
      revisionId: ids.revision,
      organizationId: input.organizationId,
      providerId: input.providerId,
      providerSourceRevisionId: input.providerSourceRevisionId,
      sourceInstanceId: ids.sourceInstance,
      platformKey: input.platformKey,
      productKey: input.productKey,
      productRevisionId: input.productRevisionId,
      methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
      confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
      lifecycle: "completed",
      status: input.status,
      revisionNumber,
      calculationKey: input.calculationKey,
      effectiveFingerprint: input.effectiveFingerprint,
      resultHash: input.resultHash,
      sourceRevisionId: input.sourceRevisionId,
      sourceManifestSha256: input.sourceManifestSha256,
      observationCoherence: input.observationCoherence,
      oddsSource: input.oddsSource,
      usedClosedRangeMidpoint: input.usedClosedRangeMidpoint,
      calculatedAt: input.calculatedAt,
      dataAsOf: input.dataAsOf,
      metrics: input.metrics,
      confidence: input.confidence,
      freshness: input.freshness,
      internalReasons: input.internalReasons,
      publicPrimaryReason: input.publicPrimaryReason,
      createdAt: input.calculatedAt,
    };
  }

  async persistCompletedRevision(input: PersistBuybackEvRevisionPortInput) {
    this.persistInputs.push(input);
    const outcome = this.persistOutcomes.shift() ?? {
      outcome: "created" as const,
      row: this.rowFor(input, this.persistInputs.length),
    };
    return outcome;
  }

  async recordPersistenceFailure(input: {
    organizationId: string;
    failureKey: string;
    reasonCode:
      | "CONTRACT_VIOLATION"
      | "IDENTITY_REUSE_CONFLICT"
      | "RESULT_CONFLICT"
      | "UNBINDABLE_RESULT";
    providerId: string | null;
    platformKey: string | null;
    productKey: string | null;
    seenAt: string;
  }) {
    const existing = this.failures.get(input.failureKey);
    if (existing) {
      existing.occurrenceCount += 1;
      return { occurrenceCount: existing.occurrenceCount, created: false };
    }
    this.failures.set(input.failureKey, {
      reasonCode: input.reasonCode,
      occurrenceCount: 1,
    });
    return { occurrenceCount: 1, created: true };
  }

  async getCurrentCompletedRevision(input: {
    organizationId: string;
    platformKey: string;
    productKey: string;
    methodVersion: string;
  }) {
    assert.equal(input.methodVersion, PACKSCOUT_BUYBACK_EV_METHOD_VERSION);
    return this.currentRow;
  }

  async getRevisionTrace() {
    return null;
  }
}

function observedTelemetry(): {
  logs: OperationalLog[];
  metrics: OperationalMetric[];
  observability: { log(entry: OperationalLog): void; metric(metric: OperationalMetric): void };
} {
  const logs: OperationalLog[] = [];
  const metrics: OperationalMetric[] = [];
  return {
    logs,
    metrics,
    observability: {
      log: (entry) => logs.push(entry),
      metric: (metric) => metrics.push(metric),
    },
  };
}

test("an available calculation persists as a created revision with bounded telemetry", async () => {
  const port = new FakePort();
  const telemetry = observedTelemetry();
  const store = new PackScoutBuybackEvRevisionStore(port, telemetry.observability);
  const result = await store.persistCompletedCalculation(availableCommand());
  assert.equal(result.outcome, "created");
  if (result.outcome !== "created") return;
  assert.equal(result.revision.status, "available");
  assert.equal(result.revision.methodVersion, PACKSCOUT_BUYBACK_EV_METHOD_VERSION);
  assert.equal(result.projection.status, "available");
  const persisted = port.persistInputs[0]!;
  assert.equal(persisted.status, "available");
  assert.deepEqual(persisted.metrics, {
    packPriceMinorUnits: 10_000,
    underlyingOutcomeEvMinorUnits: 10_000,
    drawMultiplier: 1,
    grossEvMinorUnits: 8_500,
    grossReturnBasisPoints: 8_500,
    evDollarsMinorUnits: -1_500,
    evPercentBasisPoints: -1_500,
  });
  assert.deepEqual(persisted.internalReasons, []);
  assert.equal(persisted.freshness.state, "current");
  assert.deepEqual(
    telemetry.logs.map(({ code, level }) => ({ code, level })),
    [{ code: "BUYBACK_EV_REVISION_CREATED", level: "info" }],
  );
  assert.deepEqual(
    telemetry.metrics.map(({ name, outcomeCode }) => ({ name, outcomeCode })),
    [{ name: "calculation_availability_total", outcomeCode: "AVAILABLE" }],
  );
  const serializedTelemetry = JSON.stringify([telemetry.logs, telemetry.metrics]);
  assert.doesNotMatch(serializedTelemetry, /8500|10000|1500|minorUnits|grossEv/);
});

test("an identical replay returns the unchanged revision without new telemetry noise", async () => {
  const port = new FakePort();
  const telemetry = observedTelemetry();
  const store = new PackScoutBuybackEvRevisionStore(port, telemetry.observability);
  const command = availableCommand();
  const first = await store.persistCompletedCalculation(command);
  assert.equal(first.outcome, "created");
  port.persistOutcomes.push({
    outcome: "unchanged",
    row: port.rowFor(port.persistInputs[0]!, 1),
  });
  const replay = await store.persistCompletedCalculation(command);
  assert.equal(replay.outcome, "unchanged");
  if (replay.outcome !== "unchanged" || first.outcome !== "created") return;
  assert.equal(replay.revision.revisionId, first.revision.revisionId);
  assert.equal(replay.revision.resultHash, first.revision.resultHash);
  assert.equal(port.failures.size, 0);
  assert.equal(
    telemetry.logs.at(-1)?.code,
    "BUYBACK_EV_REVISION_UNCHANGED",
  );
});

test("an expired confidence evaluation composes into an unavailable stale revision", async () => {
  const port = new FakePort();
  const store = new PackScoutBuybackEvRevisionStore(port);
  const command = availableCommand({}, "2026-08-19T20:05:00.000Z");
  const result = await store.persistCompletedCalculation(command);
  assert.equal(result.outcome, "created");
  const persisted = port.persistInputs[0]!;
  assert.equal(persisted.status, "unavailable");
  assert.deepEqual(persisted.internalReasons, ["STALE_EVIDENCE"]);
  assert.equal(persisted.publicPrimaryReason, "SOURCE_DATA_STALE");
  assert.equal(persisted.freshness.state, "expired");
  assert.equal(persisted.metrics, null);
  if (result.outcome !== "created") return;
  assert.equal(result.projection.status, "unavailable");
});

test("a failed availability gate with current evidence persists without an evaluation", async () => {
  const port = new FakePort();
  const store = new PackScoutBuybackEvRevisionStore(port);
  const result = await store.persistCompletedCalculation(gateFailedFreshCommand());
  assert.equal(result.outcome, "created");
  const persisted = port.persistInputs[0]!;
  assert.equal(persisted.status, "unavailable");
  assert.deepEqual(persisted.internalReasons, ["MISSING_BUYBACK"]);
  assert.equal(persisted.publicPrimaryReason, "BUYBACK_UNAVAILABLE");
  assert.equal(persisted.freshness.state, "current");
});

test("unbindable results and conflicts land in the deduplicated failure ledger", async () => {
  const port = new FakePort();
  const telemetry = observedTelemetry();
  const store = new PackScoutBuybackEvRevisionStore(port, telemetry.observability);
  const unbindable = availableCommand({
    calculation: calculatePackScoutBuybackAdjustedEvV1({
      input: { garbage: true },
      calculatedAt: BUYBACK_EV_TEST_CALCULATED_AT,
    }),
    confidenceEvaluation: null,
  });
  const first = await store.persistCompletedCalculation(unbindable);
  assert.deepEqual(first, {
    outcome: "failed",
    reason: "UNBINDABLE_RESULT",
    occurrenceCount: 1,
  });
  const repeated = await store.persistCompletedCalculation(unbindable);
  assert.deepEqual(repeated, {
    outcome: "failed",
    reason: "UNBINDABLE_RESULT",
    occurrenceCount: 2,
  });
  assert.equal(port.failures.size, 1);
  assert.equal(port.persistInputs.length, 0);

  port.persistOutcomes.push({ outcome: "identity_conflict" });
  const rejected = await store.persistCompletedCalculation(availableCommand());
  assert.deepEqual(rejected, {
    outcome: "rejected",
    reason: "IDENTITY_REUSE_CONFLICT",
    occurrenceCount: 1,
  });
  port.persistOutcomes.push({ outcome: "result_conflict" });
  const conflicting = await store.persistCompletedCalculation(availableCommand());
  assert.deepEqual(conflicting, {
    outcome: "rejected",
    reason: "RESULT_CONFLICT",
    occurrenceCount: 1,
  });
  assert.equal(port.failures.size, 3);
  assert.deepEqual(
    telemetry.logs.map(({ code }) => code),
    [
      "BUYBACK_EV_REVISION_FAILED_UNBINDABLE_RESULT",
      "BUYBACK_EV_REVISION_FAILED_UNBINDABLE_RESULT",
      "BUYBACK_EV_REVISION_FAILED_IDENTITY_REUSE_CONFLICT",
      "BUYBACK_EV_REVISION_FAILED_RESULT_CONFLICT",
    ],
  );
  assert.ok(telemetry.logs.every(({ level }) => level === "warning"));
});

test("contract violations fail closed before touching the revision store", async () => {
  const port = new FakePort();
  const store = new PackScoutBuybackEvRevisionStore(port);
  const violates = (
    command: PersistPackScoutBuybackEvRevisionCommandV1,
  ): Promise<void> =>
    assert.rejects(
      store.persistCompletedCalculation(command),
      (error: unknown) =>
        error instanceof PackScoutBuybackEvRevisionStoreError &&
        error.code === "CONTRACT_VIOLATION",
    );

  await violates(availableCommand({ calculation: { status: "available" } }));
  await violates(availableCommand({ confidenceEvaluation: { status: "?" } }));
  await violates(availableCommand({ effectiveFingerprint: "not-hex" }));
  await violates(availableCommand({ confidenceEvaluation: null }));
  await violates(availableCommand({ sourceRevisions: [] }));
  await violates(
    availableCommand({
      sourceRevisions: [{ sourceRevisionId: "some-other-revision" }],
    }),
  );
  await violates(
    availableCommand({
      sourceRevisions: Array.from({ length: 17 }, (_, index) => ({
        sourceRevisionId: `revision-${index}`,
      })),
    }),
  );
  const base = availableCommand();
  const mismatchedEvaluation = evaluatePackScoutBuybackEvConfidenceV1({
    schemaVersion: PACKSCOUT_BUYBACK_EV_SCHEMA_VERSION,
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    visibility: PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY,
    oddsSource: "current_remaining_inventory",
    usedClosedRangeMidpoint: false,
    oldestEssentialObservedAt: BUYBACK_EV_TEST_OBSERVED_AT,
    calculatedAt: "2026-08-19T18:06:00.000Z",
    availabilityGate: { status: "passed" },
  });
  await violates({ ...base, confidenceEvaluation: mismatchedEvaluation });
  assert.equal(port.persistInputs.length, 0);
});

test("a throwing observer never breaks a committed persistence outcome", async () => {
  const port = new FakePort();
  const store = new PackScoutBuybackEvRevisionStore(port, {
    log() {
      throw new Error("telemetry offline");
    },
    metric() {
      throw new Error("telemetry offline");
    },
  });
  const result = await store.persistCompletedCalculation(availableCommand());
  assert.equal(result.outcome, "created");
});

test("the current-publication reader validates method version and row integrity", async () => {
  const port = new FakePort();
  const store = new PackScoutBuybackEvRevisionStore(port);
  assert.equal(
    await store.getCurrentPublication({
      organizationId: ids.organization,
      platformKey: "courtyard",
      productKey: "courtyard-ironman-repack",
    }),
    null,
  );
  await assert.rejects(
    store.getCurrentPublication({
      organizationId: ids.organization,
      platformKey: "courtyard",
      productKey: "courtyard-ironman-repack",
      methodVersion: "packscout-estimated-ev-v2",
    }),
    (error: unknown) =>
      error instanceof PackScoutBuybackEvRevisionStoreError &&
      error.code === "UNSUPPORTED_METHOD_VERSION",
  );
  const persisted = await store.persistCompletedCalculation(availableCommand());
  assert.equal(persisted.outcome, "created");
  port.currentRow = port.rowFor(port.persistInputs[0]!, 1);
  const current = await store.getCurrentPublication({
    organizationId: ids.organization,
    platformKey: "courtyard",
    productKey: "courtyard-ironman-repack",
  });
  assert.ok(current);
  assert.equal(current.projection.status, "available");
  assert.equal(current.revision.revisionNumber, 1);

  port.currentRow = {
    ...port.currentRow!,
    metrics: { ...port.currentRow!.metrics!, grossEvMinorUnits: 8_501 },
  };
  await assert.rejects(
    store.getCurrentPublication({
      organizationId: ids.organization,
      platformKey: "courtyard",
      productKey: "courtyard-ironman-repack",
    }),
    /cannot be projected/,
  );
});

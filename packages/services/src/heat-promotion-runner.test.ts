import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  MAX_PUBLIC_REPACKS_PER_RELEASE,
  canonicalJson,
  productionHeatReceiptHash,
  productionHeatReceiptSchema,
} from "@packscout/contracts";
import {
  HeatPromotionBootstrapCoordinator,
  HeatPromotionBootstrapError,
} from "./heat-promotion-bootstrap.ts";
import { prepareHeatPromotion } from "./heat-promotion-operations.ts";
import { HeatPromotionRunner } from "./heat-promotion-runner.ts";
import {
  FakeHeatPublicationTransport,
  MemoryHeatPromotionLedger,
  MutableHeatTestClock,
} from "./heat-promotion-runner.test-support.ts";
import type {
  ActiveCatalogHeatManifest,
  ActiveHeatFrameBaseline,
  HeatPromotionBootstrapPort,
  HeatPromotionHealthSink,
  HeatPromotionObservationPort,
  HeatPublicationTransport,
} from "./heat-promotion-types.ts";

const releaseId = "82000000-0000-5000-8000-000000000001";
const repackIds = [
  "83000000-0000-5000-8000-000000000001",
  "83000000-0000-5000-8000-000000000002",
] as const;
const initialBoundary = new Date("2026-08-15T12:00:00.000Z");

const manifestAlignment = Object.freeze({
  publicReleaseId: releaseId,
  manifestFingerprint: "1".repeat(64),
  sharedConfigurationEpoch: Object.freeze({
    configurationKey: "catalog-v1",
    revision: 1,
    publicChangeSequence: "20",
    configurationHash: "2".repeat(64),
  }),
  providerReferenceSetHash: "3".repeat(64),
});

const catalog: ActiveCatalogHeatManifest = Object.freeze({
  manifestAlignment,
  providerReferences: [],
  publicRepackOwnership: repackIds.map((publicRepackId) => ({
    publicRepackId,
    platformKey: "alpha",
    publicProviderReleaseId:
      "84000000-0000-5000-8000-000000000001",
    providerReleaseFingerprint: "4".repeat(64),
  })),
  publicRepackIds: repackIds,
  confirmedManifestWatermark: 40n,
  terminalReceiptSha256: "a".repeat(64),
});

function completeObservations(): HeatPromotionObservationPort {
  return {
    async readFrame() {
      return {
        observations: [],
        sourceCoverageComplete: true,
        truncated: false,
      };
    },
  };
}

function createRunner(input: Readonly<{
  ledger: MemoryHeatPromotionLedger;
  transport: HeatPublicationTransport;
  clock: MutableHeatTestClock;
  checkpoint?: { settledSequence: bigint; settledAt: Date | null };
  baseline?: ActiveHeatFrameBaseline | null;
  observations?: HeatPromotionObservationPort;
  bootstrap?: HeatPromotionBootstrapPort;
  alerts?: string[];
  maximumRetries?: number;
  health?: HeatPromotionHealthSink;
  catalog?: ActiveCatalogHeatManifest;
  workerId?: string;
}>): HeatPromotionRunner {
  const checkpoint = input.checkpoint ?? {
    settledSequence: 44n,
    settledAt: input.clock.now(),
  };
  return new HeatPromotionRunner({
    workerId: input.workerId ?? "heat-worker-1",
    ledger: input.ledger,
    settlement: { async getCheckpoint() { return checkpoint; } },
    manifests: {
      async loadActiveCatalogManifest() { return input.catalog ?? catalog; },
      async loadActiveHeatFrame() { return input.baseline ?? null; },
      async hasReusableHeatSignalSet() { return false; },
    },
    observations: input.observations ?? completeObservations(),
    transport: input.transport,
    bootstrap: input.bootstrap ?? { async ensureVerified() {} },
    clock: input.clock,
    alerts: {
      async notify(alert) { input.alerts?.push(alert.failureCode); },
    },
    health: input.health,
    random: { fraction: () => 0 },
    initialRetryMilliseconds: 100,
    maximumRetryMilliseconds: 1_000,
    maximumRetries: input.maximumRetries,
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function leaveAcknowledgedAttemptForRestart(input: Readonly<{
  ledger: MemoryHeatPromotionLedger;
  transport: FakeHeatPublicationTransport;
  clock: MutableHeatTestClock;
}>): Promise<void> {
  input.ledger.rejectCompletionOnce = true;
  const result = await createRunner(input).runCycle(initialBoundary);
  assert.equal(result.outcome, "lease_lost");
  assert.ok(input.ledger.attempt?.operations.every(({ state }) =>
    state === "acknowledged"));
}

async function priorBaseline(): Promise<ActiveHeatFrameBaseline> {
  const plan = await prepareHeatPromotion({
    targetFrameSequence: BigInt(initialBoundary.getTime() / 60_000),
    frameEndedAt: initialBoundary,
    calculatedAt: new Date(initialBoundary.getTime() + 1_000),
    sourceWatermark: 44n,
    catalog,
    baseline: null,
    observations: completeObservations(),
    async canReuseSignalSet() { return false; },
  });
  return {
    publicHeatFrameId: plan.publicHeatFrameId,
    manifestAlignment: plan.manifestAlignment,
    frameSequence: Number(plan.targetFrameSequence),
    sourceWatermark: plan.sourceWatermark,
    signalSetHash: plan.signalSetHash,
    frameHash: plan.frameHash,
    signalCount: plan.signalCount,
    terminalReceiptSha256: "b".repeat(64),
  };
}

test("a healthy closed minute publishes one bounded aggregate frame", async () => {
  const clock = new MutableHeatTestClock();
  const ledger = new MemoryHeatPromotionLedger();
  const transport = new FakeHeatPublicationTransport();
  const result = await createRunner({ ledger, transport, clock })
    .runCycle(initialBoundary);
  assert.equal(result.outcome, "published");
  assert.equal(result.operationsAcknowledged, 3);
  assert.deepEqual(transport.events, [
    "send:start", "send:applyBatch", "send:finalize",
  ]);
  assert.deepEqual(ledger.terminal, [{
    state: "published",
    failureCode: null,
    failureClass: null,
    targetWatermark: BigInt(initialBoundary.getTime() / 60_000),
    preparedClassification: "publish",
  }]);
});

test("Heat runner rejects worker identities beyond the durable ledger bound", () => {
  assert.throws(
    () => createRunner({
      ledger: new MemoryHeatPromotionLedger(),
      transport: new FakeHeatPublicationTransport(),
      clock: new MutableHeatTestClock(),
      workerId: `w${"x".repeat(128)}`,
    }),
    /identity is invalid/u,
  );
});

test("maximum release volume activates in one minute cycle", async (t) => {
  const clock = new MutableHeatTestClock();
  const ledger = new MemoryHeatPromotionLedger();
  const transport = new FakeHeatPublicationTransport();
  const maximumPublicRepackIds = Array.from(
    { length: MAX_PUBLIC_REPACKS_PER_RELEASE },
    (_value, index) =>
      `83000000-0000-5000-8000-${String(index + 1).padStart(12, "0")}`,
  );
  const maximumCatalog: ActiveCatalogHeatManifest = {
    ...catalog,
    publicRepackIds: maximumPublicRepackIds,
    publicRepackOwnership: maximumPublicRepackIds.map(
    (publicRepackId) => ({
      publicRepackId,
      platformKey: "alpha",
      publicProviderReleaseId:
        "84000000-0000-5000-8000-000000000001",
      providerReleaseFingerprint: "4".repeat(64),
    }),
    ),
  };
  const startedAt = performance.now();
  const result = await createRunner({
    ledger,
    transport,
    clock,
    catalog: maximumCatalog,
  }).runCycle(initialBoundary);
  const elapsedMilliseconds = performance.now() - startedAt;
  assert.equal(result.outcome, "published");
  assert.ok(result.operationsAcknowledged > 32);
  assert.equal(result.operationsAcknowledged, transport.events.length);
  assert.equal(transport.events.at(-1), "send:finalize");
  assert.ok(elapsedMilliseconds < 60_000);
  t.diagnostic(
    `local 8k runner evidence: ${elapsedMilliseconds.toFixed(1)}ms, ` +
      `${result.operationsAcknowledged} operations (not a live p95 measurement)`,
  );
});

for (const lostKind of ["start", "applyBatch", "finalize"] as const) {
  test(`lost Heat ${lostKind} acknowledgement is status-first after restart`, async () => {
    const clock = new MutableHeatTestClock();
    const ledger = new MemoryHeatPromotionLedger();
    const transport = new FakeHeatPublicationTransport();
    transport.loseAfterStore = lostKind;
    const first = await createRunner({ ledger, transport, clock })
      .runCycle(initialBoundary);
    assert.equal(first.outcome, "retry_scheduled");
    clock.advance(1_000);
    const recovered = await createRunner({ ledger, transport, clock })
      .runCycle(initialBoundary);
    assert.equal(recovered.outcome, "published");
    const operationId = transport.statusOperationIds.at(-1);
    assert.ok(operationId);
    assert.equal(
      transport.sentOperationIds.filter((candidate) => candidate === operationId)
        .length,
      1,
    );
    assert.equal(ledger.terminal.length, 1);
  });
}

test("unchanged cores activate a new frame without signal rewrites", async () => {
  const baseline = await priorBaseline();
  const refreshedCatalog: ActiveCatalogHeatManifest = {
    ...catalog,
    confirmedManifestWatermark: catalog.confirmedManifestWatermark + 1n,
    terminalReceiptSha256: "c".repeat(64),
  };
  const boundary = new Date(initialBoundary.getTime() + 60_000);
  const clock = new MutableHeatTestClock(
    new Date(boundary.getTime() + 1_000),
  );
  const ledger = new MemoryHeatPromotionLedger();
  ledger.confirmedWatermark = BigInt(baseline.frameSequence);
  ledger.confirmedPublicationIdentity = baseline.publicHeatFrameId;
  ledger.expectedPredecessorIdentity = baseline.publicHeatFrameId;
  const transport = new FakeHeatPublicationTransport();
  const result = await createRunner({
    ledger,
    transport,
    clock,
    baseline,
    catalog: refreshedCatalog,
  }).runCycle(boundary);
  assert.equal(result.outcome, "published");
  assert.equal(result.reusedSignalSet, true);
  assert.deepEqual(transport.events, ["send:refreshFrame"]);
  assert.equal(ledger.terminal[0]?.preparedClassification, "refresh_unchanged");
  assert.notEqual(
    ledger.confirmedPublicationIdentity,
    baseline.publicHeatFrameId,
  );
});

test("lost unchanged refresh acknowledgement is status-first after restart", async () => {
  const baseline = await priorBaseline();
  const boundary = new Date(initialBoundary.getTime() + 60_000);
  const clock = new MutableHeatTestClock(
    new Date(boundary.getTime() + 1_000),
  );
  const ledger = new MemoryHeatPromotionLedger();
  ledger.confirmedWatermark = BigInt(baseline.frameSequence);
  ledger.confirmedPublicationIdentity = baseline.publicHeatFrameId;
  ledger.expectedPredecessorIdentity = baseline.publicHeatFrameId;
  const transport = new FakeHeatPublicationTransport();
  transport.loseAfterStore = "refreshFrame";
  const input = { ledger, transport, clock, baseline };
  assert.equal(
    (await createRunner(input).runCycle(boundary)).outcome,
    "retry_scheduled",
  );
  clock.advance(1_000);
  const recovered = await createRunner(input).runCycle(boundary);
  assert.equal(recovered.outcome, "published");
  assert.deepEqual(transport.events, [
    "send:refreshFrame", "status:refreshFrame",
  ]);
  assert.equal(transport.sentOperationIds.length, 1);
  assert.equal(ledger.terminal.length, 1);
});

test("status not-found resends exact durable Heat bytes once", async () => {
  const clock = new MutableHeatTestClock();
  const ledger = new MemoryHeatPromotionLedger();
  const transport = new FakeHeatPublicationTransport();
  transport.failBeforeStore = "start";
  assert.equal(
    (await createRunner({ ledger, transport, clock }).runCycle(initialBoundary))
      .outcome,
    "retry_scheduled",
  );
  const durableBody = transport.sentBodies[0];
  clock.advance(1_000);
  assert.equal(
    (await createRunner({ ledger, transport, clock }).runCycle(initialBoundary))
      .outcome,
    "published",
  );
  assert.deepEqual(transport.events.slice(0, 3), [
    "send:start", "status:start", "send:start",
  ]);
  assert.equal(transport.sentBodies[1], durableBody);
});

for (const corruption of ["body", "hash"] as const) {
  test(`restart rejects a persisted Heat receipt with a tampered ${corruption}`,
    async () => {
      const clock = new MutableHeatTestClock();
      const ledger = new MemoryHeatPromotionLedger();
      const transport = new FakeHeatPublicationTransport();
      await leaveAcknowledgedAttemptForRestart({ ledger, transport, clock });
      const terminal = ledger.attempt?.operations.at(-1);
      assert.ok(terminal?.receiptBody);
      if (corruption === "body") {
        Object.assign(terminal, {
          receiptBody: `${terminal.receiptBody} `,
        });
      } else {
        Object.assign(terminal, { receiptSha256: "0".repeat(64) });
      }
      const result = await createRunner({ ledger, transport, clock })
        .runCycle(initialBoundary);
      assert.equal(result.outcome, "failed");
      assert.equal(result.failureCode, "HEAT_LEDGER_INVALID");
      assert.equal(ledger.confirmedWatermark, 0n);
      assert.equal(ledger.terminal[0]?.failureClass, "reconciliation");
    });
}

test("restart rejects a substituted Heat manifest source proof", async () => {
  const clock = new MutableHeatTestClock();
  const ledger = new MemoryHeatPromotionLedger();
  const transport = new FakeHeatPublicationTransport();
  await leaveAcknowledgedAttemptForRestart({ ledger, transport, clock });
  assert.ok(ledger.attempt?.manifestSourceProof);
  ledger.attempt.manifestSourceProof = {
    ...ledger.attempt.manifestSourceProof,
    publicRepackOwnership: ledger.attempt.manifestSourceProof
      .publicRepackOwnership.slice(1),
  };
  const result = await createRunner({ ledger, transport, clock })
    .runCycle(initialBoundary);
  assert.equal(result.outcome, "failed");
  assert.equal(result.failureCode, "HEAT_LEDGER_INVALID");
  assert.equal(ledger.confirmedWatermark, 0n);
  assert.equal(ledger.terminal[0]?.failureClass, "reconciliation");
});

test("restart rejects a substituted terminal Heat detail", async () => {
  const clock = new MutableHeatTestClock();
  const ledger = new MemoryHeatPromotionLedger();
  const transport = new FakeHeatPublicationTransport();
  await leaveAcknowledgedAttemptForRestart({ ledger, transport, clock });
  const terminal = ledger.attempt?.operations.at(-1);
  assert.ok(terminal?.receiptBody);
  const parsed = productionHeatReceiptSchema.parse(
    JSON.parse(terminal.receiptBody) as unknown,
  );
  assert.equal(parsed.operationKind, "finalize");
  if (parsed.operationKind !== "finalize") {
    throw new Error("terminal Heat fixture kind is invalid");
  }
  const { receiptDigest: _receiptDigest, ...withoutDigest } = parsed;
  void _receiptDigest;
  const substitutedWithoutDigest = {
    ...withoutDigest,
    details: {
      ...parsed.details,
      expiresAt: "2026-08-15T12:16:01.000Z",
    },
  };
  const receiptBody = canonicalJson(productionHeatReceiptSchema.parse({
    ...substitutedWithoutDigest,
    receiptDigest: await productionHeatReceiptHash(
      substitutedWithoutDigest,
    ),
  }));
  Object.assign(terminal, {
    receiptBody,
    receiptSha256: sha256(receiptBody),
  });
  const result = await createRunner({ ledger, transport, clock })
    .runCycle(initialBoundary);
  assert.equal(result.outcome, "failed");
  assert.equal(result.failureCode, "HEAT_LEDGER_INVALID");
  assert.equal(ledger.confirmedWatermark, 0n);
  assert.equal(ledger.terminal[0]?.failureClass, "reconciliation");
});

test("late settlement in the same closed minute waits for the next boundary", async () => {
  const clock = new MutableHeatTestClock();
  const ledger = new MemoryHeatPromotionLedger();
  const transport = new FakeHeatPublicationTransport();
  const checkpoint = { settledSequence: 44n, settledAt: clock.now() };
  const runner = () => createRunner({ ledger, transport, clock, checkpoint });
  assert.equal((await runner().runCycle(initialBoundary)).outcome, "published");
  const sends = transport.sentOperationIds.length;
  checkpoint.settledSequence = 45n;
  clock.advance(10_000);
  assert.equal((await runner().runCycle(initialBoundary)).outcome, "idle");
  assert.equal(transport.sentOperationIds.length, sends);
  assert.equal(ledger.terminal.length, 1);
});

test("transient observation failures schedule a technical retry", async () => {
  const clock = new MutableHeatTestClock();
  const ledger = new MemoryHeatPromotionLedger();
  const transport = new FakeHeatPublicationTransport();
  const result = await createRunner({
    ledger,
    transport,
    clock,
    observations: {
      async readFrame() { throw new Error("database unavailable"); },
    },
  }).runCycle(initialBoundary);
  assert.equal(result.outcome, "retry_scheduled");
  assert.equal(result.failureCode, "HEAT_SOURCE_UNAVAILABLE");
  assert.equal(ledger.attempt?.state, "retry_wait");
  assert.deepEqual(ledger.terminal, []);
  assert.deepEqual(transport.events, []);
});

for (const failureCode of [
  "PUBLICATION_PREDECESSOR_CONFLICT",
  "PUBLICATION_RECONCILIATION_FAILED",
  "PUBLICATION_STATE_CONFLICT",
] as const) {
  test(`${failureCode} records a durable reconciliation failure`, async () => {
    const clock = new MutableHeatTestClock();
    const ledger = new MemoryHeatPromotionLedger();
    const transport = new FakeHeatPublicationTransport();
    transport.terminalFailureCode = failureCode;
    const result = await createRunner({ ledger, transport, clock })
      .runCycle(initialBoundary);
    assert.equal(result.outcome, "failed");
    assert.equal(result.failureCode, failureCode);
    assert.equal(ledger.terminal[0]?.failureClass, "reconciliation");
  });
}

test("authenticated request rejection stays deterministic", async () => {
  const clock = new MutableHeatTestClock();
  const ledger = new MemoryHeatPromotionLedger();
  const transport = new FakeHeatPublicationTransport();
  transport.terminalFailureCode = "PUBLICATION_REQUEST_INVALID";
  const result = await createRunner({ ledger, transport, clock })
    .runCycle(initialBoundary);
  assert.equal(result.outcome, "failed");
  assert.equal(ledger.terminal[0]?.failureClass, "deterministic");
});

test("incomplete source coverage fails Heat without touching transport", async () => {
  const clock = new MutableHeatTestClock();
  const ledger = new MemoryHeatPromotionLedger();
  const transport = new FakeHeatPublicationTransport();
  const alerts: string[] = [];
  const result = await createRunner({
    ledger,
    transport,
    clock,
    alerts,
    observations: {
      async readFrame() {
        return {
          observations: [],
          sourceCoverageComplete: false,
          truncated: false,
        };
      },
    },
  }).runCycle(initialBoundary);
  assert.equal(result.outcome, "failed");
  assert.equal(result.failureCode, "HEAT_OBSERVATION_COVERAGE_INCOMPLETE");
  assert.equal(ledger.terminal[0]?.failureClass, "deterministic");
  assert.deepEqual(alerts, ["HEAT_OBSERVATION_COVERAGE_INCOMPLETE"]);
  assert.deepEqual(transport.events, []);
});

test("retry exhaustion records an honest technical terminal class", async () => {
  const clock = new MutableHeatTestClock();
  const ledger = new MemoryHeatPromotionLedger();
  const transport = new FakeHeatPublicationTransport();
  const input = {
    ledger,
    transport,
    clock,
    maximumRetries: 1,
    observations: {
      async readFrame(): Promise<never> {
        throw new Error("database unavailable");
      },
    },
  };
  assert.equal(
    (await createRunner(input).runCycle(initialBoundary)).outcome,
    "retry_scheduled",
  );
  clock.advance(1_000);
  const terminal = await createRunner(input).runCycle(initialBoundary);
  assert.equal(terminal.outcome, "failed");
  assert.equal(terminal.failureCode, "HEAT_RETRY_EXHAUSTED");
  assert.equal(ledger.terminal[0]?.failureClass, "technical");
});

test("a predecessor proof conflict records reconciliation failure", async () => {
  const baseline = await priorBaseline();
  const boundary = new Date(initialBoundary.getTime() + 60_000);
  const clock = new MutableHeatTestClock(
    new Date(boundary.getTime() + 1_000),
  );
  const ledger = new MemoryHeatPromotionLedger();
  ledger.confirmedWatermark = BigInt(baseline.frameSequence);
  ledger.confirmedPublicationIdentity = baseline.publicHeatFrameId;
  ledger.expectedPredecessorIdentity = null;
  const result = await createRunner({
    ledger,
    transport: new FakeHeatPublicationTransport(),
    clock,
    baseline,
  }).runCycle(boundary);
  assert.equal(result.outcome, "failed");
  assert.equal(result.failureCode, "HEAT_BASELINE_CONFLICT");
  assert.equal(ledger.terminal[0]?.failureClass, "reconciliation");
});

test("cumulative apply receipt drift is never acknowledged", async () => {
  const clock = new MutableHeatTestClock();
  const ledger = new MemoryHeatPromotionLedger();
  const transport = new FakeHeatPublicationTransport();
  transport.corruptBatchProgress = true;
  const result = await createRunner({ ledger, transport, clock })
    .runCycle(initialBoundary);
  assert.equal(result.outcome, "retry_scheduled");
  assert.equal(result.failureCode, "HEAT_RESPONSE_INVALID");
  assert.equal(ledger.attempt?.operations[0]?.state, "acknowledged");
  assert.equal(ledger.attempt?.operations[1]?.state, "sent");
  assert.deepEqual(ledger.terminal, []);
});

test("shutdown during active-state proof stops before verification or dispatch", async () => {
  const clock = new MutableHeatTestClock();
  const ledger = new MemoryHeatPromotionLedger();
  ledger.bootstrapState = "unverified";
  const transport = new FakeHeatPublicationTransport();
  const controller = new AbortController();
  let entered!: () => void;
  const activeStateStarted = new Promise<void>((resolve) => { entered = resolve; });
  const bootstrap = new HeatPromotionBootstrapCoordinator(ledger, {
    async loadActiveHeatFrame() { return null; },
  }, {
    activeState(signal) {
      entered();
      return new Promise((resolve) => {
        const finish = () => resolve({
          activePublicHeatFrameId: null,
          manifestAlignment: null,
          sourceWatermark: null,
          frameSequence: 0,
          terminalReceiptSha256: null,
        });
        if (signal?.aborted === true) finish();
        else signal?.addEventListener("abort", finish, { once: true });
      });
    },
  });
  const cycle = createRunner({ ledger, transport, clock, bootstrap })
    .runCycle(initialBoundary, controller.signal);
  await activeStateStarted;
  controller.abort();
  const result = await cycle;
  assert.equal(result.outcome, "stopped");
  assert.equal(ledger.bootstrapState, "unverified");
  assert.equal(ledger.attempt?.claimCount, 0);
  assert.deepEqual(transport.events, []);
});

test("bootstrap rejects a remote frame aligned to another manifest proof", async () => {
  const ledger = new MemoryHeatPromotionLedger();
  ledger.bootstrapState = "unverified";
  const baseline = await priorBaseline();
  const bootstrap = new HeatPromotionBootstrapCoordinator(ledger, {
    async loadActiveHeatFrame() { return baseline; },
  }, {
    async activeState() {
      return {
        activePublicHeatFrameId: baseline.publicHeatFrameId,
        manifestAlignment: {
          ...baseline.manifestAlignment,
          providerReferenceSetHash: "f".repeat(64),
        },
        sourceWatermark: baseline.sourceWatermark,
        frameSequence: baseline.frameSequence,
        terminalReceiptSha256: baseline.terminalReceiptSha256,
      };
    },
  });
  await assert.rejects(
    bootstrap.ensureVerified({
      verifiedAt: new Date("2026-08-15T12:01:00.000Z"),
    }),
    (error: unknown) => error instanceof HeatPromotionBootstrapError &&
      error.code === "HEAT_BOOTSTRAP_UNPROVEN",
  );
  assert.equal(ledger.bootstrapState, "unverified");
});

test("thrown cycles still publish a safe lane health snapshot", async () => {
  const clock = new MutableHeatTestClock();
  const ledger = new MemoryHeatPromotionLedger();
  const health: unknown[] = [];
  await assert.rejects(
    createRunner({
      ledger,
      transport: new FakeHeatPublicationTransport(),
      clock,
      bootstrap: {
        async ensureVerified() { throw new Error("remote unavailable"); },
      },
      health: { report(snapshot) { health.push(snapshot); } },
    }).runCycle(initialBoundary),
    /remote unavailable/u,
  );
  assert.equal(health.length, 1);
});

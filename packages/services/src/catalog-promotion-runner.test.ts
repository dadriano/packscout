import assert from "node:assert/strict";
import { test } from "node:test";
import { CatalogReleaseAssembler } from "./catalog-release-assembler.ts";
import {
  fixtureCheckpoint,
  fixtureSnapshot,
} from "./catalog-release-fixture.test-support.ts";
import { CatalogPromotionRunner } from "./catalog-promotion-runner.ts";
import {
  FakeCatalogPublicationTransport,
  MemoryCatalogPromotionLedger,
  MutableTestClock,
} from "./catalog-promotion-runner.test-support.ts";
import type {
  CatalogPromotionOperation,
  CatalogPublicationStatusInput,
  CatalogPublicationTransport,
} from "./catalog-promotion-types.ts";
import type {
  CatalogReleaseBaseline,
  CatalogReleasePlanV2,
} from "./catalog-release-types.ts";

const organizationId = "10000000-0000-4000-8000-000000000001";

async function assembledPlan(
  sequence = 20n,
  baseline: CatalogReleaseBaseline | null = null,
): Promise<CatalogReleasePlanV2> {
  const checkpoint = fixtureCheckpoint({ sequence });
  return await new CatalogReleaseAssembler(
    { async getCheckpoint() { return checkpoint; } },
    { async loadSnapshot() { return fixtureSnapshot(); } },
  ).assemble({
    requestedWatermark: sequence,
    baseline,
    trigger: baseline === null ? "full_rebuild" : "settled_change",
  });
}

function baselineFor(plan: CatalogReleasePlanV2): CatalogReleaseBaseline {
  assert.equal(plan.classification, "publish");
  if (plan.classification !== "publish") throw new Error("publish plan required");
  return {
    activePublicReleaseId: plan.publicReleaseId,
    observationSequence: plan.observationSequence,
    contentHash: plan.contentHash,
    publicConfigHash: plan.manifest.metadata.publicConfigHash,
    repackSearchIndexHash: plan.manifest.metadata.repackSearchIndexHash,
    publicVendorKeys: plan.publicVendorKeys,
  };
}

function runner(input: {
  clock: MutableTestClock;
  ledger: MemoryCatalogPromotionLedger;
  transport: CatalogPublicationTransport;
  plan: CatalogReleasePlanV2;
  checkpoint?: { settledSequence: bigint; settledAt: Date | null };
  maximumOperationsPerCycle?: number;
  alerts?: string[];
}) {
  const checkpoint = input.checkpoint ?? {
    settledSequence: input.plan.requestedWatermark,
    settledAt: input.clock.now(),
  };
  return new CatalogPromotionRunner({
    organizationId,
    deploymentKey: "production-us",
    workerId: "worker-1",
    ledger: input.ledger,
    settlement: { async getCheckpoint() { return checkpoint; } },
    assembler: { async assemble() { return input.plan; } },
    transport: input.transport,
    clock: input.clock,
    alerts: {
      async notify(alert) { input.alerts?.push(alert.failureCode); },
    },
    random: { fraction: () => 0 },
    initialRetryMilliseconds: 100,
    maximumRetryMilliseconds: 1_000,
    maximumOperationsPerCycle: input.maximumOperationsPerCycle,
  });
}

async function planForOperationKind(
  kind: CatalogPromotionOperation["kind"],
  clock: MutableTestClock,
): Promise<Readonly<{
  ledger: MemoryCatalogPromotionLedger;
  plan: CatalogReleasePlanV2;
  checkpoint: { settledSequence: bigint; settledAt: Date | null };
}>> {
  const ledger = new MemoryCatalogPromotionLedger();
  if (kind !== "refreshObservation") {
    const plan = await assembledPlan();
    return {
      ledger,
      plan,
      checkpoint: { settledSequence: plan.requestedWatermark, settledAt: clock.now() },
    };
  }
  const first = await assembledPlan(20n);
  ledger.baseline = baselineFor(first);
  const plan = await assembledPlan(21n, ledger.baseline);
  return {
    ledger,
    plan,
    checkpoint: { settledSequence: 21n, settledAt: clock.now() },
  };
}

for (const lostKind of ["start", "applyBatch", "finalize"] as const) {
  test(`lost ${lostKind} acknowledgement is recovered from status after restart`, async () => {
    const clock = new MutableTestClock();
    const ledger = new MemoryCatalogPromotionLedger();
    const transport = new FakeCatalogPublicationTransport();
    transport.loseAfterStore = lostKind;
    const plan = await assembledPlan();
    const first = await runner({ clock, ledger, transport, plan }).runCycle();
    assert.equal(first.outcome, "retry_scheduled");
    clock.advance(1_000);
    const recovered = await runner({ clock, ledger, transport, plan }).runCycle();
    assert.equal(recovered.outcome, "published");
    assert.equal(ledger.terminal.at(-1)?.outcome, "published");
    const reconciledOperationId = transport.statusOperations[0];
    assert.ok(reconciledOperationId);
    assert.equal(transport.sentOperationIds.filter(
      (operationId) => operationId === reconciledOperationId,
    ).length, 1);
    assert.ok(transport.events.includes(`status:${lostKind}`));
  });
}

const ambiguousResponseFailures = [
  ["corrupt body", "PUBLICATION_RESPONSE_INVALID"],
  ["oversized body", "PUBLICATION_RESPONSE_INVALID"],
  ["malformed JSON", "PUBLICATION_RESPONSE_INVALID"],
  ["tampered signature or digest", "PUBLICATION_RESPONSE_AUTH_INVALID"],
] as const;

for (const kind of [
  "start",
  "applyBatch",
  "finalize",
  "refreshObservation",
] as const) {
  for (const [failure, code] of ambiguousResponseFailures) {
    test(`${kind} commit followed by ${failure} recovers through status`, async () => {
      const clock = new MutableTestClock();
      const { ledger, plan, checkpoint } = await planForOperationKind(kind, clock);
      const transport = new FakeCatalogPublicationTransport();
      transport.failResponseAfterStore = { kind, code };
      const input = { clock, ledger, transport, plan, checkpoint };

      const first = await runner(input).runCycle();
      assert.equal(first.outcome, "retry_scheduled");
      assert.deepEqual(ledger.terminal, []);
      clock.advance(1_000);

      const recovered = await runner(input).runCycle();
      assert.equal(
        recovered.outcome,
        kind === "refreshObservation" ? "unchanged" : "published",
      );
      const operationId = transport.statusOperations.at(-1);
      assert.ok(operationId);
      assert.equal(
        transport.sentOperationIds.filter((candidate) => candidate === operationId).length,
        1,
      );
      assert.ok(transport.events.includes(`status:${kind}`));
    });
  }
}

test("status not-found replays the exact persisted body after an ambiguous send", async () => {
  const clock = new MutableTestClock();
  const ledger = new MemoryCatalogPromotionLedger();
  const transport = new FakeCatalogPublicationTransport();
  transport.failBeforeStore = "start";
  const plan = await assembledPlan();
  assert.equal(
    (await runner({ clock, ledger, transport, plan }).runCycle()).outcome,
    "retry_scheduled",
  );
  const firstBody = transport.sentBodies[0];
  clock.advance(1_000);
  assert.equal(
    (await runner({ clock, ledger, transport, plan }).runCycle()).outcome,
    "published",
  );
  assert.equal(transport.sentBodies[1], firstBody);
  assert.deepEqual(transport.events.slice(0, 3), [
    "send:start", "status:start", "send:start",
  ]);
});

test("cancelling a committed send leaves it for status-first restart recovery", async () => {
  const clock = new MutableTestClock();
  const ledger = new MemoryCatalogPromotionLedger();
  const committed = new FakeCatalogPublicationTransport();
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const transport: CatalogPublicationTransport = {
    async send(operation, signal) {
      await committed.send(operation);
      markStarted();
      await new Promise<void>((resolve) => {
        if (signal?.aborted === true) resolve();
        else signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new Error("cancelled after commit");
    },
    status(input: CatalogPublicationStatusInput) {
      return committed.status(input);
    },
  };
  const plan = await assembledPlan();
  const controller = new AbortController();
  const cycle = runner({ clock, ledger, transport, plan }).runCycle(
    controller.signal,
  );

  await started;
  controller.abort();
  const stopped = await cycle;
  assert.equal(stopped.outcome, "stopped");
  assert.equal(ledger.attempt?.operations[0]?.dispatchCount, 1);
  assert.equal(ledger.attempt?.operations[0]?.receipt, null);
  assert.deepEqual(ledger.terminal, []);

  const recovered = await runner({ clock, ledger, transport: committed, plan })
    .runCycle();
  assert.equal(recovered.outcome, "published");
  assert.deepEqual(committed.events.slice(0, 2), ["send:start", "status:start"]);
  assert.equal(
    committed.sentOperationIds.filter((operationId) =>
      operationId === committed.statusOperations[0]).length,
    1,
  );
});

test("close settled changes coalesce only the highest watermark behind one active attempt", async () => {
  const clock = new MutableTestClock();
  const ledger = new MemoryCatalogPromotionLedger();
  const transport = new FakeCatalogPublicationTransport();
  const plan = await assembledPlan();
  const checkpoint = { settledSequence: 20n, settledAt: clock.now() };
  await runner({
    clock, ledger, transport, plan, checkpoint, maximumOperationsPerCycle: 1,
  }).runCycle();
  checkpoint.settledSequence = 21n;
  clock.advance(10);
  await runner({
    clock, ledger, transport, plan, checkpoint, maximumOperationsPerCycle: 1,
  }).runCycle();
  checkpoint.settledSequence = 24n;
  clock.advance(10);
  await runner({
    clock, ledger, transport, plan, checkpoint, maximumOperationsPerCycle: 1,
  }).runCycle();
  assert.equal(ledger.attempt?.requestedWatermark, 20n);
  assert.equal(ledger.pendingWatermark, 24n);
  clock.advance(1);
  assert.equal((await runner({
    clock, ledger, transport, plan, checkpoint,
  }).runCycle()).outcome, "published");
  const newestPlan = await assembledPlan(24n, ledger.baseline);
  assert.equal((await runner({
    clock, ledger, transport, plan: newestPlan, checkpoint,
  }).runCycle()).outcome, "unchanged");
  assert.equal(ledger.baseline?.observationSequence, 24);
});

test("stale operation acknowledgement loses the lease without terminal mutation", async () => {
  const clock = new MutableTestClock();
  const ledger = new MemoryCatalogPromotionLedger();
  ledger.rejectOperationAcknowledgement = true;
  const transport = new FakeCatalogPublicationTransport();
  const outcome = await runner({
    clock, ledger, transport, plan: await assembledPlan(),
  }).runCycle();
  assert.equal(outcome.outcome, "lease_lost");
  assert.deepEqual(ledger.terminal, []);
  assert.equal(ledger.attempt?.operations[0]?.dispatchCount, 1);
});

test("a lower watermark than the durable baseline is terminal before transport", async () => {
  const clock = new MutableTestClock();
  const published = await assembledPlan(20n);
  const ledger = new MemoryCatalogPromotionLedger();
  ledger.baseline = { ...baselineFor(published), observationSequence: 30 };
  const priorBaseline = ledger.baseline;
  ledger.seedAttempt(20n, clock.now());
  const transport = new FakeCatalogPublicationTransport();
  const alerts: string[] = [];
  const outcome = await runner({
    clock, ledger, transport, plan: published, alerts,
  }).runCycle();
  assert.equal(outcome.outcome, "failed");
  assert.equal(outcome.failureCode, "CATALOG_WATERMARK_REGRESSED");
  assert.deepEqual(transport.events, []);
  assert.deepEqual(alerts, ["CATALOG_WATERMARK_REGRESSED"]);
  assert.deepEqual(ledger.baseline, priorBaseline);
});

test("retryable failures use bounded exponential jitter and preserve the attempt", async () => {
  const clock = new MutableTestClock();
  const ledger = new MemoryCatalogPromotionLedger();
  const transport = new FakeCatalogPublicationTransport();
  transport.failBeforeStore = "start";
  transport.failBeforeStoreCount = 2;
  const plan = await assembledPlan();
  await runner({ clock, ledger, transport, plan }).runCycle();
  assert.deepEqual(ledger.retryDelays, [50]);
  clock.advance(50);
  await runner({ clock, ledger, transport, plan }).runCycle();
  assert.deepEqual(ledger.retryDelays, [50, 100]);
  assert.equal(ledger.attempt?.attemptId, "attempt-1");
  assert.equal(ledger.attempt?.retryCount, 2);
  clock.advance(100);
  const recovered = await runner({ clock, ledger, transport, plan }).runCycle();
  assert.equal(recovered.outcome, "published");
  assert.equal(ledger.terminal.at(-1)?.outcome, "published");
});

test("unchanged content sends refresh only and records an unchanged terminal", async () => {
  const clock = new MutableTestClock();
  const first = await assembledPlan(20n);
  const baseline = baselineFor(first);
  const unchanged = await assembledPlan(21n, baseline);
  assert.equal(unchanged.classification, "refresh_unchanged");
  const ledger = new MemoryCatalogPromotionLedger();
  ledger.baseline = baseline;
  const transport = new FakeCatalogPublicationTransport();
  const outcome = await runner({
    clock,
    ledger,
    transport,
    plan: unchanged,
    checkpoint: { settledSequence: 21n, settledAt: clock.now() },
  }).runCycle();
  assert.equal(outcome.outcome, "unchanged");
  assert.deepEqual(transport.events, ["send:refreshObservation"]);
  assert.equal(ledger.terminal.at(-1)?.outcome, "unchanged");
});

test("lost unchanged-refresh acknowledgement reconciles through status after restart", async () => {
  const clock = new MutableTestClock();
  const first = await assembledPlan(20n);
  const baseline = baselineFor(first);
  const unchanged = await assembledPlan(21n, baseline);
  const ledger = new MemoryCatalogPromotionLedger();
  ledger.baseline = baseline;
  const transport = new FakeCatalogPublicationTransport();
  transport.loseAfterStore = "refreshObservation";
  const input = {
    clock,
    ledger,
    transport,
    plan: unchanged,
    checkpoint: { settledSequence: 21n, settledAt: clock.now() },
  };
  assert.equal((await runner(input).runCycle()).outcome, "retry_scheduled");
  clock.advance(1_000);
  assert.equal((await runner(input).runCycle()).outcome, "unchanged");
  assert.deepEqual(transport.events, [
    "send:refreshObservation",
    "status:refreshObservation",
  ]);
});

test("protected publication fields terminate before any external write", async () => {
  const clock = new MutableTestClock();
  const plan = await assembledPlan();
  assert.equal(plan.classification, "publish");
  if (plan.classification !== "publish") return;
  const unsafe = {
    ...plan,
    batches: plan.batches.map((batch, index) => index === 0 ? {
      ...batch,
      records: [{ ...batch.records[0], organizationId }],
    } : batch),
  } as CatalogReleasePlanV2;
  const ledger = new MemoryCatalogPromotionLedger();
  const transport = new FakeCatalogPublicationTransport();
  const alerts: string[] = [];
  const outcome = await runner({
    clock, ledger, transport, plan: unsafe, alerts,
  }).runCycle();
  assert.equal(outcome.outcome, "failed");
  assert.equal(outcome.failureCode, "PUBLICATION_PROTECTED_FIELD");
  assert.deepEqual(transport.events, []);
  assert.deepEqual(alerts, ["PUBLICATION_PROTECTED_FIELD"]);
});

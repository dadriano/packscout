import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CATALOG_FIXTURE_IDS,
  catalogFixtureIdentity,
} from "./global-catalog-canonical-fixtures.ts";
import {
  correlationRequestDigest,
  normalizeCorrelationRequest,
  provisionalCollectibleId,
} from "./global-catalog-contract.ts";
import {
  assertProviderChangeWindow,
  classifyProviderSourceVersion,
  PrismaProviderCorrelationChangeSource,
  ProviderCorrelationProcessor,
  providerPromotionRetentionBoundary,
  type ProviderConsumerPositions,
  type ProviderCorrelationChangeBatch,
  type ProviderCorrelationChangeSource,
  type ProviderCorrelationCheckpointPort,
  type ProviderCorrelationLease,
} from "./provider-correlation-source.ts";

function sourceCollectibleRow(version: bigint, displayName: string) {
  return {
    id: CATALOG_FIXTURE_IDS.unmatchedLocalCollectible,
    row_version: version,
    lifecycle: "active" as const,
    collectible_type: "card" as const,
    display_name: displayName,
    normalized_name: displayName.toLowerCase(),
    year: 2026,
    brand: null,
    set_or_series: null,
    card_number: null,
    reference_number: null,
    subject: null,
    grade: null,
    grader: null,
    primary_image_url: null,
    primary_image_alt: null,
    valuation_amount: null,
    valuation_currency: null,
    valuation_usd_amount: null,
    valuation_unavailable_reason: "VALUATION_UNAVAILABLE",
    valuation_type: null,
    valuation_observed_at: null,
    data_as_of: new Date("2026-08-29T20:00:00.000Z"),
  };
}

function sourceChanges(through: number) {
  return Array.from({ length: through }, (_, index) => ({
    sequence: BigInt(index + 1),
    entity_type: "collectible",
    entity_id: CATALOG_FIXTURE_IDS.unmatchedLocalCollectible,
    entity_version: BigInt(index + 1),
    operation: "upsert",
  }));
}

function sourceClient(state: {
  head: bigint;
  row: ReturnType<typeof sourceCollectibleRow>;
  changes: ReturnType<typeof sourceChanges>;
}, onChangesRead?: () => void) {
  return {
    async $transaction<Result>(
      callback: (snapshot: {
        database_identity: { findUnique(): Promise<unknown> };
        promotion_ledger: { findUnique(): Promise<unknown> };
        promotion_changes: { findMany(input: { where: { sequence: { gt: bigint } }; take: number }): Promise<unknown[]> };
        collectibles: { findMany(): Promise<unknown[]> };
        categories: { findMany(): Promise<unknown[]> };
      }) => Promise<Result>,
      options: { isolationLevel: string },
    ): Promise<Result> {
      assert.equal(options.isolationLevel, "RepeatableRead");
      const captured = {
        head: state.head,
        row: { ...state.row },
        changes: state.changes.map((change) => ({ ...change })),
      };
      return callback({
        database_identity: {
          async findUnique() {
            return {
              database_role: "provider",
              provider_id: CATALOG_FIXTURE_IDS.provider,
            };
          },
        },
        promotion_ledger: {
          async findUnique() { return { last_sequence: captured.head }; },
        },
        promotion_changes: {
          async findMany(input) {
            onChangesRead?.();
            return captured.changes
              .filter((change) => change.sequence > input.where.sequence.gt)
              .slice(0, input.take);
          },
        },
        collectibles: {
          async findMany() { return [{ ...captured.row }]; },
        },
        categories: { async findMany() { return []; } },
      });
    },
  };
}

class MemorySource implements ProviderCorrelationChangeSource {
  constructor(private readonly batch: ProviderCorrelationChangeBatch) {}

  async readAfter(input: { afterSequence: bigint; limit: number }) {
    return {
      ...this.batch,
      records: this.batch.records
        .filter((record) => record.sequence > input.afterSequence)
        .slice(0, input.limit),
    };
  }
}

class MemoryCheckpoint implements ProviderCorrelationCheckpointPort {
  readonly confirmations: bigint[] = [];
  readonly confirmationKinds: string[] = [];
  acquireCalls = 0;
  renewalCalls = 0;
  lease: ProviderCorrelationLease | null = null;

  constructor(
    public positions: ProviderConsumerPositions,
    private readonly failRenewalAt: number | null = null,
    private failConfirmationOnce = false,
  ) {}

  async acquireCatalogCorrelationLease(input: { leaseOwner: string; ttlMs: number }) {
    this.acquireCalls += 1;
    if (this.lease !== null) return null;
    this.lease = {
      leaseOwner: input.leaseOwner,
      leaseFence: BigInt(this.acquireCalls),
      leaseExpiresAt: new Date(Date.now() + input.ttlMs),
    };
    return this.lease;
  }

  async renewCatalogCorrelationLease(input: {
    lease: ProviderCorrelationLease;
    ttlMs: number;
  }) {
    this.renewalCalls += 1;
    if (this.failRenewalAt === this.renewalCalls
        || this.lease?.leaseOwner !== input.lease.leaseOwner
        || this.lease.leaseFence !== input.lease.leaseFence) {
      return null;
    }
    this.lease = {
      ...input.lease,
      leaseExpiresAt: new Date(Date.now() + input.ttlMs),
    };
    return this.lease;
  }

  async releaseCatalogCorrelationLease(released: ProviderCorrelationLease) {
    if (this.lease?.leaseOwner === released.leaseOwner
        && this.lease.leaseFence === released.leaseFence) {
      this.lease = null;
    }
  }

  async readConsumerPositions() {
    return this.positions;
  }

  async confirmCatalogCorrelation(input: {
    lease: { leaseOwner: string; leaseFence: bigint; leaseExpiresAt: Date };
    expectedPreviousSequence: bigint;
    confirmedSequence: bigint;
    confirmationKind:
      | "catalog_decision_event"
      | "local_change_ignored"
      | "local_change_superseded";
    confirmationId: string;
  }): Promise<"confirmed" | "conflict"> {
    assert.match(input.confirmationKind, /^(?:catalog_decision_event|local_change_ignored|local_change_superseded)$/);
    assert.match(input.confirmationId, /^(?:catalog-correlation:skip|catalog-event):/);
    if (this.failConfirmationOnce) {
      this.failConfirmationOnce = false;
      return "conflict";
    }
    if (this.lease?.leaseOwner !== input.lease.leaseOwner
        || this.lease.leaseFence !== input.lease.leaseFence
        || input.expectedPreviousSequence !== this.positions.catalogCorrelation) {
      return "conflict";
    }
    this.positions = {
      catalogCorrelation: input.confirmedSequence,
      providerRelease: this.positions.providerRelease,
    };
    this.confirmations.push(input.confirmedSequence);
    this.confirmationKinds.push(input.confirmationKind);
    return "confirmed";
  }
}

function collectible(
  sequence: bigint,
  providerId: string = CATALOG_FIXTURE_IDS.provider,
) {
  return {
    kind: "collectible" as const,
    sequence,
    providerId,
    localCollectibleId: CATALOG_FIXTURE_IDS.unmatchedLocalCollectible,
    localEntityVersion: 1n,
    sourceEntityVersion: 1n,
    collectibleType: "card" as const,
    publicIdentity: catalogFixtureIdentity("Checkpoint Fixture"),
  };
}

test("provider commits remain pending during central outage and resume from the last confirmation", async () => {
  const source = new MemorySource({
    providerId: CATALOG_FIXTURE_IDS.provider,
    headSequence: 3n,
    records: [
      {
        kind: "ignored",
        sequence: 1n,
        providerId: CATALOG_FIXTURE_IDS.provider,
        safeReason: "not_correlatable",
      },
      collectible(2n),
      {
        kind: "ignored",
        sequence: 3n,
        providerId: CATALOG_FIXTURE_IDS.provider,
        safeReason: "not_correlatable",
      },
    ],
  });
  const checkpoint = new MemoryCheckpoint({ catalogCorrelation: 0n, providerRelease: 0n });
  let centralAvailable = false;
  const processor = new ProviderCorrelationProcessor({
    source,
    checkpoint,
    collectibleEvidence: { async resolve() { return []; } },
    collectibleRuleVersion: "worker-v1",
    leaseOwner: "worker-a:provider-one",
    collectibleCorrelator: {
      async correlateCollectible(input) {
        if (!centralAvailable) throw new Error("central unavailable");
        return {
          outcome: "provisional_created",
          currentGlobalCollectibleId: provisionalCollectibleId(input),
          confirmedProviderSequence: input.providerChangeSequence,
          catalogEventSequence: 11n,
        };
      },
    },
  });
  const outage = await processor.runBatch();
  assert.equal(outage.failureCode, "CENTRAL_UNAVAILABLE");
  assert.equal(outage.lastConfirmedSequence, 1n);
  assert.deepEqual(checkpoint.positions, { catalogCorrelation: 1n, providerRelease: 0n });

  centralAvailable = true;
  const recovery = await processor.runBatch();
  assert.equal(recovery.failureCode, null);
  assert.equal(recovery.lastConfirmedSequence, 3n);
  assert.deepEqual(checkpoint.confirmations, [1n, 2n, 3n]);
  assert.equal(checkpoint.positions.providerRelease, 0n);
});

test("a rejected correlation never advances its checkpoint past the failed record", async () => {
  const checkpoint = new MemoryCheckpoint({ catalogCorrelation: 0n, providerRelease: 9n });
  const processor = new ProviderCorrelationProcessor({
    source: new MemorySource({
      providerId: CATALOG_FIXTURE_IDS.provider,
      headSequence: 2n,
      records: [collectible(1n), collectible(2n)],
    }),
    checkpoint,
    collectibleEvidence: { async resolve() { return []; } },
    collectibleRuleVersion: "worker-v1",
    leaseOwner: "worker-a:provider-one",
    collectibleCorrelator: {
      async correlateCollectible() {
        return {
          outcome: "rejected",
          currentGlobalCollectibleId: null,
          confirmedProviderSequence: null,
          catalogEventSequence: 15n,
          failureCode: "GLOBAL_TARGET_NOT_FOUND",
        };
      },
    },
  });
  const result = await processor.runBatch();
  assert.equal(result.failureCode, "COLLECTIBLE_CORRELATION_REJECTED");
  assert.equal(result.lastConfirmedSequence, 0n);
  assert.deepEqual(checkpoint.confirmations, []);
  assert.equal(checkpoint.positions.providerRelease, 9n);
});

test("category changes use their own deterministic target boundary before confirmation", async () => {
  const checkpoint = new MemoryCheckpoint({ catalogCorrelation: 0n, providerRelease: 0n });
  let categoryRequestProvider = "";
  const processor = new ProviderCorrelationProcessor({
    source: new MemorySource({
      providerId: CATALOG_FIXTURE_IDS.provider,
      headSequence: 1n,
      records: [{
        kind: "category",
        sequence: 1n,
        providerId: CATALOG_FIXTURE_IDS.provider,
        localCategoryId: "60000000-0000-4000-8000-000000000001",
        localEntityVersion: 1n,
        sourceEntityVersion: 1n,
        categoryKey: "cards",
        displayName: "Cards",
        parentLocalCategoryId: null,
      }],
    }),
    checkpoint,
    collectibleEvidence: { async resolve() { return []; } },
    collectibleRuleVersion: "worker-v1",
    leaseOwner: "worker-a:provider-one",
    collectibleCorrelator: { async correlateCollectible() { throw new Error("unexpected"); } },
    categoryTarget: {
      async resolve() {
        return {
          globalCategoryId: "70000000-0000-4000-8000-000000000001",
          confidenceBasisPoints: 10_000,
          ruleVersion: "category-v1",
        };
      },
    },
    categoryCorrelator: {
      async correlateCategory(input) {
        categoryRequestProvider = input.providerId;
        return {
          outcome: "linked",
          currentGlobalCategoryId: input.globalCategoryId,
          confirmedProviderSequence: input.providerChangeSequence,
          catalogEventSequence: 20n,
        };
      },
    },
  });
  const result = await processor.runBatch();
  assert.equal(result.failureCode, null);
  assert.equal(categoryRequestProvider, CATALOG_FIXTURE_IDS.provider);
  assert.equal(checkpoint.positions.catalogCorrelation, 1n);
});

test("property: retention keeps work pending for both independent consumers", () => {
  for (let correlation = 0n; correlation < 50n; correlation += 1n) {
    for (let release = 0n; release < 50n; release += 7n) {
      const boundary = providerPromotionRetentionBoundary({
        catalogCorrelation: correlation,
        providerRelease: release,
      });
      assert.equal(boundary, correlation < release ? correlation : release);
      assert.ok(boundary <= correlation);
      assert.ok(boundary <= release);
    }
  }
});

test("an empty or noncontiguous batch below a higher ledger head is a provider gap", () => {
  assert.throws(() => assertProviderChangeWindow({
    afterSequence: 4n,
    headSequence: 5n,
    returnedSequences: [],
  }), /PROVIDER_CHANGE_GAP/);
  assert.throws(() => assertProviderChangeWindow({
    afterSequence: 8n,
    headSequence: 7n,
    returnedSequences: [],
  }), /PROVIDER_CHANGE_GAP/);
  assert.throws(() => assertProviderChangeWindow({
    afterSequence: 4n,
    headSequence: 5n,
    returnedSequences: [5n, 6n],
  }), /PROVIDER_CHANGE_GAP/);
  assert.throws(() => assertProviderChangeWindow({
    afterSequence: 4n,
    headSequence: 7n,
    returnedSequences: [5n, 7n],
  }), /PROVIDER_CHANGE_GAP/);
  assert.doesNotThrow(() => assertProviderChangeWindow({
    afterSequence: 4n,
    headSequence: 7n,
    returnedSequences: [5n, 6n, 7n],
  }));
});

test("two providers with the same local ID remain isolated by source identity", async () => {
  const captured: string[] = [];
  for (const providerId of [
    CATALOG_FIXTURE_IDS.provider,
    CATALOG_FIXTURE_IDS.secondProvider,
  ]) {
    const checkpoint = new MemoryCheckpoint({ catalogCorrelation: 0n, providerRelease: 0n });
    const processor = new ProviderCorrelationProcessor({
      source: new MemorySource({
        providerId,
        headSequence: 1n,
        records: [collectible(1n, providerId)],
      }),
      checkpoint,
      collectibleEvidence: { async resolve() { return []; } },
      collectibleRuleVersion: "worker-v1",
      leaseOwner: `worker-a:${providerId}`,
      collectibleCorrelator: {
        async correlateCollectible(input) {
          captured.push(provisionalCollectibleId(input));
          return {
            outcome: "provisional_created",
            currentGlobalCollectibleId: provisionalCollectibleId(input),
            confirmedProviderSequence: input.providerChangeSequence,
            catalogEventSequence: 1n,
          };
        },
      },
    });
    assert.equal((await processor.runBatch()).failureCode, null);
  }
  assert.equal(captured.length, 2);
  assert.notEqual(captured[0], captured[1]);
});

test("provider source versions classify backlog as superseded and reject impossible gaps", () => {
  assert.equal(classifyProviderSourceVersion(3n, 3n), "exact");
  assert.equal(classifyProviderSourceVersion(1n, 3n), "superseded");
  assert.throws(() => classifyProviderSourceVersion(3n, 2n), /PROVIDER_CHANGE_GAP/);
  assert.throws(() => classifyProviderSourceVersion(3n, null), /PROVIDER_CHANGE_GAP/);
});

test("superseded source versions advance only with the explicit superseded confirmation kind", async () => {
  const checkpoint = new MemoryCheckpoint({ catalogCorrelation: 0n, providerRelease: 0n });
  const processor = new ProviderCorrelationProcessor({
    source: new MemorySource({
      providerId: CATALOG_FIXTURE_IDS.provider,
      headSequence: 1n,
      records: [{
        kind: "superseded",
        sequence: 1n,
        providerId: CATALOG_FIXTURE_IDS.provider,
        sourceEntityVersion: 1n,
        currentEntityVersion: 3n,
        safeReason: "local_entity_advanced",
      }],
    }),
    checkpoint,
    collectibleEvidence: { async resolve() { return []; } },
    collectibleRuleVersion: "worker-v1",
    collectibleCorrelator: { async correlateCollectible() { throw new Error("unexpected"); } },
    leaseOwner: "worker-superseded:provider-one",
  });
  assert.equal((await processor.runBatch()).failureCode, null);
  assert.deepEqual(checkpoint.confirmationKinds, ["local_change_superseded"]);
});

test("v1-to-v3 backlog marks older promotions superseded and emits only the exact v3 row", async () => {
  const state = {
    head: 3n,
    row: sourceCollectibleRow(3n, "Version Three"),
    changes: sourceChanges(3),
  };
  const source = new PrismaProviderCorrelationChangeSource(
    sourceClient(state) as never,
    CATALOG_FIXTURE_IDS.provider,
  );
  const batch = await source.readAfter({ afterSequence: 0n, limit: 3 });
  assert.deepEqual(batch.records.map((record) => record.kind), [
    "superseded",
    "superseded",
    "collectible",
  ]);
  assert.equal(batch.records[2]?.sequence, 3n);
  assert.equal(batch.records[2]?.kind === "collectible"
    ? batch.records[2].publicIdentity.displayName
    : null, "Version Three");
});

test("a concurrent v1-to-v3 mutation cannot leak future row state into the v1 snapshot", async () => {
  const state = {
    head: 1n,
    row: sourceCollectibleRow(1n, "Version One"),
    changes: sourceChanges(1),
  };
  let advanced = false;
  const client = sourceClient(state, () => {
    if (advanced) return;
    advanced = true;
    state.head = 3n;
    state.row = sourceCollectibleRow(3n, "Version Three");
    state.changes = sourceChanges(3);
  });
  const source = new PrismaProviderCorrelationChangeSource(
    client as never,
    CATALOG_FIXTURE_IDS.provider,
  );
  const first = await source.readAfter({ afterSequence: 0n, limit: 3 });
  assert.equal(first.headSequence, 1n);
  assert.equal(first.records[0]?.kind, "collectible");
  assert.equal(first.records[0]?.kind === "collectible"
    ? first.records[0].publicIdentity.displayName
    : null, "Version One");
  const later = await source.readAfter({ afterSequence: 1n, limit: 3 });
  assert.deepEqual(later.records.map((record) => record.kind), [
    "superseded",
    "collectible",
  ]);
  assert.equal(later.records[1]?.kind === "collectible"
    ? later.records[1].publicIdentity.displayName
    : null, "Version Three");
});

test("one processor coalesces same-owner duplicate runs into one leased flight", async () => {
  const checkpoint = new MemoryCheckpoint({ catalogCorrelation: 0n, providerRelease: 0n });
  const processor = new ProviderCorrelationProcessor({
    source: new MemorySource({
      providerId: CATALOG_FIXTURE_IDS.provider,
      headSequence: 1n,
      records: [{
        kind: "ignored",
        sequence: 1n,
        providerId: CATALOG_FIXTURE_IDS.provider,
        safeReason: "not_correlatable",
      }],
    }),
    checkpoint,
    collectibleEvidence: { async resolve() { return []; } },
    collectibleRuleVersion: "worker-v1",
    collectibleCorrelator: { async correlateCollectible() { throw new Error("unexpected"); } },
    leaseOwner: "worker-single-flight:provider-one",
  });
  const first = processor.runBatch();
  const duplicate = processor.runBatch();
  assert.equal(first, duplicate);
  await first;
  assert.equal(checkpoint.acquireCalls, 1);
});

test("processor rejects an unscoped or shared-empty lease owner before acquisition", async () => {
  const checkpoint = new MemoryCheckpoint({ catalogCorrelation: 0n, providerRelease: 0n });
  const processor = new ProviderCorrelationProcessor({
    source: new MemorySource({
      providerId: CATALOG_FIXTURE_IDS.provider,
      headSequence: 0n,
      records: [],
    }),
    checkpoint,
    collectibleEvidence: { async resolve() { return []; } },
    collectibleRuleVersion: "worker-v1",
    collectibleCorrelator: { async correlateCollectible() { throw new Error("unexpected"); } },
    leaseOwner: "",
  });
  await assert.rejects(processor.runBatch(), /unique scoped correlation lease owner/);
  assert.equal(checkpoint.acquireCalls, 0);
});

test("distinct processor owners contend for the same provider lease", async () => {
  const checkpoint = new MemoryCheckpoint({ catalogCorrelation: 0n, providerRelease: 0n });
  let unblock!: () => void;
  let markStarted!: () => void;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const source = new MemorySource({
    providerId: CATALOG_FIXTURE_IDS.provider,
    headSequence: 1n,
    records: [collectible(1n)],
  });
  const common = {
    source,
    checkpoint,
    collectibleEvidence: { async resolve() { return []; } },
    collectibleRuleVersion: "worker-v1",
    collectibleCorrelator: {
      async correlateCollectible() {
        markStarted();
        await blocked;
        return {
          outcome: "linked" as const,
          currentGlobalCollectibleId: CATALOG_FIXTURE_IDS.firstCanonicalCollectible,
          confirmedProviderSequence: 1n,
          catalogEventSequence: 8n,
        };
      },
    },
  };
  const first = new ProviderCorrelationProcessor({
    ...common,
    leaseOwner: "worker-one:provider-one",
  });
  const contender = new ProviderCorrelationProcessor({
    ...common,
    leaseOwner: "worker-two:provider-one",
  });
  const firstRun = first.runBatch();
  await started;
  const contention = await contender.runBatch();
  assert.equal(contention.failureCode, "CHECKPOINT_LEASE_UNAVAILABLE");
  unblock();
  assert.equal((await firstRun).failureCode, null);
});

test("lease expiry during a batch stops before the next checkpoint advance", async () => {
  const checkpoint = new MemoryCheckpoint(
    { catalogCorrelation: 0n, providerRelease: 0n },
    3,
  );
  const processor = new ProviderCorrelationProcessor({
    source: new MemorySource({
      providerId: CATALOG_FIXTURE_IDS.provider,
      headSequence: 2n,
      records: [
        { kind: "ignored", sequence: 1n, providerId: CATALOG_FIXTURE_IDS.provider, safeReason: "not_correlatable" },
        { kind: "ignored", sequence: 2n, providerId: CATALOG_FIXTURE_IDS.provider, safeReason: "not_correlatable" },
      ],
    }),
    checkpoint,
    collectibleEvidence: { async resolve() { return []; } },
    collectibleRuleVersion: "worker-v1",
    collectibleCorrelator: { async correlateCollectible() { throw new Error("unexpected"); } },
    leaseOwner: "worker-expiring:provider-one",
  });
  const result = await processor.runBatch();
  assert.equal(result.failureCode, "CHECKPOINT_LEASE_UNAVAILABLE");
  assert.equal(result.lastConfirmedSequence, 1n);
  assert.deepEqual(checkpoint.confirmations, [1n]);
});

test("a committed central decision replays exactly after checkpoint confirmation fails", async () => {
  const checkpoint = new MemoryCheckpoint(
    { catalogCorrelation: 0n, providerRelease: 0n },
    null,
    true,
  );
  const observedTimes = [
    new Date("2026-08-29T20:00:00.000Z"),
    new Date("2026-08-30T20:00:00.000Z"),
  ];
  let nowIndex = 0;
  const decisions = new Map<string, { globalId: string; eventSequence: bigint }>();
  let centralMutationCount = 0;
  const processor = new ProviderCorrelationProcessor({
    source: new MemorySource({
      providerId: CATALOG_FIXTURE_IDS.provider,
      headSequence: 1n,
      records: [collectible(1n)],
    }),
    checkpoint,
    collectibleEvidence: { async resolve() { return []; } },
    collectibleRuleVersion: "worker-v1",
    collectibleCorrelator: {
      async correlateCollectible(input) {
        const digest = correlationRequestDigest(normalizeCorrelationRequest(input));
        const existing = decisions.get(digest);
        if (existing) {
          return {
            outcome: "unchanged",
            currentGlobalCollectibleId: existing.globalId,
            confirmedProviderSequence: input.providerChangeSequence,
            catalogEventSequence: existing.eventSequence,
          };
        }
        centralMutationCount += 1;
        const value = {
          globalId: provisionalCollectibleId(input),
          eventSequence: 91n,
        };
        decisions.set(digest, value);
        return {
          outcome: "provisional_created",
          currentGlobalCollectibleId: value.globalId,
          confirmedProviderSequence: input.providerChangeSequence,
          catalogEventSequence: value.eventSequence,
        };
      },
    },
    leaseOwner: "worker-replay:provider-one",
    now: () => observedTimes[nowIndex++]!,
  });
  const first = await processor.runBatch();
  assert.equal(first.failureCode, "CHECKPOINT_CONFLICT");
  assert.equal(first.lastConfirmedSequence, 0n);
  const retry = await processor.runBatch();
  assert.equal(retry.failureCode, null);
  assert.equal(retry.lastConfirmedSequence, 1n);
  assert.equal(centralMutationCount, 1);
  assert.deepEqual(checkpoint.confirmations, [1n]);
  assert.equal(decisions.size, 1);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_APPROVED_PUBLIC_PLATFORMS,
  ManifestEligibilityService,
  ProviderCatalogSettlementError,
  ProviderCatalogSettlementService,
  sameSharedPublicConfigurationEpoch,
  type ManifestEligibilityReadPort,
  type ProviderCatalogCheckpointReadPort,
  type SharedPublicConfigurationEpoch,
} from "./provider-catalog-settlement-service.ts";

const organizationId = "70000000-0000-4000-8000-00000000000a";
const settledAt = new Date("2026-08-16T08:00:00.000Z");
const sourceHeadAt = new Date("2026-08-16T08:01:00.000Z");

function epoch(input: {
  revision?: number;
  sequence?: bigint;
  hashCharacter?: string;
} = {}): SharedPublicConfigurationEpoch {
  return {
    configurationKey: "catalog-public-v1",
    revision: input.revision ?? 3,
    publicChangeSequence: input.sequence ?? 5n,
    configurationHash: (input.hashCharacter ?? "a").repeat(64),
  };
}

function readyCheckpoint(platformKey: string, input: {
  configurationEpoch?: SharedPublicConfigurationEpoch;
  sequence?: bigint;
} = {}) {
  const sequence = input.sequence ?? 10n;
  return {
    organizationId,
    platformKey,
    sharedConfigurationEpoch: input.configurationEpoch ?? epoch(),
    settledSequence: sequence,
    sourceHeadSequence: sequence,
    settledAt,
    sourceHeadAt,
    blockedState: { kind: "ready" as const },
  };
}

function blockedCheckpoint(
  platformKey: string,
  reason: "pending_derivation" | "technical_failure",
  input: { configurationEpoch?: SharedPublicConfigurationEpoch } = {},
) {
  return {
    organizationId,
    platformKey,
    sharedConfigurationEpoch: input.configurationEpoch ?? epoch(),
    settledSequence: 10n,
    sourceHeadSequence: 12n,
    settledAt,
    sourceHeadAt,
    blockedState: {
      kind: "blocked" as const,
      reason,
      causeSequence: 11n,
    },
  };
}

function firstCauseBlockedCheckpoint(platformKey: string) {
  return {
    organizationId,
    platformKey,
    sharedConfigurationEpoch: epoch({ sequence: 1n }),
    settledSequence: 0n,
    sourceHeadSequence: 1n,
    settledAt: null,
    sourceHeadAt,
    blockedState: {
      kind: "blocked" as const,
      reason: "pending_derivation" as const,
      causeSequence: 1n,
    },
  };
}

async function assertCode(
  action: () => Promise<unknown>,
  code: ProviderCatalogSettlementError["code"],
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof ProviderCatalogSettlementError);
    assert.equal(error.code, code);
    assert.equal(
      error.message,
      "Provider catalog settlement state is unavailable or invalid.",
    );
    return true;
  });
}

test("provider checkpoint lookup is bound to one server-owned organization and platform", async () => {
  const calls: unknown[] = [];
  const repository: ProviderCatalogCheckpointReadPort = {
    async loadProviderCatalogCheckpoint(input) {
      calls.push(input);
      return readyCheckpoint("alpha");
    },
  };
  const service = new ProviderCatalogSettlementService(repository, {
    organizationId: organizationId.toUpperCase(),
    platformKey: "alpha",
  });

  const checkpoint = await service.getCheckpoint();

  assert.deepEqual(calls, [{ organizationId, platformKey: "alpha" }]);
  assert.equal(checkpoint.organizationId, organizationId);
  assert.equal(checkpoint.platformKey, "alpha");
  assert.deepEqual(checkpoint.blockedState, { kind: "ready" });
  assert.notEqual(checkpoint.settledAt, settledAt);
  assert.notEqual(checkpoint.sourceHeadAt, sourceHeadAt);
  assert.ok(Object.isFrozen(checkpoint));
  assert.ok(Object.isFrozen(checkpoint.sharedConfigurationEpoch));
});

test("provider checkpoint exposes only a bounded causal blocked state", async () => {
  for (const reason of ["pending_derivation", "technical_failure"] as const) {
    const service = new ProviderCatalogSettlementService({
      async loadProviderCatalogCheckpoint() {
        return blockedCheckpoint("beta", reason);
      },
    }, { organizationId, platformKey: "beta" });

    const checkpoint = await service.getCheckpoint();

    assert.deepEqual(checkpoint.blockedState, {
      kind: "blocked",
      reason,
      causeSequence: 11n,
    });
    assert.equal("providerId" in checkpoint, false);
  }

  const epochBlockedService = new ProviderCatalogSettlementService({
    async loadProviderCatalogCheckpoint() {
      return {
        ...blockedCheckpoint("beta", "pending_derivation"),
        sharedConfigurationEpoch: epoch({ sequence: 12n }),
      };
    },
  }, { organizationId, platformKey: "beta" });
  const epochBlockedCheckpoint = await epochBlockedService.getCheckpoint();
  assert.equal(epochBlockedCheckpoint.settledSequence, 10n);
  assert.equal(
    epochBlockedCheckpoint.sharedConfigurationEpoch.publicChangeSequence,
    epochBlockedCheckpoint.sourceHeadSequence,
  );

  const firstCauseService = new ProviderCatalogSettlementService({
    async loadProviderCatalogCheckpoint() {
      return firstCauseBlockedCheckpoint("beta");
    },
  }, { organizationId, platformKey: "beta" });
  const firstCause = await firstCauseService.getCheckpoint();
  assert.equal(firstCause.settledSequence, 0n);
  assert.equal(firstCause.settledAt, null);
});

test("provider checkpoint rejects missing, cross-scope, protected, and inconsistent results", async () => {
  const invalid = [
    null,
    { ...readyCheckpoint("alpha"), organizationId: "80000000-0000-4000-8000-000000000001" },
    { ...readyCheckpoint("beta") },
    { ...readyCheckpoint("alpha"), providerId: "90000000-0000-4000-8000-000000000001" },
    { ...readyCheckpoint("alpha"), sourceHeadSequence: 11n },
    { ...readyCheckpoint("alpha"), settledAt: null },
    { ...firstCauseBlockedCheckpoint("alpha"), settledAt },
    {
      ...blockedCheckpoint("alpha", "technical_failure"),
      blockedState: {
        kind: "blocked",
        reason: "technical_failure",
        causeSequence: 10n,
      },
    },
    {
      ...readyCheckpoint("alpha"),
      sharedConfigurationEpoch: epoch({ sequence: 11n }),
    },
  ];
  for (const candidate of invalid) {
    const service = new ProviderCatalogSettlementService({
      async loadProviderCatalogCheckpoint() { return candidate; },
    }, { organizationId, platformKey: "alpha" });
    await assertCode(
      () => service.getCheckpoint(),
      candidate === null
        ? "PROVIDER_CATALOG_CHECKPOINT_UNAVAILABLE"
        : "PROVIDER_CATALOG_CHECKPOINT_INVALID",
    );
  }
});

test("provider binding rejects caller-shaped tenant and platform values before repository access", async () => {
  let calls = 0;
  const repository: ProviderCatalogCheckpointReadPort = {
    async loadProviderCatalogCheckpoint() {
      calls += 1;
      return readyCheckpoint("alpha");
    },
  };
  for (const configuration of [
    { organizationId: "not-a-tenant", platformKey: "alpha" },
    { organizationId, platformKey: " Alpha " },
    { organizationId, platformKey: "alpha/other" },
  ]) {
    assert.throws(
      () => new ProviderCatalogSettlementService(repository, configuration),
      (error: unknown) =>
        error instanceof ProviderCatalogSettlementError &&
        error.code === "PROVIDER_CATALOG_CONFIGURATION_INVALID",
    );
  }
  assert.equal(calls, 0);
});

test("manifest eligibility returns one atomic same-epoch enabled-platform snapshot", async () => {
  const currentEpoch = epoch();
  const calls: unknown[] = [];
  const repository: ManifestEligibilityReadPort = {
    async loadManifestEligibilitySnapshot(input) {
      calls.push(input);
      return {
        organizationId,
        sharedConfigurationEpoch: currentEpoch,
        enabledPlatformKeys: ["alpha", "beta"],
        lifecycleDecisionSequence: 99n,
        checkpoints: [
          readyCheckpoint("alpha"),
          blockedCheckpoint("beta", "technical_failure"),
        ],
      };
    },
  };
  const service = new ManifestEligibilityService(repository, {
    organizationId: organizationId.toUpperCase(),
  });

  const snapshot = await service.getSnapshot();

  assert.deepEqual(calls, [{ organizationId }]);
  assert.deepEqual(snapshot.enabledPlatformKeys, ["alpha", "beta"]);
  assert.equal(snapshot.lifecycleDecisionSequence, 99n);
  assert.ok(
    snapshot.lifecycleDecisionSequence >
      snapshot.checkpoints[0]!.sourceHeadSequence,
  );
  assert.deepEqual(
    snapshot.checkpoints.map(({ platformKey }) => platformKey),
    snapshot.enabledPlatformKeys,
  );
  assert.equal(
    sameSharedPublicConfigurationEpoch(
      snapshot.sharedConfigurationEpoch,
      snapshot.checkpoints[0]!.sharedConfigurationEpoch,
    ),
    true,
  );
  assert.equal(
    sameSharedPublicConfigurationEpoch(
      snapshot.sharedConfigurationEpoch,
      snapshot.checkpoints[1]!.sharedConfigurationEpoch,
    ),
    true,
  );
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.enabledPlatformKeys));
  assert.ok(Object.isFrozen(snapshot.checkpoints));
});

test("manifest eligibility accepts eight enabled platforms and rejects a ninth with a stable code", async () => {
  const eight = Array.from(
    { length: MAX_APPROVED_PUBLIC_PLATFORMS },
    (_, index) => `platform_${index + 1}`,
  );
  const repository = (platformKeys: readonly string[]): ManifestEligibilityReadPort => ({
    async loadManifestEligibilitySnapshot() {
      return {
        organizationId,
        sharedConfigurationEpoch: epoch(),
        enabledPlatformKeys: platformKeys,
        lifecycleDecisionSequence: 9n,
        checkpoints: platformKeys.map((platformKey) =>
          readyCheckpoint(platformKey)),
      };
    },
  });

  const valid = await new ManifestEligibilityService(repository(eight), {
    organizationId,
  }).getSnapshot();
  assert.equal(valid.enabledPlatformKeys.length, 8);

  await assertCode(
    () => new ManifestEligibilityService(repository([
      ...eight,
      "platform_9",
    ]), { organizationId }).getSnapshot(),
    "MANIFEST_ENABLED_PLATFORM_LIMIT_EXCEEDED",
  );
});

test("manifest eligibility rejects missing, unsorted, mismatched, and protected results", async () => {
  const base = {
    organizationId,
    sharedConfigurationEpoch: epoch(),
    enabledPlatformKeys: ["alpha", "beta"],
    lifecycleDecisionSequence: 8n,
    checkpoints: [readyCheckpoint("alpha"), readyCheckpoint("beta")],
  };
  const invalid = [
    null,
    { ...base, enabledPlatformKeys: ["beta", "alpha"] },
    { ...base, checkpoints: [readyCheckpoint("beta"), readyCheckpoint("alpha")] },
    { ...base, enabledPlatformKeys: ["alpha"] },
    { ...base, providerId: "90000000-0000-4000-8000-000000000001" },
    { ...base, lifecycleDecisionSequence: -1n },
    { ...base, lifecycleDecisionSequence: 4n },
  ];
  for (const candidate of invalid) {
    const service = new ManifestEligibilityService({
      async loadManifestEligibilitySnapshot() { return candidate; },
    }, { organizationId });
    await assertCode(
      () => service.getSnapshot(),
      candidate === null
        ? "MANIFEST_ELIGIBILITY_UNAVAILABLE"
        : "MANIFEST_ELIGIBILITY_INVALID",
    );
  }
});

test("manifest eligibility rejects checkpoints from a mixed configuration epoch", async () => {
  const service = new ManifestEligibilityService({
    async loadManifestEligibilitySnapshot() {
      return {
        organizationId,
        sharedConfigurationEpoch: epoch(),
        enabledPlatformKeys: ["alpha", "beta"],
        lifecycleDecisionSequence: 8n,
        checkpoints: [
          readyCheckpoint("alpha"),
          readyCheckpoint("beta", {
            configurationEpoch: epoch({
              revision: 2,
              sequence: 2n,
              hashCharacter: "b",
            }),
          }),
        ],
      };
    },
  }, { organizationId });

  await assertCode(
    () => service.getSnapshot(),
    "MANIFEST_ELIGIBILITY_INVALID",
  );
});

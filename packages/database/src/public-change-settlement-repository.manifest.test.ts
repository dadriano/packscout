import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  approvedPublicCatalogConfigurationV1Schema,
  sha256CanonicalJson,
  type ApprovedPublicCatalogConfigurationV1,
} from "@packscout/contracts";
import type { PackscoutTransactionClient } from "./database.ts";
import { PUBLIC_CATALOG_CONFIGURATION_HASH_DOMAIN } from "./catalog-release-source-repository.ts";
import { PrismaProviderCatalogSettlementRepository } from "./public-change-settlement-repository.provider-read.ts";
import { ProviderSourceLifecycleRepository } from
  "./provider-source-lifecycle-repository.ts";
import {
  advanceSettledPublicWatermark,
  allocatePublicChangeCauses,
  canonicalCatalogPlatformKeys,
  createPublicDerivationObligations,
  providerPublicEntityKey,
} from "./public-change-settlement-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

const lifecycleOrganizationId = "54000000-0000-4000-8000-000000000001";
const barrierOrganizationId = "54000000-0000-4000-8000-000000000002";
const otherOrganizationId = "54000000-0000-4000-8000-000000000003";
const tamperOrganizationId = "54000000-0000-4000-8000-000000000004";
const orderingOrganizationId = "54000000-0000-4000-8000-000000000005";
const zeroSettledOrganizationId = "54000000-0000-4000-8000-000000000006";
const upgradeSafetyOrganizationId = "54000000-0000-4000-8000-000000000007";
const publicCategoryId = "54222222-2222-5222-8222-222222222222";

function configuration(input: {
  platformKeys: readonly string[];
  revision: number;
  approvedAt: string;
}): ApprovedPublicCatalogConfigurationV1 {
  return {
    schemaVersion: "approved_public_catalog_v1",
    configurationKey: `catalog-r${input.revision}`,
    revision: input.revision,
    approvedAt: input.approvedAt,
    staleAfterSeconds: 900,
    confidencePolicy: {
      version: "confidence-v1",
      completeScoreBasisPoints: 9_000,
      partialScoreBasisPoints: 6_000,
      unknownScoreBasisPoints: 3_000,
      limitationPenaltyBasisPoints: 500,
    },
    publicAssetOrigins: input.platformKeys.map(
      (platformKey) => `https://${platformKey}.example`,
    ),
    verifiedUsdStablecoins: [],
    categories: [{
      publicCategoryId,
      parentPublicCategoryId: null,
      categoryKey: "cards",
      name: "Cards",
      kind: "vertical",
      depth: 0,
      pathPublicCategoryIds: [publicCategoryId],
      displayOrder: 0,
    }],
    platforms: input.platformKeys.map((platformKey, index) => ({
      platformKey,
      vendor: {
        publicVendorId:
          `54111111-1111-5111-8111-${String(index + 1).padStart(12, "0")}`,
        vendorKey: platformKey,
        displayName: platformKey.toUpperCase(),
        logoUrl: null,
        websiteUrl: `https://${platformKey}.example`,
        listingHosts: [`${platformKey}.example`],
        imageOrigins: [`https://${platformKey}.example`],
        referralParameters: [],
        publicPromo: null,
      },
      format: "repack" as const,
      defaultPublicCategoryIds: [publicCategoryId],
      categoryMappings: [],
      collectibleTypeMappings: [],
    })),
    repacks: [],
    collectibles: [],
  };
}

async function seedOrganization(
  database: Awaited<ReturnType<typeof createMigratedTestDatabase>>["client"],
  organizationId: string,
  platformKeys: readonly string[],
): Promise<ReadonlyMap<string, Readonly<{
  providerId: string;
  sourceInstanceId: string;
  sourceRevisionId: string;
}>>> {
  await database.organizations.create({
    data: {
      id: organizationId,
      slug: `manifest-${organizationId.at(-1)}`,
      name: "Manifest Eligibility",
    },
  });
  const lifecycle = new ProviderSourceLifecycleRepository(database);
  const connection = await lifecycle.createConnectionProfileRevision({
    organizationId,
    sourceTypeKey: "manifest-eligibility-v1",
    connectionTypeKey: "manifest-eligibility-connection-v1",
    displayName: "Manifest eligibility fixture",
    requestLimit: 2,
    sourceAdapterVersion: "manifest-eligibility-adapter-v1",
    revisionNumber: 1,
    configurationCiphertext: new Uint8Array(32).fill(1),
    configurationNonce: new Uint8Array(12).fill(2),
    configurationAuthTag: new Uint8Array(16).fill(3),
    encryptionKeyVersion: 1,
    configurationFingerprint: "a".repeat(64),
    actorKey: "manifest-fixture",
    createdAt: new Date("2026-08-16T00:00:00.000Z"),
  });
  await database.$transaction([
    database.source_connection_revisions.update({
      where: { id: connection.revisionId },
      data: {
        state: "active",
        activated_at: new Date("2026-08-16T00:00:00.000Z"),
      },
    }),
    database.source_connection_profiles.update({
      where: { id: connection.profileId },
      data: {
        state: "active",
        active_revision_id: connection.revisionId,
      },
    }),
  ]);
  const providers = new Map<string, Readonly<{
    providerId: string;
    sourceInstanceId: string;
    sourceRevisionId: string;
  }>>();
  for (const [index, platformKey] of platformKeys.entries()) {
    const id = randomUUID();
    await database.provider_sources.create({
      data: {
        id,
        organization_id: organizationId,
        platform_key: platformKey,
        display_name: platformKey.toUpperCase(),
        state: "active",
      },
    });
    const source = await lifecycle.createSourceInstanceRevision({
      organizationId,
      providerId: id,
      connectionProfileId: connection.profileId,
      sourceTypeKey: "manifest-eligibility-v1",
      sourceAdapterVersion: "manifest-eligibility-adapter-v1",
      normalizedContractVersion: "packscout.provider-observation.v1",
      mapperKey: `${platformKey}-manifest-fixture`,
      mapperVersion: "v1",
      identityNamespaceKey: `${platformKey}-manifest-fixture`,
      cursorCodecVersion: "manifest-fixture-cursor-v1",
      revisionNumber: 1,
      configuration: { platformKey },
      configurationHash: String((index % 9) + 1).repeat(64),
      recordIdScopes: ["catalog-pack-v1", "catalog-card-v1", "pull-v1"],
      actorKey: "manifest-fixture",
      createdAt: new Date("2026-08-16T00:00:00.000Z"),
    });
    await database.provider_source_instances.update({
      where: { id: source.sourceInstanceId },
      data: {
        state: "active",
        activated_at: new Date("2026-08-16T00:00:00.000Z"),
      },
    });
    providers.set(platformKey, { providerId: id, ...source });
  }
  return providers;
}

async function approveConfiguration(
  transaction: PackscoutTransactionClient,
  input: {
    organizationId: string;
    configuration: ApprovedPublicCatalogConfigurationV1;
  },
): Promise<bigint> {
  approvedPublicCatalogConfigurationV1Schema.parse(input.configuration);
  const configurationHash = await sha256CanonicalJson(
    PUBLIC_CATALOG_CONFIGURATION_HASH_DOMAIN,
    input.configuration,
  );
  const approvedAt = new Date(input.configuration.approvedAt);
  const platformKeys = canonicalCatalogPlatformKeys(
    input.configuration.platforms.map(({ platformKey }) => platformKey),
  );
  const [cause] = await allocatePublicChangeCauses(transaction, {
    organizationId: input.organizationId,
    changes: [{
      changeKind: "public_configuration",
      entityKey:
        `public-catalog-configuration:v1:${input.configuration.configurationKey}`,
      sourceKey: "packscout-public-catalog",
      sourceRevisionKey: input.configuration.configurationKey,
      occurredAt: approvedAt,
      catalogImpact: {
        kind: "catalog",
        providerPlatformKeys: platformKeys,
        sharedConfigurationEpoch: {
          configurationKey: input.configuration.configurationKey,
          revision: input.configuration.revision,
          configurationHash,
        },
      },
    }],
  });
  await transaction.approved_public_catalog_configurations.create({
    data: {
      organization_id: input.organizationId,
      configuration_key: input.configuration.configurationKey,
      revision: input.configuration.revision,
      configuration_json: input.configuration,
      configuration_hash: configurationHash,
      approved_at: approvedAt,
      public_change_sequence: cause!.sequence,
      created_at: approvedAt,
    },
  });
  return cause!.sequence;
}

async function recordLifecycle(
  transaction: PackscoutTransactionClient,
  input: {
    organizationId: string;
    providerId: string;
    sourceInstanceId: string;
    sourceRevisionId: string;
    platformKey: string;
    state: "active" | "disabled" | "archived";
    changedAt: Date;
  },
): Promise<bigint> {
  await transaction.provider_source_instances.update({
    where: { id: input.sourceInstanceId },
    data: {
      state: input.state === "active" ? "active" : "disabled",
      disabled_at: input.state === "active" ? null : input.changedAt,
      updated_at: input.changedAt,
    },
  });
  const [cause] = await allocatePublicChangeCauses(transaction, {
    organizationId: input.organizationId,
    changes: [{
      changeKind: "provider_lifecycle",
      entityKey: providerPublicEntityKey(input.providerId),
      sourceKey: input.platformKey,
      sourceRevisionKey: input.sourceRevisionId,
      metadata: {
        providerId: input.providerId,
        platformKey: input.platformKey,
        state: input.state,
        sourceInstanceId: input.sourceInstanceId,
        sourceRevisionId: input.sourceRevisionId,
      },
      occurredAt: input.changedAt,
      catalogImpact: {
        kind: "catalog",
        providerPlatformKeys: input.state === "active" ? [input.platformKey] : [],
        manifestLifecycle: {
          platformKey: input.platformKey,
          state: input.state,
        },
      },
    }],
  });
  return cause!.sequence;
}

test("manifest eligibility is atomic, tenant-scoped, and disable is manifest-only", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const platformKeys = ["alpha", "beta"] as const;
    const providers = await seedOrganization(
      harness.client,
      lifecycleOrganizationId,
      platformKeys,
    );
    await seedOrganization(harness.client, otherOrganizationId, ["other-only"]);
    await assert.rejects(
      harness.client.provider_sources.create({
        data: {
          organization_id: lifecycleOrganizationId,
          platform_key: "Invalid Platform",
          display_name: "Invalid",
        },
      }),
      /provider_sources_platform_key_valid/i,
    );
    await assert.rejects(
      harness.client.$transaction(async (transaction) => {
        await allocatePublicChangeCauses(transaction, {
          organizationId: lifecycleOrganizationId,
          changes: [{
            changeKind: "manual_correction",
            entityKey: "canonical:v1:cross-tenant-impact",
            occurredAt: new Date("2026-08-16T02:59:00.000Z"),
            catalogImpact: {
              kind: "catalog",
              providerPlatformKeys: ["other-only"],
            },
          }],
        });
      }),
      /foreign key constraint/i,
    );
    const approvedAt = new Date("2026-08-16T03:00:00.000Z");
    const initialConfiguration = configuration({
      platformKeys,
      revision: 1,
      approvedAt: approvedAt.toISOString(),
    });
    const initialConfigurationHash = await sha256CanonicalJson(
      PUBLIC_CATALOG_CONFIGURATION_HASH_DOMAIN,
      initialConfiguration,
    );
    await assert.rejects(
      harness.client.$transaction(async (transaction) => {
        const [cause] = await allocatePublicChangeCauses(transaction, {
          organizationId: lifecycleOrganizationId,
          changes: [{
            changeKind: "public_configuration",
            entityKey: "public-catalog-configuration:v1:catalog-r1",
            occurredAt: approvedAt,
            catalogImpact: {
              kind: "catalog",
              providerPlatformKeys: ["alpha"],
              sharedConfigurationEpoch: {
                configurationKey: initialConfiguration.configurationKey,
                revision: initialConfiguration.revision,
                configurationHash: initialConfigurationHash,
              },
            },
          }],
        });
        await transaction.approved_public_catalog_configurations.create({
          data: {
            organization_id: lifecycleOrganizationId,
            configuration_key: initialConfiguration.configurationKey,
            revision: initialConfiguration.revision,
            configuration_json: initialConfiguration,
            configuration_hash: initialConfigurationHash,
            approved_at: approvedAt,
            public_change_sequence: cause!.sequence,
            created_at: approvedAt,
          },
        });
      }),
      /shared configuration impact does not match its approval/i,
    );
    await harness.client.$transaction(async (transaction) => {
      await approveConfiguration(transaction, {
        organizationId: lifecycleOrganizationId,
        configuration: initialConfiguration,
      });
      for (const platformKey of platformKeys) {
        const provider = providers.get(platformKey)!;
        await recordLifecycle(transaction, {
          organizationId: lifecycleOrganizationId,
          ...provider,
          platformKey,
          state: "active",
          changedAt: approvedAt,
        });
      }
      await advanceSettledPublicWatermark(transaction, {
        organizationId: lifecycleOrganizationId,
        settledAt: approvedAt,
      });
    });

    const repository = new PrismaProviderCatalogSettlementRepository(
      harness.client,
    );
    const initial = await repository.loadManifestEligibilitySnapshot({
      organizationId: lifecycleOrganizationId,
    });
    assert.deepEqual(initial?.enabledPlatformKeys, ["alpha", "beta"]);
    assert.deepEqual(
      initial?.checkpoints.map(({ platformKey }) => platformKey),
      ["alpha", "beta"],
    );
    assert.equal(initial?.sharedConfigurationEpoch.publicChangeSequence, 1n);
    assert.equal(initial?.lifecycleDecisionSequence, 3n);
    assert.equal(
      await repository.loadManifestEligibilitySnapshot({
        organizationId: otherOrganizationId,
      }),
      null,
    );

    const disabledAt = new Date("2026-08-16T03:01:00.000Z");
    await harness.client.$transaction(async (transaction) => {
      await transaction.provider_sources.update({
        where: { id: providers.get("beta")!.providerId },
        data: { state: "disabled", updated_at: disabledAt },
      });
      await recordLifecycle(transaction, {
        organizationId: lifecycleOrganizationId,
        ...providers.get("beta")!,
        platformKey: "beta",
        state: "disabled",
        changedAt: disabledAt,
      });
      await advanceSettledPublicWatermark(transaction, {
        organizationId: lifecycleOrganizationId,
        settledAt: disabledAt,
      });
    });
    const disabled = await repository.loadManifestEligibilitySnapshot({
      organizationId: lifecycleOrganizationId,
    });
    assert.deepEqual(disabled?.enabledPlatformKeys, ["alpha"]);
    assert.equal(disabled?.lifecycleDecisionSequence, 4n);
    assert.equal(disabled?.checkpoints[0]?.sourceHeadSequence, 2n);

    await assert.rejects(
      harness.client.provider_sources.update({
        where: { id: providers.get("alpha")!.providerId },
        data: { platform_key: "renamed-alpha" },
      }),
      /immutable/i,
    );
  } finally {
    await harness.close();
  }
});

test("a new shared epoch exposes its blocking provider until every enabled checkpoint crosses the barrier", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const platformKeys = ["alpha", "beta"] as const;
    const providers = await seedOrganization(
      harness.client,
      barrierOrganizationId,
      platformKeys,
    );
    const firstAt = new Date("2026-08-16T04:00:00.000Z");
    await harness.client.$transaction(async (transaction) => {
      await approveConfiguration(transaction, {
        organizationId: barrierOrganizationId,
        configuration: configuration({
          platformKeys,
          revision: 1,
          approvedAt: firstAt.toISOString(),
        }),
      });
      for (const platformKey of platformKeys) {
        const provider = providers.get(platformKey)!;
        await recordLifecycle(transaction, {
          organizationId: barrierOrganizationId,
          ...provider,
          platformKey,
          state: "active",
          changedAt: firstAt,
        });
      }
      await advanceSettledPublicWatermark(transaction, {
        organizationId: barrierOrganizationId,
        settledAt: firstAt,
      });
    });

    const failedAt = new Date("2026-08-16T04:01:00.000Z");
    let failedSequence = 0n;
    await harness.client.$transaction(async (transaction) => {
      const [cause] = await allocatePublicChangeCauses(transaction, {
        organizationId: barrierOrganizationId,
        changes: [{
          changeKind: "estimated_ev_outcome",
          entityKey: "canonical:v1:beta-failed",
          sourceKey: "beta",
          occurredAt: failedAt,
          catalogImpact: {
            kind: "catalog",
            providerPlatformKeys: ["beta"],
          },
        }],
      });
      failedSequence = cause!.sequence;
      await createPublicDerivationObligations(transaction, {
        organizationId: barrierOrganizationId,
        causeSequences: [failedSequence],
        derivationKind: "estimated_ev",
        derivationKey: "beta-epoch-barrier",
        createdAt: failedAt,
      });
      await transaction.public_derivation_obligations.updateMany({
        where: {
          organization_id: barrierOrganizationId,
          cause_sequence: failedSequence,
        },
        data: {
          state: "technical_failure",
          outcome_classification: "technical_failure",
          outcome_reason_code: "EPOCH_BARRIER_FAILURE",
          acknowledged_claim_token: randomUUID(),
          outcome_at: failedAt,
          updated_at: failedAt,
        },
      });
      await advanceSettledPublicWatermark(transaction, {
        organizationId: barrierOrganizationId,
        settledAt: failedAt,
      });
    });
    const repository = new PrismaProviderCatalogSettlementRepository(
      harness.client,
    );
    const blocked = await repository.loadManifestEligibilitySnapshot({
      organizationId: barrierOrganizationId,
    });
    assert.deepEqual(blocked?.checkpoints[1]?.blockedState, {
      kind: "blocked",
      reason: "technical_failure",
      causeSequence: failedSequence,
    });

    const secondAt = new Date("2026-08-16T04:02:00.000Z");
    await harness.client.$transaction(async (transaction) => {
      assert.equal(
        await approveConfiguration(transaction, {
          organizationId: barrierOrganizationId,
          configuration: configuration({
            platformKeys,
            revision: 2,
            approvedAt: secondAt.toISOString(),
          }),
        }),
        5n,
      );
      await advanceSettledPublicWatermark(transaction, {
        organizationId: barrierOrganizationId,
        settledAt: secondAt,
      });
    });
    const barred = await repository.loadManifestEligibilitySnapshot({
      organizationId: barrierOrganizationId,
    });
    assert.equal(barred?.sharedConfigurationEpoch.revision, 2);
    assert.deepEqual(barred?.checkpoints[1]?.blockedState, {
      kind: "blocked",
      reason: "technical_failure",
      causeSequence: failedSequence,
    });
    assert.equal(barred?.checkpoints[1]?.settledSequence, 3n);
    assert.equal(barred?.checkpoints[1]?.sourceHeadSequence, 5n);
    const betaCheckpoint = await repository.loadProviderCatalogCheckpoint({
      organizationId: barrierOrganizationId,
      platformKey: "beta",
    });
    assert.equal(betaCheckpoint?.sharedConfigurationEpoch.revision, 2);
    assert.deepEqual(betaCheckpoint?.blockedState, barred?.checkpoints[1]?.blockedState);

    const recoveredAt = new Date("2026-08-16T04:03:00.000Z");
    await harness.client.$transaction(async (transaction) => {
      await transaction.public_derivation_obligations.updateMany({
        where: {
          organization_id: barrierOrganizationId,
          cause_sequence: failedSequence,
        },
        data: {
          state: "succeeded",
          outcome_classification: "success",
          outcome_reason_code: null,
          acknowledged_claim_token: randomUUID(),
          outcome_at: recoveredAt,
          updated_at: recoveredAt,
        },
      });
      await advanceSettledPublicWatermark(transaction, {
        organizationId: barrierOrganizationId,
        settledAt: recoveredAt,
      });
    });
    const recovered = await repository.loadManifestEligibilitySnapshot({
      organizationId: barrierOrganizationId,
    });
    assert.equal(recovered?.sharedConfigurationEpoch.revision, 2);
    assert.deepEqual(recovered?.enabledPlatformKeys, ["alpha", "beta"]);
    assert.ok(recovered?.checkpoints.every(
      ({ sharedConfigurationEpoch }) => sharedConfigurationEpoch.revision === 2,
    ));
  } finally {
    await harness.close();
  }
});

test("provider checkpoint reads authenticate the shared configuration epoch", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const providers = await seedOrganization(
      harness.client,
      tamperOrganizationId,
      ["alpha"],
    );
    const approvedAt = new Date("2026-08-16T05:00:00.000Z");
    const approved = configuration({
      platformKeys: ["alpha"],
      revision: 1,
      approvedAt: approvedAt.toISOString(),
    });
    const forgedHash = "b".repeat(64);
    await harness.client.$transaction(async (transaction) => {
      const [cause] = await allocatePublicChangeCauses(transaction, {
        organizationId: tamperOrganizationId,
        changes: [{
          changeKind: "public_configuration",
          entityKey: "public-catalog-configuration:v1:catalog-r1",
          occurredAt: approvedAt,
          catalogImpact: {
            kind: "catalog",
            providerPlatformKeys: ["alpha"],
            sharedConfigurationEpoch: {
              configurationKey: approved.configurationKey,
              revision: approved.revision,
              configurationHash: forgedHash,
            },
          },
        }],
      });
      await transaction.approved_public_catalog_configurations.create({
        data: {
          organization_id: tamperOrganizationId,
          configuration_key: approved.configurationKey,
          revision: approved.revision,
          configuration_json: approved,
          configuration_hash: forgedHash,
          approved_at: approvedAt,
          public_change_sequence: cause!.sequence,
          created_at: approvedAt,
        },
      });
      await recordLifecycle(transaction, {
        organizationId: tamperOrganizationId,
        ...providers.get("alpha")!,
        platformKey: "alpha",
        state: "active",
        changedAt: approvedAt,
      });
      await advanceSettledPublicWatermark(transaction, {
        organizationId: tamperOrganizationId,
        settledAt: approvedAt,
      });
    });

    const repository = new PrismaProviderCatalogSettlementRepository(
      harness.client,
    );
    await assert.rejects(
      repository.loadManifestEligibilitySnapshot({
        organizationId: tamperOrganizationId,
      }),
      /configuration epoch is invalid/i,
    );
  } finally {
    await harness.close();
  }
});

test("manifest eligibility returns provider keys in canonical byte order", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const platformKeys = ["a-1", "a_1"] as const;
    const providers = await seedOrganization(
      harness.client,
      orderingOrganizationId,
      platformKeys,
    );
    const changedAt = new Date("2026-08-16T06:00:00.000Z");
    await harness.client.$transaction(async (transaction) => {
      await approveConfiguration(transaction, {
        organizationId: orderingOrganizationId,
        configuration: configuration({
          platformKeys,
          revision: 1,
          approvedAt: changedAt.toISOString(),
        }),
      });
      for (const platformKey of platformKeys) {
        const provider = providers.get(platformKey)!;
        await recordLifecycle(transaction, {
          organizationId: orderingOrganizationId,
          ...provider,
          platformKey,
          state: "active",
          changedAt,
        });
      }
      await advanceSettledPublicWatermark(transaction, {
        organizationId: orderingOrganizationId,
        settledAt: changedAt,
      });
    });

    const snapshot = await new PrismaProviderCatalogSettlementRepository(
      harness.client,
    ).loadManifestEligibilitySnapshot({
      organizationId: orderingOrganizationId,
    });
    assert.deepEqual(snapshot?.enabledPlatformKeys, platformKeys);
    assert.deepEqual(
      snapshot?.checkpoints.map(({ platformKey }) => platformKey),
      platformKeys,
    );
  } finally {
    await harness.close();
  }
});

test("an active source without source-native lifecycle causality blocks manifest eligibility", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const providers = await seedOrganization(
      harness.client,
      upgradeSafetyOrganizationId,
      ["alpha"],
    );
    const source = providers.get("alpha")!;
    const approvedAt = new Date("2026-08-16T06:30:00.000Z");
    await harness.client.$transaction(async (transaction) => {
      await approveConfiguration(transaction, {
        organizationId: upgradeSafetyOrganizationId,
        configuration: configuration({
          platformKeys: ["alpha"],
          revision: 1,
          approvedAt: approvedAt.toISOString(),
        }),
      });
      await advanceSettledPublicWatermark(transaction, {
        organizationId: upgradeSafetyOrganizationId,
        settledAt: approvedAt,
      });
    });

    const repository = new PrismaProviderCatalogSettlementRepository(
      harness.client,
    );
    assert.equal(await repository.loadManifestEligibilitySnapshot({
      organizationId: upgradeSafetyOrganizationId,
    }), null);

    const legacyAt = new Date("2026-08-16T06:31:00.000Z");
    await harness.client.$transaction(async (transaction) => {
      await allocatePublicChangeCauses(transaction, {
        organizationId: upgradeSafetyOrganizationId,
        changes: [{
          changeKind: "provider_lifecycle",
          entityKey: providerPublicEntityKey(source.providerId),
          sourceKey: "alpha",
          sourceRevisionKey: source.sourceRevisionId,
          metadata: {
            providerId: source.providerId,
            platformKey: "alpha",
            state: "active",
            configurationRevisionId: randomUUID(),
          },
          occurredAt: legacyAt,
          catalogImpact: {
            kind: "catalog",
            providerPlatformKeys: ["alpha"],
            manifestLifecycle: { platformKey: "alpha", state: "active" },
          },
        }],
      });
      await advanceSettledPublicWatermark(transaction, {
        organizationId: upgradeSafetyOrganizationId,
        settledAt: legacyAt,
      });
    });
    assert.equal(await repository.loadManifestEligibilitySnapshot({
      organizationId: upgradeSafetyOrganizationId,
    }), null);

    const reassertedAt = new Date("2026-08-16T06:32:00.000Z");
    await harness.client.$transaction(async (transaction) => {
      await recordLifecycle(transaction, {
        organizationId: upgradeSafetyOrganizationId,
        ...source,
        platformKey: "alpha",
        state: "active",
        changedAt: reassertedAt,
      });
      await advanceSettledPublicWatermark(transaction, {
        organizationId: upgradeSafetyOrganizationId,
        settledAt: reassertedAt,
      });
    });
    assert.deepEqual((await repository.loadManifestEligibilitySnapshot({
      organizationId: upgradeSafetyOrganizationId,
    }))?.enabledPlatformKeys, ["alpha"]);
  } finally {
    await harness.close();
  }
});

test("provider checkpoint reads preserve a truthful null timestamp at zero settlement", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const providers = await seedOrganization(
      harness.client,
      zeroSettledOrganizationId,
      ["alpha"],
    );
    const approvedAt = new Date("2026-08-16T07:00:00.000Z");
    await harness.client.$transaction(async (transaction) => {
      await approveConfiguration(transaction, {
        organizationId: zeroSettledOrganizationId,
        configuration: configuration({
          platformKeys: ["alpha"],
          revision: 1,
          approvedAt: approvedAt.toISOString(),
        }),
      });
      await recordLifecycle(transaction, {
        organizationId: zeroSettledOrganizationId,
        ...providers.get("alpha")!,
        platformKey: "alpha",
        state: "active",
        changedAt: approvedAt,
      });
      await advanceSettledPublicWatermark(transaction, {
        organizationId: zeroSettledOrganizationId,
        settledAt: approvedAt,
      });
    });

    const blockedAt = new Date("2026-08-16T07:01:00.000Z");
    let blockedSequence = 0n;
    await harness.client.$transaction(async (transaction) => {
      const [cause] = await allocatePublicChangeCauses(transaction, {
        organizationId: zeroSettledOrganizationId,
        changes: [{
          changeKind: "provider_projection",
          entityKey: "canonical:v1:alpha:first-blocked",
          sourceKey: "alpha",
          occurredAt: blockedAt,
          catalogImpact: {
            kind: "catalog",
            providerPlatformKeys: ["alpha"],
          },
        }],
      });
      blockedSequence = cause!.sequence;
      await createPublicDerivationObligations(transaction, {
        organizationId: zeroSettledOrganizationId,
        causeSequences: [blockedSequence],
        derivationKind: "estimated_ev",
        derivationKey: "zero-settled-reader",
        createdAt: blockedAt,
      });
      await advanceSettledPublicWatermark(transaction, {
        organizationId: zeroSettledOrganizationId,
        settledAt: blockedAt,
      });
    });
    await harness.client.provider_catalog_checkpoints.update({
      where: {
        organization_id_platform_key: {
          organization_id: zeroSettledOrganizationId,
          platform_key: "alpha",
        },
      },
      data: { settled_sequence: 0n, settled_at: null },
    });

    const checkpoint = await new PrismaProviderCatalogSettlementRepository(
      harness.client,
    ).loadProviderCatalogCheckpoint({
      organizationId: zeroSettledOrganizationId,
      platformKey: "alpha",
    });
    assert.ok(checkpoint);
    assert.equal(checkpoint.settledSequence, 0n);
    assert.equal(checkpoint.settledAt, null);
    assert.equal(checkpoint.sourceHeadSequence, blockedSequence);
    assert.equal(checkpoint.sourceHeadAt.toISOString(), blockedAt.toISOString());
    assert.deepEqual(checkpoint.blockedState, {
      kind: "blocked",
      reason: "pending_derivation",
      causeSequence: blockedSequence,
    });
  } finally {
    await harness.close();
  }
});

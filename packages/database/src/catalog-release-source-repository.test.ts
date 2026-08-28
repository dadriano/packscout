import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  sha256CanonicalJson,
  type ApprovedPublicCatalogConfigurationV1,
} from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import {
  ApprovedPublicCatalogConfigurationPersistenceError,
  PUBLIC_CATALOG_CONFIGURATION_HASH_DOMAIN,
  PrismaCatalogReleaseSourceRepository,
} from "./catalog-release-source-repository.ts";
import {
  prismaApprovedPublicRepackIdentityMaterializer as materializer,
} from "./public-repack-identity-mapping-repository.ts";
import {
  advanceSettledPublicWatermark,
  allocatePublicChangeCauses,
} from "./public-change-settlement-repository.ts";
import { ProviderSourceLifecycleRepository } from "./provider-source-lifecycle-repository.ts";
import { ProviderSourceAdminLifecycleRepository } from
  "./provider-source-admin-lifecycle-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

const organizationId = "81000000-0000-4000-8000-000000000001";
const publicVendorId = "81111111-1111-5111-8111-111111111111";
const publicCategoryId = "81222222-2222-5222-8222-222222222222";
const publicRepackId = "81333333-3333-5333-8333-333333333333";

async function registerVendor(
  database: Awaited<ReturnType<typeof createMigratedTestDatabase>>["client"],
): Promise<void> {
  await database.provider_sources.create({
    data: {
      organization_id: organizationId,
      platform_key: "vendor",
      display_name: "Vendor",
    },
  });
}

function configuration(overrides: {
  revision?: number;
  configurationKey?: string;
  approvedAt?: string;
  repacks?: ApprovedPublicCatalogConfigurationV1["repacks"];
} = {}): ApprovedPublicCatalogConfigurationV1 {
  return {
    schemaVersion: "approved_public_catalog_v1",
    configurationKey: overrides.configurationKey ?? "catalog-r1",
    revision: overrides.revision ?? 1,
    approvedAt: overrides.approvedAt ?? "2026-08-15T01:00:00.000Z",
    staleAfterSeconds: 900,
    confidencePolicy: {
      version: "confidence-v1",
      completeScoreBasisPoints: 9_000,
      partialScoreBasisPoints: 6_000,
      unknownScoreBasisPoints: 3_000,
      limitationPenaltyBasisPoints: 500,
    },
    publicAssetOrigins: ["https://vendor.example"],
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
    platforms: [{
      platformKey: "vendor",
      vendor: {
        publicVendorId,
        vendorKey: "vendor",
        displayName: "Vendor",
        logoUrl: null,
        websiteUrl: "https://vendor.example",
        listingHosts: ["vendor.example"],
        imageOrigins: ["https://vendor.example"],
        referralParameters: [],
        publicPromo: null,
      },
      format: "repack",
      defaultPublicCategoryIds: [publicCategoryId],
      categoryMappings: [],
      collectibleTypeMappings: [],
    }],
    repacks: overrides.repacks ?? [{
      platformKey: "vendor",
      packExternalId: "pack-1",
      publicRepackId,
    }],
    collectibles: [],
  };
}

test("configuration approval, governed identities, and settlement commit atomically and immutably", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await harness.client.organizations.create({
      data: { id: organizationId, slug: "public-catalog", name: "Public Catalog" },
    });
    await registerVendor(harness.client);
    const repository = new PrismaCatalogReleaseSourceRepository(
      harness.client,
      organizationId,
    );
    const approved = await repository.approveConfiguration(configuration(), materializer);
    assert.equal(approved.publicChangeSequence, 1n);
    assert.equal(await harness.client.approved_public_catalog_configurations.count(), 1);
    assert.equal(await harness.client.public_change_causes.count(), 1);
    const mappings = await harness.client.$queryRaw<Array<{ sequence: bigint }>>(Prisma.sql`
      select public_change_sequence as sequence
      from public.public_repack_identity_mappings
    `);
    assert.deepEqual(mappings, [{ sequence: 1n }]);
    assert.equal(
      (await harness.client.settled_public_watermarks.findUniqueOrThrow({
        where: { organization_id: organizationId },
      })).settled_sequence,
      1n,
    );
    await assert.rejects(
      harness.client.approved_public_catalog_configurations.update({
        where: { id: approved.id },
        data: { configuration_hash: "b".repeat(64) },
      }),
      /immutable/i,
    );
    await assert.rejects(
      repository.approveConfiguration(
        configuration({
          revision: 2,
          configurationKey: "catalog-r2",
          approvedAt: "2026-08-15T02:00:00.000Z",
        }),
        { async materializeApprovedMappings() { throw new Error("mapping write failed"); } },
      ),
      /mapping write failed/,
    );
    assert.equal(await harness.client.approved_public_catalog_configurations.count(), 1);
    assert.equal(await harness.client.public_change_causes.count(), 1);

    const exactPrevious = {
      configurationKey: approved.configuration.configurationKey,
      revision: approved.configuration.revision,
      configurationHash: approved.configurationHash,
      publicChangeSequence: approved.publicChangeSequence,
    };
    const predecessorMismatches = [{
      ...exactPrevious,
      configurationKey: "wrong-predecessor",
    }, {
      ...exactPrevious,
      revision: exactPrevious.revision + 1,
    }, {
      ...exactPrevious,
      configurationHash: "f".repeat(64),
    }, {
      ...exactPrevious,
      publicChangeSequence: exactPrevious.publicChangeSequence + 1n,
    }];
    for (const expectedPrevious of predecessorMismatches) {
      await assert.rejects(
        repository.approveConfiguration(
          configuration({
            revision: 2,
            configurationKey: "catalog-r2",
            approvedAt: "2026-08-15T02:00:00.000Z",
          }),
          materializer,
          { expectedPrevious },
        ),
        (error: unknown) =>
          error instanceof ApprovedPublicCatalogConfigurationPersistenceError &&
          error.code === "PUBLIC_CONFIGURATION_PREDECESSOR_MISMATCH",
      );
    }
    assert.equal(await harness.client.approved_public_catalog_configurations.count(), 1);
    assert.equal(await harness.client.public_change_causes.count(), 1);

    const concurrent = await Promise.allSettled([1, 2].map(() =>
      repository.approveConfiguration(
        configuration({
          revision: 2,
          configurationKey: "catalog-r2",
          approvedAt: "2026-08-15T02:00:00.000Z",
        }),
        materializer,
        { expectedPrevious: exactPrevious },
      )));
    const fulfilled = concurrent.filter(
      (result): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof repository.approveConfiguration>>
      > => result.status === "fulfilled",
    );
    const rejected = concurrent.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(
      rejected[0]?.reason instanceof
        ApprovedPublicCatalogConfigurationPersistenceError,
    );
    assert.equal(
      rejected[0]?.reason.code,
      "PUBLIC_CONFIGURATION_PREDECESSOR_MISMATCH",
    );
    const second = fulfilled[0]!.value;
    const preservedMappings = await harness.client.$queryRaw<Array<{
      approvedConfigurationKey: string;
      sequence: bigint;
    }>>(Prisma.sql`
      select approved_configuration_key as "approvedConfigurationKey",
             public_change_sequence as sequence
      from public.public_repack_identity_mappings
    `);
    assert.deepEqual(preservedMappings, [{
      approvedConfigurationKey: "catalog-r1",
      sequence: 1n,
    }]);
    const latest = await repository.loadSnapshot({
      throughSequence: second.publicChangeSequence,
      throughOccurredAt: new Date("2026-08-15T02:00:00.000Z"),
    });
    assert.equal(latest.configuration?.configuration.configurationKey, "catalog-r2");
    assert.equal(latest.repackIdentities[0]?.approvedConfigurationKey, "catalog-r1");
  } finally {
    await harness.close();
  }
});

test("guarded approval rejects watermark, source, cursor, and promotion races", async () => {
  const harness = await createMigratedTestDatabase();
  const guardedOrganizationId = "81400000-0000-4000-8000-000000000001";
  const providerId = randomUUID();
  const createdAt = new Date("2026-08-15T00:00:00.000Z");
  const sourceTypeKey = "dataforrest-events-v1";
  const sourceAdapterVersion = "dataforrest-events-adapter-v1";
  const normalizedContractVersion = "packscout.provider-observation.v1";
  const cursorCodecVersion = "dataforrest-cursor-v1";
  const mapperKey = "dataforrest-catalog-v1";
  const mapperVersion = "1";
  const identityNamespaceKey = "dataforrest-vendor-guard";
  try {
    await harness.client.organizations.create({
      data: {
        id: guardedOrganizationId,
        slug: "guarded-catalog",
        name: "Guarded Catalog",
      },
    });
    await harness.client.provider_sources.create({
      data: {
        id: providerId,
        organization_id: guardedOrganizationId,
        platform_key: "vendor",
        display_name: "Vendor",
      },
    });
    const lifecycle = new ProviderSourceLifecycleRepository(harness.client);
    const connection = await lifecycle.createConnectionProfileRevision({
      organizationId: guardedOrganizationId,
      sourceTypeKey,
      connectionTypeKey: "dataforrest-events-connection-v1",
      displayName: "Guarded DataForrest",
      requestLimit: 1,
      sourceAdapterVersion,
      revisionNumber: 1,
      configurationCiphertext: new Uint8Array(32).fill(1),
      configurationNonce: new Uint8Array(12).fill(2),
      configurationAuthTag: new Uint8Array(16).fill(3),
      encryptionKeyVersion: 1,
      configurationFingerprint: "a".repeat(64),
      actorKey: "operator:test",
      createdAt,
    });
    const source = await lifecycle.createSourceInstanceRevision({
      organizationId: guardedOrganizationId,
      providerId,
      connectionProfileId: connection.profileId,
      sourceTypeKey,
      sourceAdapterVersion,
      normalizedContractVersion,
      mapperKey,
      mapperVersion,
      identityNamespaceKey,
      cursorCodecVersion,
      revisionNumber: 1,
      intervalSeconds: 300,
      configuration: { provider: "vendor" },
      configurationHash: "b".repeat(64),
      recordIdScopes: ["catalog-pack-v1"],
      actorKey: "operator:test",
      createdAt,
    });
    await harness.client.$transaction(async (transaction) => {
      await transaction.provider_sources.update({
        where: { id: providerId },
        data: { state: "active", updated_at: createdAt },
      });
      await transaction.source_connection_revisions.update({
        where: { id: connection.revisionId },
        data: { state: "active", activated_at: createdAt },
      });
      await transaction.source_connection_profiles.update({
        where: { id: connection.profileId },
        data: {
          state: "active",
          active_revision_id: connection.revisionId,
          updated_at: createdAt,
        },
      });
      await transaction.provider_source_instances.update({
        where: { id: source.sourceInstanceId },
        data: {
          state: "paused",
          activated_at: createdAt,
          paused_at: createdAt,
          pause_requested_at: null,
          updated_at: createdAt,
        },
      });
    });
    const createHeadRun = (cursorGeneration: bigint, startedAt: Date) =>
      harness.client.import_runs.create({
        data: {
          organization_id: guardedOrganizationId,
          provider_id: providerId,
          config_revision_id: null,
          trigger: "manual",
          state: "succeeded",
          started_at: startedAt,
          finished_at: new Date(startedAt.getTime() + 1_000),
          reached_provider_head: true,
          requested_by_actor_key: "operator:test",
          source_instance_id: source.sourceInstanceId,
          source_revision_id: source.sourceRevisionId,
          source_type_key: sourceTypeKey,
          source_adapter_version: sourceAdapterVersion,
          normalized_contract_version: normalizedContractVersion,
          mapper_key: mapperKey,
          mapper_version: mapperVersion,
          identity_namespace_key: identityNamespaceKey,
          connection_profile_id: connection.profileId,
          connection_revision_id: connection.revisionId,
          cursor_codec_version: cursorCodecVersion,
          cursor_generation: cursorGeneration,
          requested_cursor_key: "initial",
          current_cursor_key: "initial",
          next_page_number: 1,
        },
      });
    await createHeadRun(1n, new Date("2026-08-15T00:05:00.000Z"));
    await harness.client.$transaction(async (transaction) => {
      await allocatePublicChangeCauses(transaction, {
        organizationId: guardedOrganizationId,
        changes: [{
          changeKind: "provider_lifecycle",
          entityKey: `provider:v1:${providerId}`,
          sourceKey: "vendor",
          sourceRevisionKey: source.sourceRevisionId,
          metadata: {
            providerId,
            platformKey: "vendor",
            state: "active",
            sourceInstanceId: source.sourceInstanceId,
            sourceRevisionId: source.sourceRevisionId,
          },
          occurredAt: new Date("2026-08-15T00:10:00.000Z"),
          catalogImpact: {
            kind: "catalog",
            providerPlatformKeys: ["vendor"],
            manifestLifecycle: { platformKey: "vendor", state: "active" },
          },
        }],
      });
      await advanceSettledPublicWatermark(transaction, {
        organizationId: guardedOrganizationId,
        settledAt: new Date("2026-08-15T00:10:00.000Z"),
      });
    });
    const repository = new PrismaCatalogReleaseSourceRepository(
      harness.client,
      guardedOrganizationId,
    );
    const firstConfiguration = configuration({
      configurationKey: "catalog-r1",
      revision: 1,
      approvedAt: "2026-08-15T01:00:00.000Z",
    });
    const approved = await repository.approveConfiguration(
      firstConfiguration,
      materializer,
    );
    const expectedPrevious = {
      configurationKey: approved.configuration.configurationKey,
      revision: approved.configuration.revision,
      configurationHash: approved.configurationHash,
      publicChangeSequence: approved.publicChangeSequence,
    };
    const nextConfiguration = configuration({
      configurationKey: "catalog-r2",
      revision: 2,
      approvedAt: "2026-08-15T03:00:00.000Z",
    });
    const currentSourcePrecondition = async () => {
      const [watermark, checkpoint, cursor, latestRun] = await Promise.all([
        harness.client.settled_public_watermarks.findUniqueOrThrow({
          where: { organization_id: guardedOrganizationId },
        }),
        harness.client.provider_catalog_checkpoints.findUniqueOrThrow({
          where: {
            organization_id_platform_key: {
              organization_id: guardedOrganizationId,
              platform_key: "vendor",
            },
          },
        }),
        harness.client.provider_source_cursors.findUniqueOrThrow({
          where: { source_instance_id: source.sourceInstanceId },
        }),
        harness.client.import_runs.findFirstOrThrow({
          where: {
            organization_id: guardedOrganizationId,
            source_instance_id: source.sourceInstanceId,
            source_revision_id: source.sourceRevisionId,
            cursor_generation: (
              await harness.client.provider_source_cursors.findUniqueOrThrow({
                where: { source_instance_id: source.sourceInstanceId },
              })
            ).cursor_generation,
          },
          orderBy: [{ created_at: "desc" }, { id: "desc" }],
        }),
      ]);
      return {
        platformKey: "vendor",
        sourceInstanceId: source.sourceInstanceId,
        sourceRevisionId: source.sourceRevisionId,
        cursorGeneration: cursor.cursor_generation,
        latestRunId: latestRun.id,
        settledSequence: watermark.settled_sequence,
        sourceHeadSequence: watermark.source_head_sequence,
        nextSequence: watermark.next_sequence,
        providerSettledSequence: checkpoint.settled_sequence,
        providerSourceHeadSequence: checkpoint.source_head_sequence,
      };
    };
    const assertSourceGuardRejects = async (expectedSource: Awaited<
      ReturnType<typeof currentSourcePrecondition>
    >) => {
      await assert.rejects(
        repository.approveConfiguration(
          nextConfiguration,
          materializer,
          { expectedPrevious, expectedSource },
        ),
        (error: unknown) =>
          error instanceof ApprovedPublicCatalogConfigurationPersistenceError &&
          error.code === "PUBLIC_CONFIGURATION_SOURCE_PRECONDITION_MISMATCH",
      );
    };

    const beforeWatermarkMove = await currentSourcePrecondition();
    await harness.client.$transaction(async (transaction) => {
      await allocatePublicChangeCauses(transaction, {
        organizationId: guardedOrganizationId,
        changes: [{
          changeKind: "provider_projection",
          entityKey: "pack:v1:watermark-race",
          sourceKey: "vendor",
          sourceRevisionKey: source.sourceRevisionId,
          metadata: {},
          occurredAt: new Date("2026-08-15T01:30:00.000Z"),
          catalogImpact: {
            kind: "catalog",
            providerPlatformKeys: ["vendor"],
          },
        }],
      });
      await advanceSettledPublicWatermark(transaction, {
        organizationId: guardedOrganizationId,
        settledAt: new Date("2026-08-15T01:30:00.000Z"),
      });
    });
    await assertSourceGuardRejects(beforeWatermarkMove);

    const beforeSourceMove = await currentSourcePrecondition();
    await harness.client.provider_source_instances.update({
      where: { id: source.sourceInstanceId },
      data: { state: "active", paused_at: null },
    });
    await assertSourceGuardRejects(beforeSourceMove);
    await harness.client.provider_source_instances.update({
      where: { id: source.sourceInstanceId },
      data: { state: "paused", paused_at: new Date("2026-08-15T01:40:00.000Z") },
    });

    const beforeCursorMove = await currentSourcePrecondition();
    await new ProviderSourceAdminLifecycleRepository(harness.client).resetCursor({
      organizationId: guardedOrganizationId,
      providerId,
      sourceInstanceId: source.sourceInstanceId,
      expectedSourceRevisionId: source.sourceRevisionId,
      expectedGeneration: 1n,
      expectedFingerprint: null,
      actorKey: "operator:test",
      resetAt: new Date("2026-08-15T01:45:00.000Z"),
    });
    await assertSourceGuardRejects(beforeCursorMove);
    await createHeadRun(2n, new Date("2026-08-15T01:50:00.000Z"));

    const deploymentKey = "guarded-local";
    const emptyBody = "{}";
    const emptyActiveStateBody = JSON.stringify({
      generation: 0,
      activeManifest: null,
      previousManifest: null,
      observation: null,
      terminalReceiptSha256: null,
    });
    const beforePromotionMove = await currentSourcePrecondition();
    await harness.client.$transaction(async (transaction) => {
      await transaction.manifest_promotion_lanes.create({
        data: { organization_id: guardedOrganizationId, deployment_key: deploymentKey },
      });
      await transaction.catalog_promotion_bootstrap_proofs.create({
        data: {
          organization_id: guardedOrganizationId,
          deployment_key: deploymentKey,
          proof_revision: 1n,
          proof_kind: "empty",
          active_state_request_body: emptyBody,
          active_state_request_sha256: "a".repeat(64),
          active_state_receipt_body: emptyBody,
          active_state_receipt_sha256: "b".repeat(64),
          active_state_body: emptyActiveStateBody,
          active_state_sha256: "c".repeat(64),
          verified_at: new Date("2026-08-15T02:00:00.000Z"),
        },
      });
      await transaction.provider_promotion_lanes.create({
        data: {
          organization_id: guardedOrganizationId,
          deployment_key: deploymentKey,
          platform_key: "vendor",
          next_evaluation_sequence: 1n,
          requested_evaluation_sequence: 1n,
          requested_at: new Date("2026-08-15T02:00:00.000Z"),
          latest_checkpoint_body: emptyBody,
          latest_checkpoint_sha256: "d".repeat(64),
          settled_checkpoint: 1n,
          settled_at: new Date("2026-08-15T02:00:00.000Z"),
          source_head_checkpoint: 1n,
          source_head_at: new Date("2026-08-15T02:00:00.000Z"),
        },
      });
      await transaction.provider_promotion_evaluations.create({
        data: {
          organization_id: guardedOrganizationId,
          deployment_key: deploymentKey,
          platform_key: "vendor",
          evaluation_sequence: 1n,
          checkpoint_body: emptyBody,
          checkpoint_sha256: "d".repeat(64),
          settled_checkpoint: 1n,
          source_head_checkpoint: 1n,
          requested_at: new Date("2026-08-15T02:00:00.000Z"),
        },
      });
      await transaction.provider_promotion_attempts.create({
        data: {
          organization_id: guardedOrganizationId,
          deployment_key: deploymentKey,
          platform_key: "vendor",
          evaluation_sequence: 1n,
          bootstrap_proof_revision: 1n,
          bootstrap_provider_set_sha256: "e".repeat(64),
          target_checkpoint: 1n,
          state: "assembling",
        },
      });
    });
    await assertSourceGuardRejects(beforePromotionMove);
    await harness.client.provider_promotion_attempts.deleteMany({
      where: {
        organization_id: guardedOrganizationId,
        deployment_key: deploymentKey,
        platform_key: "vendor",
      },
    });
    const cleanSource = await currentSourcePrecondition();
    const second = await repository.approveConfiguration(
      nextConfiguration,
      materializer,
      { expectedPrevious, expectedSource: cleanSource },
    );
    assert.equal(second.configuration.configurationKey, "catalog-r2");
    assert.equal(
      await harness.client.approved_public_catalog_configurations.count(),
      2,
    );
  } finally {
    await harness.close();
  }
});

test("configuration approval rejects an unregistered or ninth platform before allocating a cause", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await harness.client.organizations.create({
      data: {
        id: organizationId,
        slug: "configuration-platform-boundary",
        name: "Configuration Platform Boundary",
      },
    });
    await registerVendor(harness.client);
    const repository = new PrismaCatalogReleaseSourceRepository(
      harness.client,
      organizationId,
    );
    const unregistered = structuredClone(configuration());
    unregistered.platforms[0]!.platformKey = "unregistered";
    unregistered.platforms[0]!.vendor.vendorKey = "unregistered";
    unregistered.repacks[0]!.platformKey = "unregistered";
    await assert.rejects(
      repository.approveConfiguration(unregistered, materializer),
      (error: unknown) =>
        error instanceof ApprovedPublicCatalogConfigurationPersistenceError &&
        error.code === "PUBLIC_CONFIGURATION_PLATFORM_UNREGISTERED",
    );

    const ninth = structuredClone(configuration());
    ninth.platforms = Array.from({ length: 9 }, (_, index) => ({
      ...structuredClone(ninth.platforms[0]!),
      platformKey: `vendor-${index + 1}`,
      vendor: {
        ...structuredClone(ninth.platforms[0]!.vendor),
        publicVendorId: `81111111-1111-5111-8111-11111111111${index + 1}`,
        vendorKey: `vendor_${index + 1}`,
      },
    }));
    await assert.rejects(
      repository.approveConfiguration(ninth, materializer),
      (error: unknown) =>
        error instanceof ApprovedPublicCatalogConfigurationPersistenceError &&
        error.code === "PUBLIC_CONFIGURATION_PLATFORM_LIMIT_EXCEEDED",
    );
    assert.equal(await harness.client.public_change_causes.count(), 0);
    assert.equal(
      await harness.client.approved_public_catalog_configurations.count(),
      0,
    );
  } finally {
    await harness.close();
  }
});

test("configuration approval compares registered platform keys in canonical byte order", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await harness.client.organizations.create({
      data: {
        id: organizationId,
        slug: "configuration-platform-order",
        name: "Configuration Platform Order",
      },
    });
    const platformKeys = ["a-1", "a_1"] as const;
    await harness.client.provider_sources.createMany({
      data: platformKeys.map((platformKey) => ({
        organization_id: organizationId,
        platform_key: platformKey,
        display_name: platformKey,
      })),
    });
    const input = configuration();
    input.publicAssetOrigins = platformKeys.map(
      (platformKey) => `https://${platformKey}.example`,
    );
    input.platforms = platformKeys.map((platformKey, index) => ({
      ...structuredClone(input.platforms[0]!),
      platformKey,
      vendor: {
        ...structuredClone(input.platforms[0]!.vendor),
        publicVendorId:
          `82111111-1111-5111-8111-${String(index + 1).padStart(12, "0")}`,
        vendorKey: platformKey,
        displayName: platformKey,
        websiteUrl: `https://${platformKey}.example`,
        listingHosts: [`${platformKey}.example`],
        imageOrigins: [`https://${platformKey}.example`],
      },
    }));
    input.repacks[0]!.platformKey = platformKeys[0];

    const approved = await new PrismaCatalogReleaseSourceRepository(
      harness.client,
      organizationId,
    ).approveConfiguration(input, materializer);
    const impact = await harness.client.public_change_catalog_impacts.findUniqueOrThrow({
      where: {
        organization_id_cause_sequence: {
          organization_id: organizationId,
          cause_sequence: approved.publicChangeSequence,
        },
      },
    });
    assert.deepEqual(impact.provider_platform_keys, platformKeys);
  } finally {
    await harness.close();
  }
});

test("source-native readiness replays active history and selects an empty-impact disable", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await harness.client.organizations.create({
      data: { id: organizationId, slug: "revision-readiness", name: "Revision Readiness" },
    });
    const providerId = randomUUID();
    await harness.client.provider_sources.create({
      data: {
        id: providerId,
        organization_id: organizationId,
        platform_key: "vendor",
        display_name: "Vendor",
      },
    });
    const sourceTypeKey = "dataforrest-events-v1";
    const sourceAdapterVersion = "dataforrest-events-adapter-v1";
    const normalizedContractVersion = "packscout.provider-observation.v1";
    const cursorCodecVersion = "dataforrest-cursor-v1";
    const lifecycleRepository = new ProviderSourceLifecycleRepository(
      harness.client,
    );
    const createdAt = new Date("2026-08-15T01:00:00.000Z");
    const connection = await lifecycleRepository.createConnectionProfileRevision({
      organizationId,
      sourceTypeKey,
      connectionTypeKey: "dataforrest-events-connection-v1",
      displayName: "DataForrest Vendor",
      requestLimit: 1,
      sourceAdapterVersion,
      revisionNumber: 1,
      configurationCiphertext: new Uint8Array(32).fill(1),
      configurationNonce: new Uint8Array(12).fill(2),
      configurationAuthTag: new Uint8Array(16).fill(3),
      encryptionKeyVersion: 1,
      configurationFingerprint: "a".repeat(64),
      actorKey: "operator:test",
      createdAt,
    });
    const createSource = (configurationHash: string) =>
      lifecycleRepository.createSourceInstanceRevision({
        organizationId,
        providerId,
        connectionProfileId: connection.profileId,
        sourceTypeKey,
        sourceAdapterVersion,
        normalizedContractVersion,
        mapperKey: "dataforrest-catalog-v1",
        mapperVersion: "1",
        identityNamespaceKey: `dataforrest-vendor-${configurationHash[0]}`,
        cursorCodecVersion,
        revisionNumber: 1,
        intervalSeconds: 300,
        configuration: { provider: "vendor", revision: configurationHash[0] },
        configurationHash,
        recordIdScopes: ["catalog-pack-v1"],
        actorKey: "operator:test",
        createdAt,
      });
    const oldSource = await createSource("b".repeat(64));
    const activeSource = await createSource("c".repeat(64));
    await harness.client.$transaction(async (transaction) => {
      await transaction.provider_sources.update({
        where: { id: providerId },
        data: { state: "active", updated_at: createdAt },
      });
      await transaction.source_connection_revisions.update({
        where: { id: connection.revisionId },
        data: { state: "active", activated_at: createdAt },
      });
      await transaction.source_connection_profiles.update({
        where: { id: connection.profileId },
        data: {
          state: "active",
          active_revision_id: connection.revisionId,
          updated_at: createdAt,
        },
      });
      await transaction.provider_source_instances.update({
        where: { id: activeSource.sourceInstanceId },
        data: {
          state: "active",
          activated_at: createdAt,
          updated_at: createdAt,
        },
      });
    });
    const backfillAt = new Date("2026-08-15T01:10:00.000Z");
    await harness.client.import_runs.create({
      data: {
        organization_id: organizationId,
        provider_id: providerId,
        config_revision_id: null,
        trigger: "manual",
        state: "succeeded",
        started_at: new Date("2026-08-15T01:05:00.000Z"),
        finished_at: backfillAt,
        reached_provider_head: true,
        requested_by_actor_key: "operator:test",
        source_instance_id: oldSource.sourceInstanceId,
        source_revision_id: oldSource.sourceRevisionId,
        source_type_key: sourceTypeKey,
        source_adapter_version: sourceAdapterVersion,
        normalized_contract_version: normalizedContractVersion,
        mapper_key: "dataforrest-catalog-v1",
        mapper_version: "1",
        identity_namespace_key: "dataforrest-vendor-b",
        connection_profile_id: connection.profileId,
        connection_revision_id: connection.revisionId,
        cursor_codec_version: cursorCodecVersion,
        cursor_generation: 1n,
        requested_cursor_key: "initial",
        current_cursor_key: "initial",
        next_page_number: 1,
      },
    });
    const repository = new PrismaCatalogReleaseSourceRepository(harness.client, organizationId);
    const approved = await repository.approveConfiguration(configuration(), materializer);
    const [lifecycle] = await harness.client.$transaction(async (transaction) => {
      const causes = await allocatePublicChangeCauses(transaction, {
        organizationId,
        changes: [{
          changeKind: "public_configuration",
          entityKey: `provider:v1:${providerId}`,
          sourceKey: "vendor",
          sourceRevisionKey: activeSource.sourceRevisionId,
          metadata: {
            providerId,
            platformKey: "vendor",
            state: "active",
            sourceInstanceId: activeSource.sourceInstanceId,
            sourceRevisionId: activeSource.sourceRevisionId,
          },
          occurredAt: new Date("2026-08-15T01:20:00.000Z"),
          catalogImpact: {
            kind: "catalog",
            providerPlatformKeys: ["vendor"],
            manifestLifecycle: { platformKey: "vendor", state: "active" },
          },
        }],
      });
      await advanceSettledPublicWatermark(transaction, {
        organizationId,
        settledAt: new Date("2026-08-15T01:20:00.000Z"),
      });
      return causes;
    });
    const snapshot = await repository.loadSnapshot({
      throughSequence: lifecycle!.sequence,
      throughOccurredAt: new Date("2026-08-15T01:20:00.000Z"),
    });
    assert.equal(snapshot.configuration?.id, approved.id);
    assert.equal(snapshot.providers[0]?.providerId, providerId);
    assert.equal(
      snapshot.providers[0]?.sourceInstanceId,
      activeSource.sourceInstanceId,
    );
    assert.equal(
      snapshot.providers[0]?.sourceRevisionId,
      activeSource.sourceRevisionId,
    );
    assert.equal(snapshot.providers[0]?.completedBackfillAt, null);
    assert.equal(await harness.client.provider_config_revisions.count(), 0);

    const activeBackfillAt = new Date("2026-08-15T01:25:00.000Z");
    await harness.client.import_runs.create({
      data: {
        organization_id: organizationId,
        provider_id: providerId,
        config_revision_id: null,
        trigger: "manual",
        state: "succeeded",
        started_at: new Date("2026-08-15T01:15:00.000Z"),
        finished_at: activeBackfillAt,
        reached_provider_head: true,
        requested_by_actor_key: "operator:test",
        source_instance_id: activeSource.sourceInstanceId,
        source_revision_id: activeSource.sourceRevisionId,
        source_type_key: sourceTypeKey,
        source_adapter_version: sourceAdapterVersion,
        normalized_contract_version: normalizedContractVersion,
        mapper_key: "dataforrest-catalog-v1",
        mapper_version: "1",
        identity_namespace_key: "dataforrest-vendor-c",
        connection_profile_id: connection.profileId,
        connection_revision_id: connection.revisionId,
        cursor_codec_version: cursorCodecVersion,
        cursor_generation: 1n,
        requested_cursor_key: "initial",
        current_cursor_key: "initial",
        next_page_number: 1,
      },
    });
    const ready = await repository.loadSnapshot({
      throughSequence: lifecycle!.sequence,
      throughOccurredAt: new Date("2026-08-15T01:20:00.000Z"),
    });
    assert.equal(
      ready.providers[0]?.completedBackfillAt?.toISOString(),
      activeBackfillAt.toISOString(),
      "source-head completion may follow the last settled catalog cause",
    );

    const laterSource = await createSource("d".repeat(64));
    const [laterLifecycle] = await harness.client.$transaction(
      async (transaction) => {
        const replacedAt = new Date("2026-08-15T01:30:00.000Z");
        await transaction.provider_source_instances.update({
          where: { id: activeSource.sourceInstanceId },
          data: {
            state: "replaced",
            replaced_at: replacedAt,
            updated_at: replacedAt,
          },
        });
        await transaction.provider_source_instances.update({
          where: { id: laterSource.sourceInstanceId },
          data: {
            state: "active",
            activated_at: replacedAt,
            updated_at: replacedAt,
          },
        });
        const causes = await allocatePublicChangeCauses(transaction, {
          organizationId,
          changes: [{
            changeKind: "provider_lifecycle",
            entityKey: `provider:v1:${providerId}`,
            sourceKey: "vendor",
            sourceRevisionKey: laterSource.sourceRevisionId,
            metadata: {
              providerId,
              platformKey: "vendor",
              state: "active",
              sourceInstanceId: laterSource.sourceInstanceId,
              sourceRevisionId: laterSource.sourceRevisionId,
            },
            occurredAt: replacedAt,
            catalogImpact: {
              kind: "catalog",
              providerPlatformKeys: ["vendor"],
              manifestLifecycle: { platformKey: "vendor", state: "active" },
            },
          }],
        });
        await advanceSettledPublicWatermark(transaction, {
          organizationId,
          settledAt: replacedAt,
        });
        return causes;
      },
    );

    const historicalReplay = await repository.loadSnapshot({
      throughSequence: lifecycle!.sequence,
      throughOccurredAt: new Date("2026-08-15T01:20:00.000Z"),
    });
    assert.equal(
      historicalReplay.providers[0]?.sourceInstanceId,
      activeSource.sourceInstanceId,
    );
    assert.equal(
      historicalReplay.providers[0]?.sourceRevisionId,
      activeSource.sourceRevisionId,
    );
    assert.equal(
      historicalReplay.providers[0]?.completedBackfillAt?.toISOString(),
      activeBackfillAt.toISOString(),
      "a later source activation must not change a prior causal snapshot",
    );

    const latest = await repository.loadSnapshot({
      throughSequence: laterLifecycle!.sequence,
      throughOccurredAt: new Date("2026-08-15T01:30:00.000Z"),
    });
    assert.equal(
      latest.providers[0]?.sourceInstanceId,
      laterSource.sourceInstanceId,
    );
    assert.equal(
      latest.providers[0]?.sourceRevisionId,
      laterSource.sourceRevisionId,
    );
    assert.equal(latest.providers[0]?.state, "active");
    assert.equal(
      latest.providers[0]?.lifecycleSequence,
      laterLifecycle!.sequence,
    );
    assert.equal(latest.providers[0]?.completedBackfillAt, null);

    const disabledAt = new Date("2026-08-15T01:40:00.000Z");
    const [disabledLifecycle] = await harness.client.$transaction(
      async (transaction) => {
        await transaction.provider_source_instances.update({
          where: { id: laterSource.sourceInstanceId },
          data: {
            state: "disabled",
            disabled_at: disabledAt,
            updated_at: disabledAt,
          },
        });
        const causes = await allocatePublicChangeCauses(transaction, {
          organizationId,
          changes: [{
            changeKind: "provider_lifecycle",
            entityKey: `provider:v1:${providerId}`,
            sourceKey: "vendor",
            sourceRevisionKey: laterSource.sourceRevisionId,
            metadata: {
              providerId,
              platformKey: "vendor",
              state: "disabled",
              sourceInstanceId: laterSource.sourceInstanceId,
              sourceRevisionId: laterSource.sourceRevisionId,
            },
            occurredAt: disabledAt,
            catalogImpact: {
              kind: "catalog",
              providerPlatformKeys: [],
              manifestLifecycle: {
                platformKey: "vendor",
                state: "disabled",
              },
            },
          }],
        });
        await advanceSettledPublicWatermark(transaction, {
          organizationId,
          settledAt: disabledAt,
        });
        return causes;
      },
    );

    const activeReplay = await repository.loadSnapshot({
      throughSequence: laterLifecycle!.sequence,
      throughOccurredAt: new Date("2026-08-15T01:30:00.000Z"),
    });
    assert.equal(activeReplay.providers[0]?.state, "active");
    assert.equal(
      activeReplay.providers[0]?.lifecycleSequence,
      laterLifecycle.sequence,
    );
    assert.equal(
      activeReplay.providers[0]?.sourceRevisionId,
      laterSource.sourceRevisionId,
    );

    const disabled = await repository.loadSnapshot({
      throughSequence: disabledLifecycle!.sequence,
      throughOccurredAt: disabledAt,
    });
    assert.equal(disabled.providers[0]?.state, "disabled");
    assert.equal(
      disabled.providers[0]?.lifecycleSequence,
      disabledLifecycle.sequence,
    );
    assert.equal(
      disabled.providers[0]?.sourceRevisionId,
      laterSource.sourceRevisionId,
      "the empty-impact disable must be selected instead of falling back active",
    );
  } finally {
    await harness.close();
  }
});

async function waitForBlockedProviderRead(database: {
  $queryRaw<T>(query: Prisma.Sql): Promise<T>;
}) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await database.$queryRaw<Array<{ blocked: boolean }>>(Prisma.sql`
      select exists (
        select 1 from pg_stat_activity
        where datname = current_database()
          and wait_event_type = 'Lock'
          and query like '%from public.provider_sources provider%'
      ) as blocked
    `);
    if (rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("snapshot provider read did not block");
}

test("one repeatable-read snapshot cannot mix a newer configuration mapping into older source state", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await harness.client.organizations.create({
      data: { id: organizationId, slug: "snapshot-coherence", name: "Snapshot Coherence" },
    });
    await registerVendor(harness.client);
    const repository = new PrismaCatalogReleaseSourceRepository(harness.client, organizationId);
    await repository.approveConfiguration(configuration(), materializer);
    const writer = await harness.createIndependentClient();
    const observer = await harness.createIndependentClient();
    let releaseWriter!: () => void;
    let writerLocked!: () => void;
    const held = new Promise<void>((resolve) => { releaseWriter = resolve; });
    const locked = new Promise<void>((resolve) => { writerLocked = resolve; });
    const secondRepack = {
      platformKey: "vendor",
      packExternalId: "pack-2",
      publicRepackId: "81444444-4444-5444-8444-444444444444",
    } as const;
    const writerPromise = writer.$transaction(async (transaction) => {
      await transaction.$executeRaw(Prisma.sql`
        lock table public.provider_sources in access exclusive mode
      `);
      writerLocked();
      await held;
      const second = configuration({
        revision: 2,
        configurationKey: "catalog-r2",
        repacks: [...configuration().repacks, secondRepack],
      });
      const hash = await sha256CanonicalJson(
        PUBLIC_CATALOG_CONFIGURATION_HASH_DOMAIN,
        second,
      );
      const [cause] = await allocatePublicChangeCauses(transaction, {
        organizationId,
        changes: [{
          changeKind: "public_configuration",
          entityKey: "public-catalog-configuration:v1:catalog-r2",
          sourceKey: "packscout-public-catalog",
          sourceRevisionKey: "catalog-r2",
          metadata: { configurationKey: "catalog-r2", revision: 2, configurationHash: hash },
          occurredAt: new Date("2026-08-15T02:00:00.000Z"),
          catalogImpact: {
            kind: "catalog",
            providerPlatformKeys: ["vendor"],
            sharedConfigurationEpoch: {
              configurationKey: "catalog-r2",
              revision: 2,
              configurationHash: hash,
            },
          },
        }],
      });
      await transaction.approved_public_catalog_configurations.create({
        data: {
          organization_id: organizationId,
          configuration_key: second.configurationKey,
          revision: second.revision,
          configuration_json: second as Prisma.InputJsonValue,
          configuration_hash: hash,
          approved_at: new Date(second.approvedAt),
          public_change_sequence: cause!.sequence,
        },
      });
      await materializer.materializeApprovedMappings(transaction, {
        organizationId,
        approvedConfigurationKey: second.configurationKey,
        publicChangeSequence: cause!.sequence,
        approvedAt: new Date(second.approvedAt),
        mappings: [secondRepack],
      });
    });
    await locked;
    const snapshotPromise = repository.loadSnapshot({
      throughSequence: 2n,
      throughOccurredAt: new Date("2026-08-15T02:00:00.000Z"),
    });
    await waitForBlockedProviderRead(observer);
    releaseWriter();
    await writerPromise;
    const snapshot = await snapshotPromise;
    assert.equal(snapshot.configuration?.configuration.revision, 1);
    assert.deepEqual(
      snapshot.repackIdentities.map(({ packExternalId }) => packExternalId),
      ["pack-1"],
    );
  } finally {
    await harness.close();
  }
});

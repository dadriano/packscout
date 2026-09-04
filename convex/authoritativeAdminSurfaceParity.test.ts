/// <reference types="vite/client" />

import {
  PRODUCTION_CATALOG_MANIFEST_PATHS,
  PRODUCTION_CATALOG_RETENTION_PATHS,
  PRODUCTION_DATA_RELEASE_V3_PATHS,
  PRODUCTION_PROVIDER_RELEASE_PATHS,
} from "@packscout/contracts";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import {
  findRepacksByDesiredCollectibleV3,
  getDashboardBundleV3,
  getPublicRepackV3,
  getPublicShellStatusV3,
  listPublicRepacksV3,
  searchPublicCollectiblesV3,
} from "./publicRepacksV3";
import {
  establishAccess,
  getGateStatus,
  getMyAccess,
} from "./productUserAccess";
import { getMyStanding } from "./productUsers";
import {
  getOwnerWatchlist,
  getSavedItemIds,
  setSavedCollectible,
  setSavedRepack,
} from "./savedItems";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

type RuntimeIndex = Readonly<{
  indexDescriptor: string;
  fields: readonly string[];
}>;

type RuntimeSearchIndex = Readonly<{
  indexDescriptor: string;
  searchField: string;
  filterFields: readonly string[];
}>;

type RuntimeTable = Readonly<{
  indexes: readonly RuntimeIndex[];
  searchIndexes: readonly RuntimeSearchIndex[];
  validator: Readonly<{ fields?: Readonly<Record<string, unknown>> }>;
}>;

type SchemaRequirement = Readonly<{
  fields: readonly string[];
  indexes: readonly string[];
  searchIndexes?: readonly string[];
}>;

const runtimeTables = (
  schema as unknown as Readonly<{ tables: Readonly<Record<string, RuntimeTable>> }>
).tables;

const ADMIN_DIRECTORY_AND_SAVED_ITEM_SCHEMA = {
  productUsers: {
    fields: [
      "subject",
      "authMethod",
      "email",
      "walletAddress",
      "walletAddressKey",
      "firstSeenAt",
      "lastSeenAt",
      "standing",
      "access",
      "welcome",
    ],
    indexes: [
      "by_subject:subject",
      "by_last_seen_at:lastSeenAt",
      "by_email:email",
      "by_wallet_address_key:walletAddressKey",
      "by_access_state_and_access_decided_at:access.state,access.decidedAt",
      "by_welcome_state_and_welcome_claim_expires_at:welcome.state,welcome.claimExpiresAt",
    ],
  },
  betaAllowlistEntries: {
    fields: [
      "email",
      "walletAddress",
      "walletAddressKey",
      "label",
      "createdAt",
      "updatedAt",
      "createdByOperatorId",
    ],
    indexes: [
      "by_email:email",
      "by_wallet_address_key:walletAddressKey",
      "by_updated_at:updatedAt",
    ],
  },
  savedRepacks: {
    fields: ["ownerTokenIdentifier", "publicRepackId"],
    indexes: [
      "by_owner_token_identifier_and_public_repack_id:ownerTokenIdentifier,publicRepackId",
    ],
  },
  savedCollectibles: {
    fields: ["ownerTokenIdentifier", "publicCollectibleId"],
    indexes: [
      "by_owner_token_identifier_and_public_collectible_id:ownerTokenIdentifier,publicCollectibleId",
    ],
  },
} as const satisfies Readonly<Record<string, SchemaRequirement>>;

const PROVIDER_CATALOG_SCHEMA = {
  providerCatalogCompletedHeads: {
    fields: [
      "platformKey",
      "releaseId",
      "publicProviderReleaseId",
      "sharedConfigurationEpoch",
      "providerCheckpoint",
      "observation",
      "terminalReceiptSha256",
    ],
    indexes: ["by_platform_key:platformKey"],
  },
  providerCatalogReleases: {
    fields: [
      "platformKey",
      "publicProviderReleaseId",
      "lifecycle",
      "sharedConfigurationEpoch",
      "providerReleaseFingerprint",
      "governingHashes",
      "entityHashes",
      "counts",
      "completionReceiptSha256",
      "retentionEligibleAt",
    ],
    indexes: [
      "by_public_provider_release_id:publicProviderReleaseId",
      "by_platform_key_and_public_provider_release_id:platformKey,publicProviderReleaseId",
      "by_platform_key_and_provider_release_fingerprint:platformKey,providerReleaseFingerprint",
      "by_platform_key_and_lifecycle_and_retention_eligible_at:platformKey,lifecycle,retentionEligibleAt",
      "by_platform_lifecycle_retention_public_id:platformKey,lifecycle,retentionEligibleAt,publicProviderReleaseId",
      "by_lifecycle_and_retention_eligible_at:lifecycle,retentionEligibleAt",
    ],
  },
  providerCatalogReleaseCompletionProofs: {
    fields: [
      "releaseId",
      "operationId",
      "providerReleaseFingerprint",
      "terminalReceiptSha256",
      "immutableProofSha256",
    ],
    indexes: ["by_release_id:releaseId", "by_operation_id:operationId"],
  },
  providerCatalogTerminalReceiptProofs: {
    fields: [
      "releaseId",
      "operationId",
      "operationKind",
      "requestDigest",
      "terminalReceiptSha256",
    ],
    indexes: ["by_release_id:releaseId", "by_operation_id:operationId"],
  },
  providerCatalogPublications: {
    fields: [
      "platformKey",
      "publicProviderReleaseId",
      "releaseId",
      "providerCheckpoint",
      "expectedCounts",
      "acceptedCounts",
      "acceptedEntityHashes",
      "state",
    ],
    indexes: [
      "by_public_provider_release_id:publicProviderReleaseId",
      "by_release_id:releaseId",
      "by_platform_key_and_state:platformKey,state",
    ],
  },
  providerCatalogRepackReconciliation: {
    fields: [
      "releaseId",
      "repackId",
      "publicRepackId",
      "expectedChaseCount",
      "acceptedChaseCount",
      "acceptedTopChaseCount",
      "complete",
    ],
    indexes: [
      "by_release_id_and_public_repack_id:releaseId,publicRepackId",
      "by_release_id:releaseId",
    ],
  },
  providerCatalogCollectibleReconciliation: {
    fields: ["releaseId", "collectibleId", "publicCollectibleId", "chaseCount"],
    indexes: [
      "by_release_id_and_public_collectible_id:releaseId,publicCollectibleId",
      "by_release_id:releaseId",
    ],
  },
  providerCatalogVendors: {
    fields: ["releaseId", "publicVendorId", "vendorKey", "detail"],
    indexes: [
      "by_release_id_and_public_vendor_id:releaseId,publicVendorId",
      "by_release_id_and_vendor_key:releaseId,vendorKey",
    ],
  },
  providerCatalogCategories: {
    fields: [
      "releaseId",
      "publicCategoryId",
      "categoryKey",
      "parentCategoryId",
      "detail",
    ],
    indexes: [
      "by_release_id_and_public_category_id:releaseId,publicCategoryId",
      "by_release_id_and_category_key:releaseId,categoryKey",
      "by_release_id_and_parent_category_id:releaseId,parentCategoryId",
    ],
  },
  providerCatalogRepacks: {
    fields: ["releaseId", "publicRepackId", "vendorId", "detail"],
    indexes: [
      "by_release_id_and_public_repack_id:releaseId,publicRepackId",
      "by_release_id_and_vendor_id:releaseId,vendorId",
    ],
  },
  providerCatalogCollectibles: {
    fields: [
      "releaseId",
      "publicCollectibleId",
      "collectibleType",
      "normalizedName",
      "searchText",
      "detail",
    ],
    indexes: [
      "by_release_id_and_public_collectible_id:releaseId,publicCollectibleId",
      "by_release_id_and_normalized_name:releaseId,normalizedName",
    ],
    searchIndexes: [
      "search_search_text:searchText:releaseId,collectibleType",
    ],
  },
  providerCatalogRepackChases: {
    fields: ["releaseId", "repackId", "collectibleId", "detail"],
    indexes: [
      "by_release_id_and_repack_id:releaseId,repackId",
      "by_release_id_and_collectible_id:releaseId,collectibleId",
      "by_release_id_and_repack_id_and_collectible_id:releaseId,repackId,collectibleId",
    ],
  },
  providerCatalogSearchShards: {
    fields: [
      "releaseId",
      "shardNumber",
      "rowCount",
      "byteCount",
      "contentHash",
      "rows",
    ],
    indexes: ["by_release_id_and_shard_number:releaseId,shardNumber"],
  },
  providerCatalogSearchShardProofs: {
    fields: ["releaseId", "shardNumber", "rowCount", "byteCount", "contentHash"],
    indexes: ["by_release_id_and_shard_number:releaseId,shardNumber"],
  },
  providerCatalogBatches: {
    fields: [
      "releaseId",
      "batchIndex",
      "kind",
      "idempotencyKey",
      "batchHash",
      "chainHash",
      "entityHash",
    ],
    indexes: [
      "by_release_id_and_batch_index:releaseId,batchIndex",
      "by_kind_and_idempotency_key:kind,idempotencyKey",
    ],
  },
  providerCatalogOperations: {
    fields: [
      "operationId",
      "kind",
      "idempotencyKey",
      "bodyHash",
      "platformKey",
      "publicProviderReleaseId",
      "confirmationReceiptHash",
      "receiptJson",
    ],
    indexes: [
      "by_operation_id:operationId",
      "by_kind_and_idempotency_key:kind,idempotencyKey",
      "by_platform_key_and_public_provider_release_id_and_kind:platformKey,publicProviderReleaseId,kind",
      "by_completed_at:completedAt",
    ],
  },
  providerCatalogReleaseBlocks: {
    fields: [
      "platformKey",
      "providerReleaseFingerprint",
      "blockSequence",
      "terminalReceiptSha256",
    ],
    indexes: [
      "by_platform_key_and_provider_release_fingerprint:platformKey,providerReleaseFingerprint",
    ],
  },
} as const satisfies Readonly<Record<string, SchemaRequirement>>;

const GLOBAL_MANIFEST_SCHEMA = {
  globalCatalogManifests: {
    fields: [
      "publicReleaseId",
      "manifestFingerprint",
      "providerReferenceSetHash",
      "manifest",
      "providerReleaseIds",
      "lifecycle",
      "retentionEligibleAt",
    ],
    indexes: [
      "by_public_release_id:publicReleaseId",
      "by_manifest_fingerprint:manifestFingerprint",
      "by_lifecycle_and_retention_eligible_at:lifecycle,retentionEligibleAt",
      "by_lifecycle_and_retention_eligible_at_and_public_release_id:lifecycle,retentionEligibleAt,publicReleaseId",
    ],
  },
  catalogManifestProviderReferences: {
    fields: [
      "manifestId",
      "manifestPublicReleaseId",
      "manifestFingerprint",
      "releaseId",
      "platformKey",
      "publicProviderReleaseId",
      "providerReleaseFingerprint",
    ],
    indexes: [
      "by_manifest_id_and_platform_key:manifestId,platformKey",
      "by_manifest_public_release_id_and_platform_key:manifestPublicReleaseId,platformKey",
      "by_release_id_and_manifest_id:releaseId,manifestId",
      "by_platform_key_and_release_id:platformKey,releaseId",
      "by_platform_key_and_public_provider_release_id:platformKey,publicProviderReleaseId",
    ],
  },
  activeCatalogManifestState: {
    fields: [
      "key",
      "generation",
      "activeManifestId",
      "previousManifestId",
      "activeManifest",
      "previousManifest",
      "observation",
      "terminalReceiptSha256",
    ],
    indexes: ["by_key:key"],
  },
  catalogManifestOperations: {
    fields: [
      "operationId",
      "kind",
      "idempotencyKey",
      "publicReleaseId",
      "manifestFingerprint",
      "confirmationReceiptHash",
      "terminalReceiptSha256",
      "receiptJson",
    ],
    indexes: [
      "by_operation_id:operationId",
      "by_kind_and_idempotency_key:kind,idempotencyKey",
      "by_public_release_id_and_kind:publicReleaseId,kind",
      "by_completed_at:completedAt",
    ],
  },
  catalogManifestBlocks: {
    fields: [
      "publicReleaseId",
      "manifestFingerprint",
      "blockSequence",
      "terminalReceiptSha256",
    ],
    indexes: [
      "by_manifest_fingerprint:manifestFingerprint",
      "by_public_release_id:publicReleaseId",
    ],
  },
  catalogRetentionState: {
    fields: [
      "key",
      "generation",
      "referenceAuditSnapshotDigest",
      "referenceAuditPhase",
      "referenceAuditCursor",
      "referenceAuditComplete",
      "manifestPhaseComplete",
    ],
    indexes: ["by_key:key"],
  },
  catalogRetentionOperations: {
    fields: [
      "operationId",
      "kind",
      "idempotencyKey",
      "phase",
      "expectedGeneration",
      "resultGeneration",
      "receiptDigest",
      "terminalReceiptSha256",
      "expiresAt",
    ],
    indexes: [
      "by_operation_id:operationId",
      "by_kind_and_idempotency_key:kind,idempotencyKey",
      "by_completed_at:completedAt",
      "by_expires_at:expiresAt",
    ],
  },
  dataReleaseAuthNonces: {
    fields: ["keyId", "nonceHash", "requestDigest", "acceptedAt", "expiresAt"],
    indexes: [
      "by_key_id_and_nonce_hash:keyId,nonceHash",
      "by_expires_at:expiresAt",
    ],
  },
} as const satisfies Readonly<Record<string, SchemaRequirement>>;

const DATA_RELEASE_V3_SCHEMA = {
  dataReleaseV3Releases: {
    fields: [
      "publicReleaseId",
      "releaseFingerprint",
      "lifecycle",
      "methodVersion",
      "confidencePolicyVersion",
      "publicEvPolicyVersion",
      "dataAsOf",
      "contentHash",
      "expectedCounts",
      "expectedEntityChainHashes",
      "acceptedCounts",
      "acceptedEntityChainHashes",
      "acceptedVerifiedTopChaseCount",
      "acceptedSearchRowSetHash",
    ],
    indexes: [
      "by_public_release_id:publicReleaseId",
      "by_release_fingerprint:releaseFingerprint",
      "by_lifecycle:lifecycle",
    ],
  },
  dataReleaseV3Categories: {
    fields: ["releaseId", "publicCategoryId", "detail"],
    indexes: [
      "by_release_id_and_public_category_id:releaseId,publicCategoryId",
    ],
  },
  dataReleaseV3Collectibles: {
    fields: [
      "releaseId",
      "publicCollectibleId",
      "collectibleType",
      "normalizedName",
      "searchText",
      "detail",
    ],
    indexes: [
      "by_release_id_and_public_collectible_id:releaseId,publicCollectibleId",
    ],
    searchIndexes: [
      "search_search_text:searchText:releaseId,collectibleType",
    ],
  },
  dataReleaseV3Repacks: {
    fields: ["releaseId", "publicRepackId", "detail"],
    indexes: ["by_release_id_and_public_repack_id:releaseId,publicRepackId"],
  },
  dataReleaseV3Chases: {
    fields: ["releaseId", "publicRepackId", "publicCollectibleId", "detail"],
    indexes: [
      "by_release_id_and_public_repack_id_and_public_collectible_id:releaseId,publicRepackId,publicCollectibleId",
      "by_release_id_and_public_collectible_id:releaseId,publicCollectibleId",
    ],
  },
  dataReleaseV3SearchShards: {
    fields: ["releaseId", "shardNumber", "rowCount", "contentHash", "rows"],
    indexes: ["by_release_id_and_shard_number:releaseId,shardNumber"],
  },
  dataReleaseV3Operations: {
    fields: [
      "operationId",
      "kind",
      "idempotencyKey",
      "bodyHash",
      "publicReleaseId",
      "receiptDigest",
      "receiptJson",
    ],
    indexes: [
      "by_operation_id:operationId",
      "by_kind_and_idempotency_key:kind,idempotencyKey",
    ],
  },
  activeDataReleaseV3State: {
    fields: [
      "key",
      "generation",
      "activeReleaseId",
      "previousReleaseId",
      "activeRelease",
      "previousRelease",
      "terminalOperationId",
    ],
    indexes: ["by_key:key"],
  },
} as const satisfies Readonly<Record<string, SchemaRequirement>>;

const ADMIN_DIRECTORY_PATHS = [
  "/admin/product-users/list",
  "/admin/product-users/record",
  "/admin/product-users/saved-items",
  "/admin/product-users/standing",
  "/admin/product-users/access/approve",
  "/admin/product-users/access/decline",
  "/admin/product-users/access/revoke",
  "/admin/product-users/access/queue",
  "/admin/product-users/access/queue-count",
  "/admin/product-users/welcome/claim",
  "/admin/product-users/welcome/settle",
  "/admin/beta-allowlist/list",
  "/admin/beta-allowlist/create",
  "/admin/beta-allowlist/update",
  "/admin/beta-allowlist/remove",
  "/admin/provider-catalog/active-release",
  "/admin/provider-catalog/entities",
  "/admin/provider-catalog/entity-ids",
  "/admin/provider-catalog/document",
  "/admin/provider-catalog/chase-reconciliation",
] as const;

function databaseIndexSignatures(table: RuntimeTable): readonly string[] {
  return table.indexes.map(
    ({ indexDescriptor, fields }) => `${indexDescriptor}:${fields.join(",")}`,
  );
}

function searchIndexSignatures(table: RuntimeTable): readonly string[] {
  return table.searchIndexes.map(
    ({ indexDescriptor, searchField, filterFields }) =>
      `${indexDescriptor}:${searchField}:${filterFields.join(",")}`,
  );
}

function expectSchemaSurface(
  expected: Readonly<Record<string, SchemaRequirement>>,
): void {
  for (const [tableName, requirement] of Object.entries(expected)) {
    const table = runtimeTables[tableName];
    expect(table, `${tableName} must remain in the active Convex schema`).toBeDefined();
    if (table === undefined) continue;
    expect(Object.keys(table.validator.fields ?? {})).toEqual(
      expect.arrayContaining([...requirement.fields]),
    );
    expect(databaseIndexSignatures(table)).toEqual(
      expect.arrayContaining([...requirement.indexes]),
    );
    if (requirement.searchIndexes !== undefined) {
      expect(searchIndexSignatures(table)).toEqual(
        expect.arrayContaining([...requirement.searchIndexes]),
      );
    }
  }
}

describe("the authoritative Convex schema remains available to current clients", () => {
  test("keeps the product-user, beta-allowlist, and durable saved-item contract", () => {
    expectSchemaSurface(ADMIN_DIRECTORY_AND_SAVED_ITEM_SCHEMA);
  });

  test("keeps provider releases, publication proofs, and reconciliation", () => {
    expectSchemaSurface(PROVIDER_CATALOG_SCHEMA);
  });

  test("keeps global manifests, retention roots, and publication nonce state", () => {
    expectSchemaSurface(GLOBAL_MANIFEST_SCHEMA);
  });

  test("keeps the complete Data Release V3 graph and active pointer", () => {
    expectSchemaSurface(DATA_RELEASE_V3_SCHEMA);
  });
});

test("current product-user, saved-item, and Data Release V3 functions remain exported", () => {
  for (const entryPoint of [
    establishAccess,
    getMyAccess,
    getGateStatus,
    getMyStanding,
    getSavedItemIds,
    getOwnerWatchlist,
    setSavedRepack,
    setSavedCollectible,
    getPublicShellStatusV3,
    getDashboardBundleV3,
    listPublicRepacksV3,
    getPublicRepackV3,
    searchPublicCollectiblesV3,
    findRepacksByDesiredCollectibleV3,
  ]) {
    expect(entryPoint).toBeDefined();
  }
});

test("current admin and signed publication HTTP endpoints stay mounted and protected", async () => {
  const convex = convexTest({ schema, modules, transactionLimits: true });
  const paths = new Set<string>([
    ...ADMIN_DIRECTORY_PATHS,
    ...Object.values(PRODUCTION_PROVIDER_RELEASE_PATHS),
    ...Object.values(PRODUCTION_CATALOG_MANIFEST_PATHS),
    ...Object.values(PRODUCTION_CATALOG_RETENTION_PATHS),
    ...Object.values(PRODUCTION_DATA_RELEASE_V3_PATHS),
  ]);

  for (const path of paths) {
    const response = await convex.fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect({ path, status: response.status }).toEqual({ path, status: 401 });
  }
});

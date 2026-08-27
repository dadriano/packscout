import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSyntheticDataReleaseV2,
  SYNTHETIC_FOCUSED_REPACK_ID,
  SYNTHETIC_VENDOR_ID,
} from "./__fixtures__/data-release-v2.fixture.ts";
import {
  publishedActiveReleaseSchema,
  publishedInspectableEntityKinds,
  publishedProviderChaseReconciliationSchema,
  publishedProviderDocumentSchemaForKind,
  publishedProviderEntityPageSchemaForKind,
} from "./data-inspection.ts";

const RELEASE_ID = "10000000-0000-5000-8000-000000000001";
const MANIFEST_ID = "10000000-0000-5000-8000-000000000002";
const HASH = "a".repeat(64);

function releaseFacts() {
  return {
    publicProviderReleaseId: RELEASE_ID,
    platformKey: "clutchpacks",
    lifecycle: "complete",
    dataAsOf: "2026-08-27T10:00:00.000Z",
    providerReleaseFingerprint: HASH,
    contentHash: HASH,
    entityHashes: {
      vendors: HASH,
      categories: HASH,
      collectibles: HASH,
      repacks: HASH,
      repack_chases: HASH,
      search_shards: HASH,
    },
    counts: {
      vendors: 1,
      categories: 3,
      collectibles: 2,
      repacks: 2,
      repackChases: 3,
      searchShards: 1,
    },
    batchCount: 6,
    batchChainHash: HASH,
    createdAt: "2026-08-27T10:00:00.000Z",
    completedAt: "2026-08-27T10:01:00.000Z",
    completionOperationId: "clutchpacks.finalize.1",
  };
}

test("published inspection exposes only standalone inspectable documents", () => {
  assert.deepEqual(publishedInspectableEntityKinds, [
    "vendors",
    "categories",
    "repacks",
    "collectibles",
  ]);
});

test("active release facts are strict and hash validated", () => {
  const value = {
    status: "active",
    manifestPublicReleaseId: MANIFEST_ID,
    referenceFingerprint: HASH,
    release: releaseFacts(),
  };
  assert.equal(publishedActiveReleaseSchema.safeParse(value).success, true);
  assert.equal(
    publishedActiveReleaseSchema.safeParse({ ...value, protected: true })
      .success,
    false,
  );
  assert.equal(
    publishedActiveReleaseSchema.safeParse({
      ...value,
      release: { ...value.release, contentHash: "not-a-hash" },
    }).success,
    false,
  );
});

test("entity pages validate both the selected kind and public identity", () => {
  const release = buildSyntheticDataReleaseV2();
  const vendor = release.vendors[0]!;
  const schema = publishedProviderEntityPageSchemaForKind("vendors");
  const valid = {
    status: "ok",
    items: [{ publicEntityId: SYNTHETIC_VENDOR_ID, detail: vendor }],
    isDone: true,
    continueCursor: "",
  };
  assert.equal(schema.safeParse(valid).success, true);
  assert.equal(
    schema.safeParse({
      ...valid,
      items: [{ publicEntityId: SYNTHETIC_FOCUSED_REPACK_ID, detail: release.repacks[0] }],
    }).success,
    false,
  );
  assert.equal(
    schema.safeParse({
      ...valid,
      items: [{ publicEntityId: "00000000-0000-5000-8000-000000000099", detail: vendor }],
    }).success,
    false,
  );
  assert.equal(
    schema.safeParse({
      ...valid,
      items: [{
        publicEntityId: SYNTHETIC_VENDOR_ID,
        detail: { ...vendor, organizationId: "protected" },
      }],
    }).success,
    false,
  );
});

test("document reads preserve absences and reject a mismatched kind", () => {
  const release = buildSyntheticDataReleaseV2();
  const schema = publishedProviderDocumentSchemaForKind("repacks");
  assert.equal(schema.safeParse({ status: "release_unknown" }).success, true);
  assert.equal(schema.safeParse({ status: "not_present" }).success, true);
  assert.equal(
    schema.safeParse({
      status: "ok",
      publicEntityId: SYNTHETIC_FOCUSED_REPACK_ID,
      detail: release.repacks[0],
    }).success,
    true,
  );
  assert.equal(
    schema.safeParse({
      status: "ok",
      publicEntityId: SYNTHETIC_VENDOR_ID,
      detail: release.vendors[0],
    }).success,
    false,
  );
});

test("chase reconciliation agrees with its accepted and expected counts", () => {
  assert.equal(
    publishedProviderChaseReconciliationSchema.safeParse({
      status: "ok",
      publicRepackId: SYNTHETIC_FOCUSED_REPACK_ID,
      expectedChaseCount: 3,
      acceptedChaseCount: 3,
      complete: true,
    }).success,
    true,
  );
  assert.equal(
    publishedProviderChaseReconciliationSchema.safeParse({
      status: "ok",
      publicRepackId: SYNTHETIC_FOCUSED_REPACK_ID,
      expectedChaseCount: 3,
      acceptedChaseCount: 2,
      complete: true,
    }).success,
    false,
  );
  assert.equal(
    publishedProviderChaseReconciliationSchema.safeParse({
      status: "ok",
      publicRepackId: SYNTHETIC_FOCUSED_REPACK_ID,
      expectedChaseCount: 2,
      acceptedChaseCount: 3,
      complete: false,
    }).success,
    false,
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  PROVIDER_PROMOTION_BOOTSTRAP_COUNT_LIMITS,
  PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_FRAME_BYTES,
  PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_FRAMES,
  PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_RECORDS_PER_FRAME,
  PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_STREAM_BYTES,
} from "./provider-promotion-bootstrap.ts";

const MAXIMUM_COLLECTIBLE_CORRELATION_RECORD = {
  localCollectibleId: "57000000-0000-4000-8000-000000000001",
  localEntityVersion: "9999999999999999999",
  publicCollectibleId: "56000000-0000-4000-8000-000000000001",
} as const;

const MAXIMUM_CATEGORY_CORRELATION_RECORD = {
  localCategoryId: "57000000-0000-4000-8000-000000000001",
  localEntityVersion: "9999999999999999999",
  publicCategoryId: "56000000-0000-4000-8000-000000000001",
} as const;

const MAXIMUM_CATALOG_ALIAS_RECORD = {
  aliasPublicCollectibleId: "56000000-0000-5000-8000-000000000001",
  canonicalPublicCollectibleId: "56000000-0000-5000-8000-000000000002",
} as const;

function sectionBytes(input: Readonly<{
  section: "catalogAliases" | "categoryCorrelations" |
    "collectibleCorrelations";
  record: Readonly<Record<string, string>>;
  count: number;
}>): Readonly<{ bytes: number; frames: number; maximumFrameBytes: number }> {
  const recordBytes = Buffer.byteLength(JSON.stringify(input.record), "utf8");
  let bytes = 0;
  let frames = 0;
  let maximumFrameBytes = 0;
  for (
    let offset = 0;
    offset < input.count;
    offset += PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_RECORDS_PER_FRAME
  ) {
    const recordCount = Math.min(
      PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_RECORDS_PER_FRAME,
      input.count - offset,
    );
    const emptyPageBytes = Buffer.byteLength(`${JSON.stringify({
      kind: "page",
      section: input.section,
      offset,
      records: [],
    })}\n`, "utf8");
    const frameBytes =
      emptyPageBytes + recordCount * recordBytes + recordCount - 1;
    bytes += frameBytes;
    frames += 1;
    maximumFrameBytes = Math.max(maximumFrameBytes, frameBytes);
  }
  return { bytes, frames, maximumFrameBytes };
}

test("bootstrap fixed-width limits fit the bounded frame and stream budgets", () => {
  assert.deepEqual(PROVIDER_PROMOTION_BOOTSTRAP_COUNT_LIMITS, {
    catalogCategories: 50_000,
    catalogCollectibles: 50_000,
    catalogAliases: 50_000,
    categoryCorrelations: 50_000,
    collectibleCorrelations: 50_000,
  });
  const sections = [
    sectionBytes({
      section: "catalogAliases",
      record: MAXIMUM_CATALOG_ALIAS_RECORD,
      count: PROVIDER_PROMOTION_BOOTSTRAP_COUNT_LIMITS.catalogAliases,
    }),
    sectionBytes({
      section: "categoryCorrelations",
      record: MAXIMUM_CATEGORY_CORRELATION_RECORD,
      count: PROVIDER_PROMOTION_BOOTSTRAP_COUNT_LIMITS.categoryCorrelations,
    }),
    sectionBytes({
      section: "collectibleCorrelations",
      record: MAXIMUM_COLLECTIBLE_CORRELATION_RECORD,
      count: PROVIDER_PROMOTION_BOOTSTRAP_COUNT_LIMITS.collectibleCorrelations,
    }),
  ];
  assert.ok(sections.every(({ maximumFrameBytes }) =>
    maximumFrameBytes <= PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_FRAME_BYTES));
  assert.equal(
    sections.reduce((total, section) => total + section.bytes, 0),
    23_244_862,
  );
  const completionBytes = Buffer.byteLength(`${JSON.stringify({
    kind: "complete",
    snapshotFingerprint: "f".repeat(64),
  })}\n`, "utf8");
  assert.equal(completionBytes, 109);
  assert.ok(
    sections.reduce((total, section) => total + section.bytes, 0) +
      PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_FRAME_BYTES + completionBytes <
      PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_STREAM_BYTES,
  );
  assert.ok(
    sections.reduce((total, section) => total + section.frames, 2) <=
      PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_FRAMES,
  );
});

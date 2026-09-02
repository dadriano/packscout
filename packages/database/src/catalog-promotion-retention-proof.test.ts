import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_GLOBAL_CATALOG_PROVIDER_REFERENCES,
  canonicalJson,
} from "@packscout/contracts";
import { parseCatalogPromotionRetentionPlatformKeys } from
  "./catalog-promotion-retention-proof.ts";
import { CatalogPromotionRetentionPersistenceError } from
  "./catalog-promotion-retention-types.ts";
import { promotionV2Sha256 } from "./promotion-v2-types.ts";

function platformKeys(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `provider-${index.toString().padStart(2, "0")}`,
  );
}

test("retention proof provider sets accept 9 and 64 but reject 65", () => {
  for (const count of [9, MAX_GLOBAL_CATALOG_PROVIDER_REFERENCES]) {
    const expected = platformKeys(count);
    const body = canonicalJson(expected);
    assert.deepEqual(
      parseCatalogPromotionRetentionPlatformKeys(
        body,
        promotionV2Sha256(body),
      ),
      expected,
    );
  }

  const overflow = platformKeys(MAX_GLOBAL_CATALOG_PROVIDER_REFERENCES + 1);
  const body = canonicalJson(overflow);
  assert.throws(
    () => parseCatalogPromotionRetentionPlatformKeys(
      body,
      promotionV2Sha256(body),
    ),
    (error) =>
      error instanceof CatalogPromotionRetentionPersistenceError &&
      error.code === "CATALOG_PROMOTION_RETENTION_PROOF_INCOMPLETE",
  );
});

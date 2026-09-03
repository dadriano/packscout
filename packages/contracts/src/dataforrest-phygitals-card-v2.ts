import { phygitalsCardProviderFactsV1 } from "./dataforrest-phygitals-card-v1.ts";
import type { NormalizedCardProviderFacts } from "./provider-source-facts-v1.ts";

type NativeObject = Readonly<Record<string, unknown>>;

/**
 * V2 preserves V1's chase/asset selection verbatim. Otherwise the reviewed
 * descriptive-label precedence is inventory.title before nft.name. The envelope
 * record_id remains identity, so differing labels never combine or split cards.
 * No inventory image path is evidenced; an NFT image is read only if NFT wins.
 */
export function phygitalsCardProviderFactsV2(nativeData: NativeObject): NormalizedCardProviderFacts {
  if (Object.hasOwn(nativeData, "chase") || Object.hasOwn(nativeData, "asset")) {
    return phygitalsCardProviderFactsV1(nativeData);
  }
  if (Object.hasOwn(nativeData, "inventory")) {
    const inventory = nativeData.inventory;
    const validObject = typeof inventory === "object" && inventory !== null && !Array.isArray(inventory);
    // Reuse the immutable V1 text validator, without supplying any image/money.
    return phygitalsCardProviderFactsV1({
      asset: validObject ? { name: (inventory as NativeObject).title } : inventory,
    });
  }
  if (Object.hasOwn(nativeData, "nft")) {
    // Exact observed NFT name/image fields have the same value contract as V1.
    return phygitalsCardProviderFactsV1({ asset: nativeData.nft });
  }
  return phygitalsCardProviderFactsV1(nativeData);
}

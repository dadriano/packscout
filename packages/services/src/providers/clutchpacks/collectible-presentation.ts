import type { PublicCollectible } from "@packscout/contracts";

/** Exact source label emitted by the reviewed canonical card importer. */
export const clutchpacksCollectibleValuationTypes: ReadonlyMap<
  string,
  NonNullable<PublicCollectible["valuation"]>["valuationType"]
> = new Map([["clutchpacks_formatted_current_price", "vendor_reported"]]);

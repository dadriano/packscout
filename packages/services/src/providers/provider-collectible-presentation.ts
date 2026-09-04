import { publicCollectibleSchema, type PublicCollectible } from "@packscout/contracts";
import { clutchpacksCollectibleValuationTypes } from "./clutchpacks/collectible-presentation.ts";

type PublicValuationType = NonNullable<PublicCollectible["valuation"]>["valuationType"];

const valuationTypesByPlatform: ReadonlyMap<string, ReadonlyMap<string, PublicValuationType>> =
  new Map([["clutchpacks", clutchpacksCollectibleValuationTypes]]);

/** Provider source labels require an explicit presentation mapping. */
export function publicProviderCollectibleValuationType(
  platformKey: string,
  sourceValue: string,
): PublicValuationType | null {
  const publicType = publicCollectibleSchema.shape.valuation.unwrap().shape.valuationType.safeParse(sourceValue);
  if (publicType.success) return publicType.data;
  return valuationTypesByPlatform.get(platformKey)?.get(sourceValue) ?? null;
}

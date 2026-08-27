import {
  parsedHttpsUrl,
  type ApprovedPublicPlatformConfiguration,
  type ApprovedPublicRepackIdentityMapping,
  type PublicRepackActions,
} from "@packscout/contracts";

/**
 * Projects one operator-approved listing URL into the public action shape.
 * Availability still gates purchase actions; sold-out and delayed rows never
 * expose an actionable checkout link.
 */
export function configuredPublicRepackLink(input: Readonly<{
  identity: ApprovedPublicRepackIdentityMapping;
  platform: ApprovedPublicPlatformConfiguration;
  available: boolean;
}>): NonNullable<PublicRepackActions["repackLink"]> | null {
  const listingUrl = input.identity.listingUrl ?? null;
  if (!input.available || listingUrl === null) return null;
  const listingHost = parsedHttpsUrl(listingUrl)?.host;
  if (
    listingHost === undefined ||
    !input.platform.vendor.listingHosts.includes(listingHost)
  ) {
    throw new RangeError("public_config.listing_host_not_approved");
  }
  return Object.freeze({
    listingUrl,
    listingHost,
    referralParameters: input.platform.vendor.referralParameters,
  });
}

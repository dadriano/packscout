/** Reviewed public pack routes keyed by the provider's catalog identity. */
const providerPackRoutes: ReadonlyMap<string, Readonly<{
  prefix: string;
  identityPattern: RegExp;
}>> = new Map([
  // DataForrest catalog record_id is the native Phygitals slug.
  ["phygitals", {
    prefix: "https://www.phygitals.com/repacks/",
    identityPattern: /^[a-z0-9](?:[a-z0-9-]{0,198}[a-z0-9])?$/u,
  }],
  // DataForrest catalog record_id is the native Collector Crypt machine code.
  ["collector_crypt", {
    prefix: "https://gacha.collectorcrypt.com/gacha/",
    identityPattern: /^[a-z0-9](?:[a-z0-9_-]{0,198}[a-z0-9])?$/u,
  }],
]);

/** Never interpret an identifier as a URL, query, fragment, or encoded path. */
export function providerPackListingUrl(
  providerKey: string,
  providerRecordId: string,
): string | null {
  const route = providerPackRoutes.get(providerKey);
  if (route === undefined || providerRecordId !== providerRecordId.trim() ||
      !route.identityPattern.test(providerRecordId)) return null;
  return `${route.prefix}${providerRecordId}`;
}

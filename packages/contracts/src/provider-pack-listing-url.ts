/**
 * Legacy Phygitals packs whose DataForrest catalog record_id is the platform's
 * numeric pack id rather than its slug. Their pages resolve only under the
 * slug, which the feed carries but the provider database does not retain.
 * Recorded from the DataForrest catalog on 2026-09-04; each entry's pack page
 * was loaded at phygitals.com and reported exactly this id and slug. A numeric
 * identity that is not listed yields no link, never a guessed 404.
 */
const phygitalsLegacyPackSlugs: ReadonlyMap<string, string> = new Map([
  ["13", "rookie-pack"],
  ["14", "elite-pack"],
  ["15", "legend-pack"],
  ["17", "east-blue-pack"],
  ["27", "platinum-pack"],
  ["29", "mythic-pack"],
  ["31", "platinum-football-pack"],
  ["32", "starter-football-pack"],
  ["33", "elite-football-pack"],
  ["34", "starter-baseball-pack"],
  ["35", "pro-baseball-pack"],
  ["36", "legend-baseball-pack"],
  ["37", "platinum-baseball-pack"],
  ["38", "mythic-baseball-pack"],
  ["41", "one-piece-mythic-pack"],
]);

const NUMERIC_IDENTITY_PATTERN = /^[0-9]+$/u;

/** Reviewed public pack routes keyed by the provider's catalog identity. */
const providerPackRoutes: ReadonlyMap<string, Readonly<{
  prefix: string;
  identityPattern: RegExp;
  /**
   * Route identities for catalog ids that do not route on their own. When
   * present, a purely numeric catalog id links only through this table.
   */
  legacyRouteIdentities: ReadonlyMap<string, string> | null;
}>> = new Map([
  // DataForrest catalog record_id is the native Phygitals slug, except for the
  // legacy packs whose record_id is the numeric pack id.
  ["phygitals", {
    prefix: "https://www.phygitals.com/repacks/",
    identityPattern: /^[a-z0-9](?:[a-z0-9-]{0,198}[a-z0-9])?$/u,
    legacyRouteIdentities: phygitalsLegacyPackSlugs,
  }],
  // DataForrest catalog record_id is the native Collector Crypt machine code.
  ["collector_crypt", {
    prefix: "https://gacha.collectorcrypt.com/gacha/",
    identityPattern: /^[a-z0-9](?:[a-z0-9_-]{0,198}[a-z0-9])?$/u,
    legacyRouteIdentities: null,
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
  const routeIdentity =
    route.legacyRouteIdentities !== null &&
      NUMERIC_IDENTITY_PATTERN.test(providerRecordId)
      ? route.legacyRouteIdentities.get(providerRecordId) ?? null
      : providerRecordId;
  return routeIdentity === null ? null : `${route.prefix}${routeIdentity}`;
}

/**
 * Pure planning logic for the quick provider -> data_release_v3 promotion
 * (`promote-provider-data-release-v3.mts`).
 *
 * Everything here is deterministic and dependency-injected so it can be unit
 * tested without PostgreSQL, Convex, or the TypeScript contracts: identity
 * minting, canonical hashing, and the release constants are passed in by the
 * runtime. The runtime validates every emitted entity against the real
 * `@packscout/contracts` schemas before anything is sent.
 */

export class PromoteProviderDataReleaseV3Error extends Error {
  /**
   * @param {string} code
   * @param {string | null} [detail]
   */
  constructor(code, detail = null) {
    super(detail === null ? code : `${code}: ${detail}`);
    this.name = "PromoteProviderDataReleaseV3Error";
    this.code = code;
    this.detail = detail;
  }
}

function refuse(code, detail = null) {
  throw new PromoteProviderDataReleaseV3Error(code, detail);
}

const PLATFORM_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,98}[a-z0-9])?$/u;
const CONVEX_DEPLOYMENT_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;

/**
 * The only deployments this `:local` command may write to. Dry runs and
 * snapshot exports may read any deployment; `--publish` is pinned to the
 * approved data_release_v3 canary (the same target the ClutchPacks promoter
 * pins). Adding a deployment here is a reviewed change, never a flag.
 */
export const APPROVED_PUBLISH_DEPLOYMENTS = Object.freeze(["shiny-newt-310"]);

export const PROMOTE_PROVIDER_USAGE = `Usage:
  node --import tsx scripts/local/promote-provider-data-release-v3.mts \\
    --platform <provider_key> [--platform <provider_key> ...] \\
    [--convex-deployment <name>] [--export-dir <unzipped snapshot export>] \\
    [--replace-catalog] [--include-priceless] [--publish] \\
    [--env-file <dotenv path>] [--out <directory>]

Dry run by default: reads the provider's Neon database plus the active Convex
release, assembles one whole-catalog data_release_v3 plan, validates it, and
writes plan.json + summary.json. --publish stages, finalizes, and activates it
on an approved deployment only (${APPROVED_PUBLISH_DEPLOYMENTS.join(", ")}).`;

export function parsePromoteProviderArguments(
  argv,
  { approvedPublishDeployments = APPROVED_PUBLISH_DEPLOYMENTS } = {},
) {
  const options = {
    platformKeys: [],
    convexDeployment: null,
    exportDir: null,
    replaceCatalog: false,
    includePriceless: false,
    publish: false,
    envFile: null,
    outDir: null,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        refuse("ARGUMENT_VALUE_MISSING", flag);
      }
      index += 1;
      return next;
    };
    switch (flag) {
      case "--platform": {
        const key = value();
        if (!PLATFORM_KEY_PATTERN.test(key)) refuse("PLATFORM_KEY_INVALID", key);
        if (!options.platformKeys.includes(key)) options.platformKeys.push(key);
        break;
      }
      case "--convex-deployment": {
        const name = value();
        if (!CONVEX_DEPLOYMENT_PATTERN.test(name)) {
          refuse("CONVEX_DEPLOYMENT_INVALID", name);
        }
        options.convexDeployment = name;
        break;
      }
      case "--export-dir":
        options.exportDir = value();
        break;
      case "--env-file":
        options.envFile = value();
        break;
      case "--out":
        options.outDir = value();
        break;
      case "--replace-catalog":
        options.replaceCatalog = true;
        break;
      case "--include-priceless":
        options.includePriceless = true;
        break;
      case "--publish":
        options.publish = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        refuse("ARGUMENT_UNKNOWN", flag);
    }
  }
  if (options.help) return options;
  if (options.platformKeys.length === 0) refuse("PLATFORM_REQUIRED");
  if (options.publish && options.convexDeployment === null) {
    refuse("CONVEX_DEPLOYMENT_REQUIRED", "--publish needs --convex-deployment");
  }
  if (
    options.publish &&
    !approvedPublishDeployments.includes(options.convexDeployment)
  ) {
    refuse(
      "PUBLISH_TARGET_NOT_APPROVED",
      `${options.convexDeployment} is not an approved data_release_v3 publish target ` +
        `(approved: ${approvedPublishDeployments.join(", ")}); extend ` +
        "APPROVED_PUBLISH_DEPLOYMENTS through review instead of retargeting",
    );
  }
  if (
    !options.replaceCatalog &&
    options.exportDir === null &&
    options.convexDeployment === null
  ) {
    refuse(
      "CONVEX_DEPLOYMENT_REQUIRED",
      "carrying the active catalog forward needs --convex-deployment or --export-dir",
    );
  }
  return options;
}

// ---------------------------------------------------------------------------
// Value mapping
// ---------------------------------------------------------------------------

const DISPLAY_CURRENCY_PATTERN = /^[A-Z]{3}$/u;
const REPORTED_CURRENCY_PATTERN = /^[A-Z0-9]{2,12}$/u;

const DECIMAL_TEXT_PATTERN = /^(-)?(\d+)(?:\.(\d+))?$/u;

/**
 * Exact decimal scaling: PostgreSQL numeric(38,18) arrives as text, so the
 * value is scaled by string arithmetic (round half up at the cut) instead of
 * through binary floating point. Returns null for anything that is not a
 * finite non-negative decimal.
 */
export function scaledDecimal(value, decimals) {
  if (value === null || value === undefined) return null;
  const text = typeof value === "number" ? value.toString() : String(value).trim();
  const match = DECIMAL_TEXT_PATTERN.exec(text);
  if (match === null) return null;
  const [, sign, integer, fraction = ""] = match;
  if (sign === "-") return null;
  const kept = fraction.slice(0, decimals).padEnd(decimals, "0");
  const roundUp = (fraction.charCodeAt(decimals) || 48) >= 53; // next digit >= "5"
  let scaled = BigInt(integer + kept) + (roundUp ? 1n : 0n);
  if (scaled > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(scaled);
}

/** Decimal text (or number) -> non-negative integer minor units, else null. */
export function minorUnitsFromDecimal(value) {
  return scaledDecimal(value, 2);
}

export function basisPointsFromRate(value) {
  const basisPoints = scaledDecimal(value, 4);
  return basisPoints !== null && basisPoints <= 10_000 ? basisPoints : null;
}

export function canonicalTimestamp(value) {
  if (value === null || value === undefined) return null;
  const milliseconds =
    value instanceof Date ? value.getTime() : Date.parse(String(value));
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds).toISOString();
}

/** Trimmed, non-blank text bounded to `maximum` characters, else null. */
export function boundedText(value, maximum) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length <= maximum) return trimmed;
  const cut = trimmed.slice(0, maximum).trim();
  return cut.length === 0 ? null : cut;
}

export function parsedHttpsUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    return null;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * Public price from the provider row. The vendor's own money is the display
 * money whenever its currency is a three-letter code; the USD comparison is
 * the normalized USD amount, or the display money itself when that is USD.
 * A known non-USD price without a USD normalization is CURRENCY_UNSUPPORTED
 * (still displayed); no price at all is PRICE_UNAVAILABLE.
 */
export function publicPriceFromPack(pack) {
  const currency =
    typeof pack.price_currency === "string" &&
    DISPLAY_CURRENCY_PATTERN.test(pack.price_currency)
      ? pack.price_currency
      : null;
  const sourceMinor = minorUnitsFromDecimal(pack.price_amount);
  let usdMinor = minorUnitsFromDecimal(pack.price_usd_amount);
  if (currency === "USD" && sourceMinor !== null && usdMinor === null) {
    usdMinor = sourceMinor;
  }
  const displayMoney =
    currency === null
      ? null
      : currency === "USD"
        ? usdMinor === null
          ? null
          : { minorUnits: usdMinor, currency }
        : sourceMinor === null
          ? null
          : { minorUnits: sourceMinor, currency };
  if (usdMinor !== null) {
    return {
      displayMoney,
      usdComparison: {
        status: "available",
        value: { minorUnits: usdMinor, currency: "USD" },
      },
    };
  }
  return {
    displayMoney,
    usdComparison: {
      status: "unavailable",
      value: null,
      reason: displayMoney === null ? "PRICE_UNAVAILABLE" : "CURRENCY_UNSUPPORTED",
    },
  };
}

/**
 * Buyback summary: a documented rate is uniform; an absent rate is the
 * documented "not documented" state (as the production adapter publishes);
 * a present but out-of-range rate is unavailable.
 */
export function publicBuybackFromPack(pack) {
  if (pack.buyback_rate === null || pack.buyback_rate === undefined) {
    return { kind: "not_documented" };
  }
  const rateBasisPoints = basisPointsFromRate(pack.buyback_rate);
  return rateBasisPoints === null
    ? { kind: "unavailable" }
    : { kind: "uniform_rate", rateBasisPoints };
}

export function vendorReportedEvFromPack(pack) {
  const minorUnits = minorUnitsFromDecimal(pack.vendor_ev_amount);
  const currency =
    typeof pack.vendor_ev_currency === "string" &&
    REPORTED_CURRENCY_PATTERN.test(pack.vendor_ev_currency)
      ? pack.vendor_ev_currency
      : null;
  const observedAt =
    canonicalTimestamp(pack.vendor_ev_observed_at) ??
    canonicalTimestamp(pack.source_updated_at);
  if (minorUnits === null || currency === null || observedAt === null) {
    return {
      status: "unavailable",
      sourceMoney: null,
      usdComparison: null,
      observedAt: null,
      reason: "NOT_REPORTED",
    };
  }
  return {
    status: "available",
    sourceMoney: { minorUnits, currency },
    usdComparison:
      currency === "USD"
        ? { status: "available", value: { minorUnits, currency: "USD" } }
        : { status: "unavailable", value: null, reason: "CURRENCY_UNSUPPORTED" },
    observedAt,
  };
}

/**
 * Mirrors `composePackScoutPublicEv` for a product with no publication-eligible
 * revision: nothing in the provider database is a PackScout calculation, so the
 * estimate is an explicit unknown-time unavailable state stamped at the release
 * read clock.
 */
export function unavailablePackScoutEv(readAt, versions) {
  return {
    status: "unavailable",
    methodVersion: versions.methodVersion,
    confidencePolicyVersion: versions.confidencePolicyVersion,
    metrics: null,
    confidence: null,
    calculatedAt: readAt,
    dataAsOf: { state: "unknown_source_time", observedAt: null },
    reason: "SOURCE_EVIDENCE_UNAVAILABLE",
  };
}

export function publicImageFromPack(pack) {
  const url = parsedHttpsUrl(pack.primary_image_url);
  if (url === null) return null;
  const alt =
    boundedText(pack.primary_image_alt, 200) ?? boundedText(pack.display_name, 200);
  return alt === null ? null : { url: pack.primary_image_url, alt };
}

export function publicAvailabilityFromPack(pack) {
  return pack.availability === "available" ||
    pack.availability === "sold_out" ||
    pack.availability === "unavailable"
    ? pack.availability
    : "unknown";
}

/** Reuse reviewed catalog identities to restore links on existing canonical rows. */
export function withProviderPackListingUrls(platformKey, packs, resolveListingUrl) {
  return packs.map((pack) => ({
    ...pack,
    listing_url: pack.listing_url ?? (
      typeof pack.pack_key === "string" && pack.pack_key.startsWith("pack:")
        ? resolveListingUrl(platformKey, pack.pack_key.slice(5))
        : null
    ),
  }));
}

export function publicActionsFromPack(pack, availability) {
  const url = parsedHttpsUrl(pack.listing_url);
  if (availability !== "available" || url === null) return {};
  return {
    repackLink: {
      listingUrl: pack.listing_url,
      listingHost: url.host.toLowerCase(),
      referralParameters: [],
    },
  };
}

const PROVIDER_COLLECTIBLE_TYPES = new Map([
  ["card", "card"],
  ["watch", "watch"],
  ["coin", "coin"],
  ["sealed_product", "sealed_product"],
  ["memorabilia", "memorabilia"],
  ["art", "other"],
  ["other", "other"],
]);

/**
 * Collectible types to stamp on every pack of a provider. No pack contents
 * are published, so the only honest per-pack claim is the one that holds for
 * the whole provider: a single provider-wide type is asserted, a mixed
 * provider yields an empty (unknown) list rather than tagging every pack with
 * types it may not contain.
 */
export function publicCollectibleTypes(providerTypes) {
  const mapped = new Set();
  for (const type of providerTypes ?? []) {
    mapped.add(PROVIDER_COLLECTIBLE_TYPES.get(type) ?? "other");
  }
  return mapped.size === 1 ? [...mapped] : [];
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/**
 * Provider category display names are free text ("pokemon", "yugioh",
 * "football"). This map lands the common ones on the public taxonomy the live
 * catalog already uses (verticals `sports` / `trading-card-games`). Anything
 * else becomes a root-level `other` category keyed by its slug.
 */
export const CATEGORY_ALIASES = Object.freeze({
  football: { key: "football", name: "Football", parentKey: "sports", kind: "sport" },
  basketball: { key: "basketball", name: "Basketball", parentKey: "sports", kind: "sport" },
  baseball: { key: "baseball", name: "Baseball", parentKey: "sports", kind: "sport" },
  soccer: { key: "soccer", name: "Soccer", parentKey: "sports", kind: "sport" },
  hockey: { key: "hockey", name: "Hockey", parentKey: "sports", kind: "sport" },
  multisport: { key: "multi-sport", name: "Multi-sport", parentKey: "sports", kind: "other" },
  "multi-sport": { key: "multi-sport", name: "Multi-sport", parentKey: "sports", kind: "other" },
  sports: { key: "sports", name: "Sports", parentKey: null, kind: "vertical" },
  pokemon: { key: "pokemon", name: "Pokémon", parentKey: "trading-card-games", kind: "franchise" },
  yugioh: { key: "yu-gi-oh", name: "Yu-Gi-Oh!", parentKey: "trading-card-games", kind: "franchise" },
  "yu-gi-oh": { key: "yu-gi-oh", name: "Yu-Gi-Oh!", parentKey: "trading-card-games", kind: "franchise" },
  "one-piece": { key: "one-piece", name: "One Piece", parentKey: "trading-card-games", kind: "franchise" },
  onepiece: { key: "one-piece", name: "One Piece", parentKey: "trading-card-games", kind: "franchise" },
  marvel: { key: "marvel", name: "Marvel", parentKey: "trading-card-games", kind: "franchise" },
  tcg: { key: "trading-card-games", name: "Trading card games", parentKey: null, kind: "vertical" },
  "trading-card-games": { key: "trading-card-games", name: "Trading card games", parentKey: null, kind: "vertical" },
});

export function categorySlug(displayName) {
  const slug = String(displayName ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return slug.length === 0 ? null : slug.slice(0, 100).replace(/-+$/u, "");
}

function titleCase(value) {
  return String(value)
    .trim()
    .split(/\s+/u)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Resolves provider categories against the carried public taxonomy. Existing
 * public categories are reused by key; missing ones (and any missing alias
 * parent) are minted deterministically from the public identity namespace.
 *
 * Returns the full public category list for the release plus a lookup from
 * provider category id to the public category ids of its ancestor chain.
 */
export function resolvePublicCategories({
  providerCategories,
  carriedCategories,
  identity,
}) {
  const byKey = new Map();
  const byId = new Map();
  for (const category of carriedCategories) {
    byKey.set(category.categoryKey, category);
    byId.set(category.publicCategoryId, category);
  }
  let nextDisplayOrder =
    carriedCategories.reduce((max, { displayOrder }) => Math.max(max, displayOrder), -1) + 1;
  const minted = [];

  const ensure = (spec) => {
    const existing = byKey.get(spec.key);
    if (existing !== undefined) return existing;
    const parent = spec.parentKey === null ? null : ensure(aliasFor(spec.parentKey));
    const publicCategoryId = identity(`category:${spec.key}`);
    if (byId.has(publicCategoryId)) refuse("CATEGORY_IDENTITY_COLLISION", spec.key);
    const category = {
      publicCategoryId,
      parentPublicCategoryId: parent === null ? null : parent.publicCategoryId,
      categoryKey: spec.key,
      name: spec.name,
      kind: spec.kind,
      depth: parent === null ? 0 : parent.depth + 1,
      pathPublicCategoryIds:
        parent === null
          ? [publicCategoryId]
          : [...parent.pathPublicCategoryIds, publicCategoryId],
      displayOrder: nextDisplayOrder,
    };
    nextDisplayOrder += 1;
    byKey.set(category.categoryKey, category);
    byId.set(category.publicCategoryId, category);
    minted.push(category);
    return category;
  };

  const aliasFor = (rawName) => {
    const slug = categorySlug(rawName);
    if (slug === null) return null;
    const alias = CATEGORY_ALIASES[slug];
    if (alias !== undefined) return alias;
    return { key: slug, name: titleCase(rawName), parentKey: null, kind: "other" };
  };

  const chainByProviderCategoryId = new Map();
  for (const providerCategory of providerCategories) {
    const spec = aliasFor(providerCategory.display_name);
    if (spec === null) continue;
    const category = ensure(spec);
    chainByProviderCategoryId.set(
      providerCategory.id,
      category.pathPublicCategoryIds.map((id) => byId.get(id)),
    );
  }
  return {
    categories: [...byId.values()],
    minted,
    chainByProviderCategoryId,
  };
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export function repackDetailFromPack({
  pack,
  platform,
  readAt,
  versions,
  identity,
  categoryChain,
  collectibleTypes,
}) {
  const name = boundedText(pack.display_name, 200);
  if (name === null) refuse("PACK_NAME_MISSING", pack.pack_key);
  const sourceUpdatedAt = canonicalTimestamp(pack.source_updated_at);
  if (sourceUpdatedAt === null) refuse("PACK_SOURCE_TIME_MISSING", pack.pack_key);
  const availability = publicAvailabilityFromPack(pack);
  const actions = publicActionsFromPack(pack, availability);
  const categories = [...categoryChain]
    .map((category) => ({
      publicCategoryId: category.publicCategoryId,
      label: category.name,
    }))
    .sort((left, right) => (left.publicCategoryId < right.publicCategoryId ? -1 : 1));
  const evidence = pack.content_evidence;
  return {
    publicRepackId: identity(`repack:${platform.platformKey}:${pack.pack_key}`),
    publicVendorId: platform.publicVendorId,
    vendorKey: platform.platformKey,
    vendorDisplayName: platform.displayName,
    vendorLogoUrl: platform.logoUrl,
    name,
    format: pack.pack_format === "gacha" ? "gacha" : "repack",
    contentMode: "unknown",
    categories,
    collectibleTypes,
    availability,
    price: publicPriceFromPack(pack),
    buyback: publicBuybackFromPack(pack),
    primaryImage: publicImageFromPack(pack),
    evEstimates: {
      packScout: unavailablePackScoutEv(readAt, versions),
      vendorReported: vendorReportedEvFromPack(pack),
    },
    topChase: null,
    contentSummary: {
      knownCollectibleCount: 0,
      chaseCount: 0,
      categoryCount: categories.length,
      collectibleTypeCount: collectibleTypes.length,
      evidenceCompleteness:
        evidence === "complete" || evidence === "partial" ? evidence : "unknown",
      probabilityCoverageBasisPoints: null,
    },
    actionAvailability: {
      promo: false,
      repackLink: actions.repackLink !== undefined,
    },
    sourceUpdatedAt,
    description: boundedText(pack.description, 4_000),
    actions,
  };
}

/**
 * Maps one provider's active packs to public repack details. Packs without a
 * USD price are skipped unless `includePriceless` is set; skipped packs are
 * reported with a reason so the summary shows what was left out.
 */
export function projectProviderPacks({
  platform,
  packs,
  chainByProviderCategoryId,
  collectibleTypes,
  readAt,
  versions,
  identity,
  includePriceless,
}) {
  const repacks = [];
  const skipped = [];
  const seenIds = new Set();
  for (const pack of packs) {
    if (pack.lifecycle !== undefined && pack.lifecycle !== "active") {
      skipped.push({ packKey: pack.pack_key, reason: "not_active" });
      continue;
    }
    if (
      !includePriceless &&
      publicPriceFromPack(pack).usdComparison.status !== "available"
    ) {
      skipped.push({ packKey: pack.pack_key, reason: "no_usd_price" });
      continue;
    }
    const detail = repackDetailFromPack({
      pack,
      platform,
      readAt,
      versions,
      identity,
      categoryChain: chainByProviderCategoryId.get(pack.category_id) ?? [],
      collectibleTypes,
    });
    if (seenIds.has(detail.publicRepackId)) {
      refuse("REPACK_IDENTITY_COLLISION", pack.pack_key);
    }
    seenIds.add(detail.publicRepackId);
    repacks.push(detail);
  }
  return { repacks, skipped };
}

// ---------------------------------------------------------------------------
// Carry-forward of the active release
// ---------------------------------------------------------------------------

/**
 * Selects the entities of the currently active release from a Convex snapshot
 * export, dropping the repacks (and their chases) of the vendors that are
 * being re-promoted. Categories and collectibles are always carried: they are
 * referential entities shared across vendors and harmless when orphaned.
 */
export function carryForwardActiveRelease({
  activeStateDocuments,
  categoryDocuments,
  collectibleDocuments,
  repackDocuments,
  chaseDocuments,
  promotedVendorKeys,
}) {
  const state = activeStateDocuments.find((document) => document.key === "singleton");
  if (state === undefined || state.activeReleaseId === null || state.activeRelease === null) {
    refuse("ACTIVE_RELEASE_MISSING", "the export has no active data_release_v3");
  }
  const releaseId = state.activeReleaseId;
  const promoted = new Set(promotedVendorKeys);
  const vendors = new Map();
  const excludedRepackIds = new Set();
  const repacks = [];
  for (const document of repackDocuments) {
    if (document.releaseId !== releaseId) continue;
    const detail = document.detail;
    const previous = vendors.get(detail.vendorKey);
    if (previous !== undefined && previous !== detail.publicVendorId) {
      refuse("CARRIED_VENDOR_IDENTITY_CONFLICT", detail.vendorKey);
    }
    vendors.set(detail.vendorKey, detail.publicVendorId);
    if (promoted.has(detail.vendorKey)) {
      excludedRepackIds.add(detail.publicRepackId);
      continue;
    }
    repacks.push(detail);
  }
  const forRelease = (documents) =>
    documents.filter((document) => document.releaseId === releaseId).map(
      (document) => document.detail,
    );
  const chases = forRelease(chaseDocuments).filter(
    (chase) => !excludedRepackIds.has(chase.publicRepackId),
  );
  return {
    activePublicReleaseId: state.activeRelease.publicReleaseId,
    activeReleaseFingerprint: state.activeRelease.releaseFingerprint,
    activeDataAsOf: state.activeRelease.dataAsOf,
    vendors,
    categories: forRelease(categoryDocuments),
    collectibles: forRelease(collectibleDocuments),
    repacks,
    chases,
    droppedRepackCount: excludedRepackIds.size,
  };
}

// ---------------------------------------------------------------------------
// Release assembly (mirrors DataReleaseV3ReleaseAssembler's hashing)
// ---------------------------------------------------------------------------

function assertStrictlySortedUnique(values, key, code) {
  for (let index = 1; index < values.length; index += 1) {
    if (key(values[index - 1]) >= key(values[index])) refuse(code, key(values[index]));
  }
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

export function uuidFromSha256(hex) {
  // RFC 9562 version-8 UUID carved from a domain-separated digest, exactly as
  // the production assembler does, so replaying the same content yields the
  // same public release identity.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Deterministic whole-release assembly: sorts every entity set, packs the
 * canonical batches (32 repack details or 100 records per batch), and derives
 * the batch chain, entity chains, content hash, public release id, and
 * fingerprint with the same domain-separated hashing the Convex lifecycle
 * recomputes. Any divergence is refused server-side, never silently accepted.
 */
export async function assembleDataReleaseV3Plan(
  { readAt, categories, collectibles, repacks, chases },
  { sha256CanonicalJson, canonicalJson, domains, versions, limits, emptyChainHash },
) {
  if (canonicalTimestamp(readAt) !== readAt) refuse("READ_AT_INVALID", readAt);
  if (
    repacks.length > limits.repacks ||
    categories.length > limits.categories ||
    collectibles.length > limits.collectibles ||
    chases.length > limits.chases
  ) {
    refuse("CAPACITY_EXCEEDED");
  }
  const sortedCategories = [...categories].sort((left, right) =>
    left.publicCategoryId < right.publicCategoryId ? -1 : 1,
  );
  assertStrictlySortedUnique(
    sortedCategories,
    ({ publicCategoryId }) => publicCategoryId,
    "DUPLICATE_CATEGORY",
  );
  const sortedCollectibles = [...collectibles].sort((left, right) =>
    left.publicCollectibleId < right.publicCollectibleId ? -1 : 1,
  );
  assertStrictlySortedUnique(
    sortedCollectibles,
    ({ publicCollectibleId }) => publicCollectibleId,
    "DUPLICATE_COLLECTIBLE",
  );
  const sortedRepacks = [...repacks].sort((left, right) =>
    left.publicRepackId < right.publicRepackId ? -1 : 1,
  );
  assertStrictlySortedUnique(
    sortedRepacks,
    ({ publicRepackId }) => publicRepackId,
    "DUPLICATE_REPACK",
  );
  const chaseKey = (chase) => `${chase.publicRepackId}:${chase.publicCollectibleId}`;
  const sortedChases = [...chases].sort((left, right) =>
    chaseKey(left) < chaseKey(right) ? -1 : 1,
  );
  assertStrictlySortedUnique(sortedChases, chaseKey, "DUPLICATE_CHASE");
  const chaseByKey = new Map(sortedChases.map((chase) => [chaseKey(chase), chase]));
  const categoryIds = new Set(sortedCategories.map(({ publicCategoryId }) => publicCategoryId));
  const collectibleIds = new Set(
    sortedCollectibles.map(({ publicCollectibleId }) => publicCollectibleId),
  );
  const repackIds = new Set(sortedRepacks.map(({ publicRepackId }) => publicRepackId));

  for (const collectible of sortedCollectibles) {
    for (const publicCategoryId of collectible.publicCategoryIds) {
      if (!categoryIds.has(publicCategoryId)) {
        refuse("COLLECTIBLE_CATEGORY_UNKNOWN", collectible.publicCollectibleId);
      }
    }
  }
  let topChaseCount = 0;
  for (const repack of sortedRepacks) {
    for (const { publicCategoryId } of repack.categories) {
      if (!categoryIds.has(publicCategoryId)) {
        refuse("REPACK_CATEGORY_UNKNOWN", repack.publicRepackId);
      }
    }
    if (repack.topChase !== null) {
      const staged = chaseByKey.get(chaseKey(repack.topChase));
      if (
        staged === undefined ||
        canonicalJson(staged) !== canonicalJson(repack.topChase)
      ) {
        refuse("TOP_CHASE_NOT_STAGED", repack.publicRepackId);
      }
      topChaseCount += 1;
    }
  }
  for (const chase of sortedChases) {
    if (!repackIds.has(chase.publicRepackId) || !collectibleIds.has(chase.publicCollectibleId)) {
      refuse("CHASE_REFERENCE_UNKNOWN", chaseKey(chase));
    }
  }
  // Convex folds every record's source time into the release and refuses at
  // finalize when one is later than dataAsOf; prove that here so a dry run
  // is finalizable by construction rather than by timing.
  const readAtMillis = Date.parse(readAt);
  const laterThanReadAt = (value) => {
    const millis = Date.parse(value);
    return !Number.isFinite(millis) || millis > readAtMillis;
  };
  for (const repack of sortedRepacks) {
    if (laterThanReadAt(repack.sourceUpdatedAt)) {
      refuse("RECORD_TIME_AFTER_READ", `repack ${repack.publicRepackId}`);
    }
  }
  for (const collectible of sortedCollectibles) {
    if (laterThanReadAt(collectible.dataAsOf)) {
      refuse("RECORD_TIME_AFTER_READ", `collectible ${collectible.publicCollectibleId}`);
    }
  }
  for (const chase of sortedChases) {
    if (laterThanReadAt(chase.observedAt)) {
      refuse("RECORD_TIME_AFTER_READ", `chase ${chaseKey(chase)}`);
    }
  }

  const entities = {
    categories: sortedCategories,
    collectibles: sortedCollectibles,
    repacks: sortedRepacks,
    chases: sortedChases,
  };
  const batches = [];
  let batchChainHash = emptyChainHash;
  const entityChainHashes = {
    categories: emptyChainHash,
    collectibles: emptyChainHash,
    repacks: emptyChainHash,
    chases: emptyChainHash,
  };
  for (const kind of ["categories", "collectibles", "repacks", "chases"]) {
    const size = kind === "repacks" ? limits.repackBatchRecords : limits.batchRecords;
    for (const records of chunk(entities[kind], size)) {
      const batchHash = await sha256CanonicalJson(domains.batch, { kind, records });
      const batchIndex = batches.length;
      batches.push({ batchIndex, kind, batchHash, records });
      batchChainHash = await sha256CanonicalJson(domains.batchChain, {
        previousHash: batchChainHash,
        batchIndex,
        kind,
        batchHash,
        recordCount: records.length,
      });
      entityChainHashes[kind] = await sha256CanonicalJson(domains.entityChain, {
        previousHash: entityChainHashes[kind],
        batchHash,
      });
    }
  }
  const counts = {
    categories: sortedCategories.length,
    collectibles: sortedCollectibles.length,
    repacks: sortedRepacks.length,
    chases: sortedChases.length,
    searchShards: Math.ceil(sortedRepacks.length / limits.repackBatchRecords),
  };
  const contentHash = await sha256CanonicalJson(domains.content, {
    counts,
    entityChainHashes,
    topChaseCount,
  });
  const identityFields = {
    methodVersion: versions.methodVersion,
    confidencePolicyVersion: versions.confidencePolicyVersion,
    publicEvPolicyVersion: versions.publicEvPolicyVersion,
    dataAsOf: readAt,
    contentHash,
    searchAlgorithmVersion: versions.searchAlgorithmVersion,
    batchCount: batches.length,
    batchChainHash,
  };
  const publicReleaseId = uuidFromSha256(
    await sha256CanonicalJson(domains.releaseId, identityFields),
  );
  const releaseFingerprint = await sha256CanonicalJson(domains.fingerprint, {
    schemaVersion: versions.schemaVersion,
    publicReleaseId,
    ...identityFields,
  });
  return {
    classification: "publish",
    publicReleaseId,
    releaseFingerprint,
    manifest: {
      methodVersion: versions.methodVersion,
      confidencePolicyVersion: versions.confidencePolicyVersion,
      publicEvPolicyVersion: versions.publicEvPolicyVersion,
      dataAsOf: readAt,
      contentHash,
      searchAlgorithmVersion: versions.searchAlgorithmVersion,
      counts,
      entityChainHashes,
      topChaseCount,
      batchCount: batches.length,
      batchChainHash,
    },
    batches,
  };
}

// ---------------------------------------------------------------------------
// Activation binding
// ---------------------------------------------------------------------------

/**
 * Binds the publisher's server-side activation compare-and-swap to the
 * predecessor the plan was assembled against (the release whose vendors were
 * carried forward). The publisher re-reads the active pointer on its own; a
 * fresh read may prove that predecessor is still active but can never
 * silently adopt a newer pointer, so a concurrent activation refuses before
 * `start` (first read) or at `activate`, never after the catalog moved.
 */
export function boundDataReleaseV3ActivationPort(
  publication,
  plan,
  expectedActivePublicReleaseId,
) {
  let activated = false;
  const moved = (detail) => refuse("ACTIVE_POINTER_MOVED", detail);
  return Object.freeze({
    async activeState() {
      const state = await publication.activeState();
      const activeId = state.activeRelease?.publicReleaseId ?? null;
      const previousId = state.previousRelease?.publicReleaseId ?? null;
      if (!activated && activeId !== expectedActivePublicReleaseId) {
        moved(
          `the deployment serves ${activeId ?? "no release"} but the plan was ` +
            `assembled against ${expectedActivePublicReleaseId ?? "no release"}; re-run`,
        );
      }
      if (
        activated &&
        (activeId !== plan.publicReleaseId || previousId !== expectedActivePublicReleaseId)
      ) {
        moved(`activation read-back shows ${activeId ?? "no release"} over ${previousId ?? "none"}`);
      }
      return state;
    },
    status: (publicReleaseId) => publication.status(publicReleaseId),
    start: (request) => publication.start(request),
    applyBatch: (request) => publication.applyBatch(request),
    finalize: (request) => publication.finalize(request),
    async activate(request) {
      if (
        request.publicReleaseId !== plan.publicReleaseId ||
        request.releaseFingerprint !== plan.releaseFingerprint ||
        request.expectedActivePublicReleaseId !== expectedActivePublicReleaseId
      ) {
        moved(
          `activate would replace ${request.expectedActivePublicReleaseId ?? "no release"} ` +
            `instead of ${expectedActivePublicReleaseId ?? "no release"}`,
        );
      }
      const receipt = await publication.activate(request);
      activated = true;
      return receipt;
    },
    async rollback() {
      return moved("rollback is not part of this promotion");
    },
    refreshProviderObservation: (request) =>
      publication.refreshProviderObservation(request),
  });
}

function originOf(url) {
  const parsed = parsedHttpsUrl(url);
  return parsed === null ? null : parsed.origin;
}

export function summarizePlan(plan, { vendors, skipped, minted, carried, promotedVendorKeys }) {
  const byVendor = new Map();
  const imageOriginsByVendor = new Map();
  for (const batch of plan.batches) {
    if (batch.kind !== "repacks") continue;
    for (const repack of batch.records) {
      byVendor.set(repack.vendorKey, (byVendor.get(repack.vendorKey) ?? 0) + 1);
      const origins = imageOriginsByVendor.get(repack.vendorKey) ?? new Set();
      for (const url of [repack.primaryImage?.url, repack.vendorLogoUrl]) {
        const origin = url === undefined ? null : originOf(url);
        if (origin !== null) origins.add(origin);
      }
      imageOriginsByVendor.set(repack.vendorKey, origins);
    }
  }
  const promoted = new Set(promotedVendorKeys);
  const carriedOrigins = new Set();
  for (const [vendorKey, origins] of imageOriginsByVendor) {
    if (!promoted.has(vendorKey)) for (const origin of origins) carriedOrigins.add(origin);
  }
  const newImageOrigins = [...new Set(
    [...imageOriginsByVendor]
      .filter(([vendorKey]) => promoted.has(vendorKey))
      .flatMap(([, origins]) => [...origins])
      .filter((origin) => !carriedOrigins.has(origin)),
  )].sort();
  const warnings = [];
  if (newImageOrigins.length > 0) {
    warnings.push(
      `Promoted vendors publish images from origins the carried catalog does not use: ${newImageOrigins.join(", ")}. ` +
        "The frontend CSP only allows PACKSCOUT_PUBLIC_IMAGE_ORIGINS (hash-pinned on both the frontend and Convex); " +
        "until that allowlist is widened these images render as placeholders.",
    );
  }
  warnings.push(
    "Provider health observations are stored per release. The new release starts with none, so every vendor's " +
      "health badge reads unavailable until an observation is refreshed for it (the ClutchPacks resident only " +
      "refreshes its own candidate release).",
  );
  return {
    publicReleaseId: plan.publicReleaseId,
    releaseFingerprint: plan.releaseFingerprint,
    dataAsOf: plan.manifest.dataAsOf,
    counts: plan.manifest.counts,
    batchCount: plan.manifest.batchCount,
    topChaseCount: plan.manifest.topChaseCount,
    repacksByVendor: Object.fromEntries([...byVendor.entries()].sort()),
    vendors,
    imageOriginsByVendor: Object.fromEntries(
      [...imageOriginsByVendor.entries()]
        .sort()
        .map(([vendorKey, origins]) => [vendorKey, [...origins].sort()]),
    ),
    newImageOrigins,
    mintedCategories: minted.map(({ categoryKey, name, publicCategoryId }) => ({
      categoryKey,
      name,
      publicCategoryId,
    })),
    skippedPacks: skipped,
    carried,
    warnings,
  };
}

import type {
  CatalogEnvelopeV1,
  ProviderFeedPageV1,
} from "../provider-feed.ts";

type OpaqueFixtureData = CatalogEnvelopeV1["data"];

export type SanitizedProviderFixtureName =
  | "beezie"
  | "clutchpacks"
  | "collector_crypt"
  | "courtyard"
  | "gamestop"
  | "phygitals"
  | "stadium_vault"
  | "trove";

export interface SanitizedProviderFeedFixture {
  readonly name: SanitizedProviderFixtureName;
  readonly page: ProviderFeedPageV1;
  readonly sampleProfile: {
    readonly file: string;
    readonly counts: {
      readonly catalog: number;
      readonly pulls: number;
      readonly trades: number;
    };
    readonly nullableFields: {
      readonly pullPackExternalId: boolean;
      readonly tradeAmount: boolean;
      readonly tradeCurrency: boolean;
    };
  };
}

interface FixtureShape {
  readonly name: SanitizedProviderFixtureName;
  readonly catalogData: OpaqueFixtureData;
  readonly pullData: OpaqueFixtureData;
  readonly packExternalId?: string | null;
  readonly sampleCounts: SanitizedProviderFeedFixture["sampleProfile"]["counts"];
  readonly sampleNullableFields: SanitizedProviderFeedFixture["sampleProfile"]["nullableFields"];
  readonly trade:
    | "empty"
    | {
        readonly amount: number | null;
        readonly currency: string | null;
        readonly eventType: string;
        readonly data: OpaqueFixtureData;
      };
}

const collectedAt = "2026-01-02T03:05:00.000Z";
const sourceTime = "2026-01-02T03:04:05.000Z";

const fixtureShapes: readonly FixtureShape[] = [
  {
    name: "beezie",
    sampleCounts: { catalog: 4, pulls: 15, trades: 15 },
    sampleNullableFields: {
      pullPackExternalId: true,
      tradeAmount: false,
      tradeCurrency: false,
    },
    catalogData: {
      fixture_shape: "machine-with-micro-unit-price",
      price_micro_units: 2_500_000,
      odds: [{ probability: 0.25, value_range: [8, 12] }],
    },
    pullData: { fixture_shape: "pull-without-pack-relationship" },
    packExternalId: null,
    trade: {
      amount: 14.5,
      currency: "fixture-token",
      eventType: "swap",
      data: { fixture_shape: "token-denominated-event" },
    },
  },
  {
    name: "clutchpacks",
    sampleCounts: { catalog: 14, pulls: 15, trades: 15 },
    sampleNullableFields: {
      pullPackExternalId: true,
      tradeAmount: true,
      tradeCurrency: true,
    },
    catalogData: {
      fixture_shape: "collection-with-formatted-prices",
      formatted_price: "$25.00",
      buckets: [{ label: "fixture-bucket", live_pool_percent: 100 }],
    },
    pullData: { fixture_shape: "card-preview-pull" },
    packExternalId: null,
    trade: {
      amount: null,
      currency: null,
      eventType: "shipped",
      data: { fixture_shape: "event-with-null-payment" },
    },
  },
  {
    name: "collector_crypt",
    sampleCounts: { catalog: 14, pulls: 15, trades: 15 },
    sampleNullableFields: {
      pullPackExternalId: false,
      tradeAmount: true,
      tradeCurrency: true,
    },
    catalogData: {
      fixture_shape: "mixed-card-and-machine-catalog",
      tier_ranges: [{ weight: 1, minimum: 5, maximum: 9 }],
      owner_identity: "sanitized",
    },
    pullData: { fixture_shape: "machine-linked-pull" },
    packExternalId: "fixture:collector_crypt:pack:1",
    trade: {
      amount: null,
      currency: null,
      eventType: "unlisted",
      data: { fixture_shape: "listing-lifecycle-event" },
    },
  },
  {
    name: "courtyard",
    sampleCounts: { catalog: 11, pulls: 15, trades: 15 },
    sampleNullableFields: {
      pullPackExternalId: false,
      tradeAmount: true,
      tradeCurrency: true,
    },
    catalogData: {
      fixture_shape: "pack-with-inventory-and-price-records",
      inventory: [{ asset_id: "fixture-asset", estimate: 42.5 }],
      odds: [{ probability: 1, minimum: 20, maximum: 60 }],
    },
    pullData: { fixture_shape: "out-of-page-pack-reference" },
    packExternalId: "fixture:courtyard:pack:outside-page",
    trade: {
      amount: null,
      currency: null,
      eventType: "transfer",
      data: { fixture_shape: "transfer-without-currency" },
    },
  },
  {
    name: "gamestop",
    sampleCounts: { catalog: 8, pulls: 15, trades: 0 },
    sampleNullableFields: {
      pullPackExternalId: false,
      tradeAmount: false,
      tradeCurrency: false,
    },
    catalogData: {
      fixture_shape: "category-with-purchasable-levels",
      levels: [
        { id: "fixture-level", price: 10, available: true },
      ],
    },
    pullData: { fixture_shape: "category-and-level-pull" },
    packExternalId: "fixture:gamestop:category:1",
    trade: "empty",
  },
  {
    name: "phygitals",
    sampleCounts: { catalog: 15, pulls: 15, trades: 15 },
    sampleNullableFields: {
      pullPackExternalId: false,
      tradeAmount: false,
      tradeCurrency: false,
    },
    catalogData: {
      fixture_shape: "root-pack-with-variants",
      variants: [
        { id: "fixture-variant", stock: 4, provider_ev: 12.25 },
      ],
    },
    pullData: {
      fixture_shape: "deep-collectible-event",
      marketplace: { identity: "sanitized", listing: { active: false } },
    },
    packExternalId: "fixture:phygitals:variant:1",
    trade: {
      amount: 9.75,
      currency: "USD",
      eventType: "buyback",
      data: { fixture_shape: "buyback-event", actor: "sanitized" },
    },
  },
  {
    name: "stadium_vault",
    sampleCounts: { catalog: 14, pulls: 15, trades: 0 },
    sampleNullableFields: {
      pullPackExternalId: false,
      tradeAmount: false,
      tradeCurrency: false,
    },
    catalogData: {
      fixture_shape: "pack-with-effective-odds",
      effective_odds: [{ probability: 1, minimum: 2, maximum: 22 }],
      top_pulls: [{ asset_id: "fixture-top-pull", value: 22 }],
    },
    pullData: { fixture_shape: "graded-card-pull", grade: "fixture-grade" },
    packExternalId: "fixture:stadium_vault:pack:1",
    trade: "empty",
  },
  {
    name: "trove",
    sampleCounts: { catalog: 15, pulls: 15, trades: 0 },
    sampleNullableFields: {
      pullPackExternalId: false,
      tradeAmount: false,
      tradeCurrency: false,
    },
    catalogData: {
      fixture_shape: "pack-with-tier-ranges-and-grails",
      cards_per_pack: 2,
      tiers: [{ probability: 1, minimum: 3, maximum: 30 }],
      grails: [{ asset_id: "fixture-grail" }],
    },
    pullData: {
      fixture_shape: "nested-collectible-pull",
      collectible: { identity: "fixture-collectible", market_value: 18 },
      actor: "sanitized",
    },
    packExternalId: "fixture:trove:pack:1",
    trade: "empty",
  },
] as const;

function buildFixture(shape: FixtureShape): SanitizedProviderFeedFixture {
  const platform = shape.name;
  const page: ProviderFeedPageV1 = {
    catalog: [
      {
        platform,
        external_id: `fixture:${platform}:catalog:1`,
        updated_at: sourceTime,
        collected_at: collectedAt,
        data: shape.catalogData,
      },
    ],
    pulls: [
      {
        platform,
        external_id: `fixture:${platform}:pull:1`,
        pack_external_id:
          shape.packExternalId === undefined
            ? `fixture:${platform}:pack:1`
            : shape.packExternalId,
        occurred_at: sourceTime,
        collected_at: collectedAt,
        data: shape.pullData,
      },
    ],
    trades:
      shape.trade === "empty"
        ? []
        : [
            {
              platform,
              external_id: `fixture:${platform}:trade:1`,
              event_type: shape.trade.eventType,
              tx_hash: `fixture:${platform}:transaction:1`,
              amount: shape.trade.amount,
              currency: shape.trade.currency,
              occurred_at: sourceTime,
              collected_at: collectedAt,
              data: shape.trade.data,
            },
          ],
    next_cursor: `fixture:${platform}:cursor:complete`,
    has_more: false,
  };

  return {
    name: shape.name,
    page,
    sampleProfile: {
      file: `${shape.name}.json`,
      counts: shape.sampleCounts,
      nullableFields: shape.sampleNullableFields,
    },
  };
}

export function buildSanitizedProviderFeedFixtures(): readonly SanitizedProviderFeedFixture[] {
  return fixtureShapes.map(buildFixture);
}

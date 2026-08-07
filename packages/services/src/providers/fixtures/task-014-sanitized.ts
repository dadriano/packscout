import type { ProviderFeedPageV1 } from "@packscout/contracts";

const collectedAt = "2026-08-04T15:11:24Z";

/**
 * Sanitized slices from the source files named by the task-014 manifest hashes.
 * Product facts and opaque record IDs are retained; user/wallet values are
 * replaced so no source actor identity is checked in.
 */
export const beezieSanitizedPage: ProviderFeedPageV1 = {
  catalog: [
    {
      platform: "beezie",
      external_id: "99",
      updated_at: collectedAt,
      collected_at: collectedAt,
      data: {
        id: 99,
        name: "Silver TCG",
        description: "One collectible per play.",
        kind: "v3",
        status: "active",
        isVisible: true,
        clawTag: "beezie50",
        priceUsdc: 50_000_000,
        averageValue: 55,
        buyCommission: null,
        swapFees: {
          wallets: ["removed"],
          percentages: [6],
        },
        odds: {
          low: "20.05",
          base: "75.25",
          high: "0.13",
          grails: "0.51",
          medium: "4.06",
        },
        priceRanges: {
          fromBase: 25,
          toBase: 50,
          fromLow: 51,
          toLow: 100,
          fromMedium: 101,
          toMedium: 250,
          fromHigh: 251,
          toHigh: 750,
          fromGrails: 751,
          toGrails: 2_000,
        },
        grails: {
          high: [
            {
              tokenId: 12_180,
              swapValue: 420_000_000,
              item: {
                category: { name: "Pokémon" },
                metadata: {
                  name: "Sanitized high-tier card",
                  image: "https://images.example.invalid/12180.jpg",
                },
              },
            },
          ],
          grails: [],
          medium: [],
        },
      },
    },
  ],
  pulls: [
    {
      platform: "beezie",
      external_id: "15006:2026-08-03T21:28:20.701Z",
      pack_external_id: null,
      occurred_at: "2026-08-03T21:28:20Z",
      collected_at: collectedAt,
      data: {
        tokenId: 15_006,
        name: "Sanitized pull item",
        categoryId: 3,
        status: "swapped",
        swapValue: 31_000_000,
        imageUrl: "https://images.example.invalid/15006.jpg",
        from: "fixture-wallet-a",
        fromUsername: "removed",
      },
    },
  ],
  sales: [
    {
      platform: "beezie",
      external_id: "fixture-beezie-sale",
      event_type: "sale",
      tx_hash:
        "0xbf8728a1a8abbebfcab953e603f99c2367b2a32d013d0fcb99dd20cf760cb4a4",
      amount: 35,
      currency: "0xBB5eC6fD4B61723BD45C399840F1d868840ca16F",
      occurred_at: "2026-08-03T04:10:15Z",
      collected_at: collectedAt,
      data: {
        tokenId: 17_157,
        tokenAddress: "0xBB5eC6fD4B61723BD45C399840F1d868840ca16F",
        amount: "35000000",
        from: "fixture-wallet-a",
        to: "fixture-wallet-b",
        fromUsername: "removed",
        toUsername: "removed",
      },
    },
  ],
  next_cursor: "task-014-beezie-end",
  has_more: false,
};

export const clutchpacksSanitizedPage: ProviderFeedPageV1 = {
  catalog: [
    {
      platform: "clutchpacks",
      external_id: "1d3584eb-b951-4476-90e4-eb2b450e9587",
      updated_at: "2026-08-04T15:09:12Z",
      collected_at: "2026-08-04T15:09:12Z",
      data: {
        collection_id: "1d3584eb-b951-4476-90e4-eb2b450e9587",
        name: "Ascent",
        description: "Instant buyback offer.\nOne card per pack.",
        category: { id: "category-sports", name: "Sports", slug: "sports" },
        price: {
          currency: {
            code: "USD",
            name: "American Dollar",
            type: "fiat",
            decimals: 2,
          },
          price_amount: "100",
        },
        average_value: "100",
        floor: "20",
        chaser_ceiling: "1,000",
        sold_out: false,
        image_url: "https://images.example.invalid/ascent.jpg",
        price_bucket_odds: [
          {
            bucket_id: "bucket-high",
            name: "Chasers",
            min_price: "$100",
            max_price: "$1,000",
            live_pool_percentage: "25.00",
            drawable_count: 1,
            has_more: false,
            preview_cards: [
              {
                id: "card-high",
                title: "Sanitized chaser card",
                front_image_url: "https://images.example.invalid/high.jpg",
              },
            ],
            pool_cards: [],
          },
          {
            bucket_id: "bucket-base",
            name: "Commons",
            min_price: "$20",
            max_price: "$99.99",
            live_pool_percentage: "75.00",
            drawable_count: 3,
            has_more: true,
            preview_cards: [],
            pool_cards: [],
          },
        ],
        series_hits: [
          {
            id: "card-top-chase",
            title: "Sanitized top chase",
            current_price: "$85,000",
            front_image_url: "https://images.example.invalid/top.jpg",
          },
        ],
      },
    },
  ],
  pulls: [
    {
      platform: "clutchpacks",
      external_id: "hof:fixture-valued-pull",
      pack_external_id: null,
      occurred_at: "2026-08-01T16:11:53Z",
      collected_at: "2026-08-04T15:09:12Z",
      data: {
        collectible_type: "card",
        formatted_collectible_price: "$2,263",
        card: { id: "card-valued", title: "Sanitized valued card" },
        user: { id: "fixture-user-a", username: "removed", is_anonymous: false },
      },
    },
    {
      platform: "clutchpacks",
      external_id: "fixture-null-value-pull",
      pack_external_id: null,
      occurred_at: "2026-08-03T16:35:54Z",
      collected_at: "2026-08-04T15:09:12Z",
      data: {
        collectible_type: "card",
        formatted_collectible_price: null,
        card: { id: "card-null-value", title: "Sanitized card" },
        user: { id: "", username: "anonymous", is_anonymous: true },
      },
    },
  ],
  sales: [
    {
      platform: "clutchpacks",
      external_id: "0xfixture-sale",
      event_type: "Sale",
      tx_hash: "0xfixture-sale",
      amount: 30.99,
      currency: "USD",
      occurred_at: "2026-08-04T14:09:14Z",
      collected_at: "2026-08-04T15:09:12Z",
      data: {
        transaction_type: "Sale",
        card: { card_id: "card-sale", title: "Sanitized sale card" },
        booster: null,
        from: "fixture-account-a",
        to: "fixture-account-b",
      },
    },
    {
      platform: "clutchpacks",
      external_id: "0xfixture-shipped",
      event_type: "Shipped",
      tx_hash: "0xfixture-shipped",
      amount: null,
      currency: null,
      occurred_at: "2026-07-31T21:25:47Z",
      collected_at: "2026-08-04T15:09:12Z",
      data: {
        transaction_type: "Shipped",
        card: { card_id: "card-shipped", title: "Sanitized shipped card" },
        booster: null,
        from: "fixture-account-a",
        to: "fixture-account-b",
      },
    },
    {
      platform: "clutchpacks",
      external_id: "0xfixture-minted",
      event_type: "Minted",
      tx_hash: "0xfixture-minted",
      amount: 50,
      currency: "USD",
      occurred_at: "2026-08-04T14:10:14Z",
      collected_at: "2026-08-04T15:09:12Z",
      data: {
        transaction_type: "Minted",
        card: { card_id: "card-minted", title: "Sanitized minted card" },
        booster: null,
        from: "fixture-account-zero",
        to: "fixture-account-a",
      },
    },
  ],
  next_cursor: "task-014-clutchpacks-end",
  has_more: false,
};

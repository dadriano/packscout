import type {
  CatalogRecordV2,
  PullRecordV2,
  TradeRecordV2,
} from "../../provider-stream-contract-v2.ts";

/**
 * Sanitized record envelopes derived from the real examples in the provider
 * response-model draft dated 11 August 2026. The draft supplies no raw page
 * wrapper, cursor, request, authentication, termination, or error example, so
 * this fixture intentionally does not invent any of them.
 */
export const sanitizedProviderStreamV2Records = Object.freeze({
  pull: Object.freeze({
    stream: "pulls",
    platform: "courtyard",
    record_id: "sanitized-pull-courtyard-001",
    pack_id: "1500-coin-pack",
    card_id: "sanitized-card-courtyard-001",
    occurred_at: "2026-08-10T01:25:48Z",
    collected_at: "2026-08-10T12:52:48Z",
    data: {
      title: "1882 $5 Gold NGC MS63",
      pulled_by: {
        user_id: "sanitized-user-001",
        username: "sanitized-user-name-001",
      },
      created_at: "2026-08-10T01:25:48Z",
      reveal_state: {
        revealed: true,
        reveal_window: { start_time: "", end_time: "" },
      },
      fmv_estimate_usd: 1128.335,
      proof_of_integrity: "sanitized-pull-courtyard-001",
    },
  } satisfies PullRecordV2),
  trade: Object.freeze({
    stream: "trades",
    platform: "collector_crypt",
    record_id: "sanitized-trade-collector-crypt-001",
    card_id: "sanitized-card-collector-crypt-001",
    occurred_at: "2026-08-10T11:49:52Z",
    collected_at: "2026-08-10T11:50:14Z",
    event_type: "list",
    amount: 150,
    currency: "USDC",
    tx_hash: "sanitized-transaction-collector-crypt-001",
    data: {
      action: "List",
      cardId: "sanitized-card-collector-crypt-001",
      amount: "150",
      priceInfo: { splPrice: { symbol: "USDC", rawAmount: "150000000" } },
      transactionUrl:
        "https://solscan.io/tx/sanitized-transaction?cluster=mainnet-beta",
    },
  } satisfies TradeRecordV2),
  catalogPack: Object.freeze({
    stream: "catalog",
    platform: "courtyard",
    entity: "pack",
    record_id: "pkmn-master-pack",
    first_seen_at: "2026-08-09T18:02:11Z",
    occurred_at: null,
    collected_at: "2026-08-11T08:30:02Z",
    data: {
      id: "pkmn-master-pack",
      title: "Pokemon Master Pack",
      status: "ACTIVE",
      outOfStock: false,
      odds: { "...": "..." },
    },
  } satisfies CatalogRecordV2),
  catalogCard: Object.freeze({
    stream: "catalog",
    platform: "courtyard",
    entity: "card",
    record_id: "sanitized-card-courtyard-002",
    first_seen_at: "2026-08-10T17:41:31Z",
    occurred_at: null,
    collected_at: "2026-08-11T08:30:02Z",
    data: {
      asset: {
        title: "2022 Lost Origin #118/196 Drapion V - Holo (CGC 10 GEM MINT)",
        year: 2022,
        collection: "Graded Cards",
        estimatedValueUsd: 12.6,
        mintedAt: "2026-08-10T17:41:24Z",
        listedAt: null,
        ownerUserId: "sanitized-owner-001",
      },
      prices: { "...price history as the platform publishes it...": true },
      reveal: { "...the record as it appeared in the reveal feed...": true },
    },
  } satisfies CatalogRecordV2),
});

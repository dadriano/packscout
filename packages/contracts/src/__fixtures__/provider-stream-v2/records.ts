import type {
  CatalogRecordV2,
  PullRecordV2,
  TradeRecordV2,
} from "../../provider-stream-contract-v2.ts";

/**
 * Sanitized record envelopes derived from the complete 13 August 2026 archive.
 * The archive proves record shapes and nullable fields, but supplies no live
 * response wrapper, cursor, request, termination, or error representation.
 */
export const sanitizedProviderStreamV2Records = Object.freeze({
  courtyardPull: Object.freeze({
    stream: "pulls",
    platform: "courtyard",
    record_id: "sanitized-pull-courtyard-001",
    pack_id: "sanitized-pack-courtyard-001",
    card_id: "sanitized-card-courtyard-001",
    occurred_at: "2026-08-13T00:00:00Z",
    collected_at: "2026-08-13T00:00:08Z",
    data: {
      title: "Sanitized graded collectible",
      pulled_by: {
        user_id: "sanitized-user-courtyard-001",
        username: "sanitized-username-courtyard-001",
      },
      created_at: "2026-08-13T00:00:00Z",
      fmv_estimate_usd: 125,
      proof_of_integrity: "sanitized-proof-courtyard-001",
    },
  } satisfies PullRecordV2),
  collectorCryptCardlessPull: Object.freeze({
    stream: "pulls",
    platform: "collector_crypt",
    record_id: "sanitized-pull-collector-crypt-001",
    pack_id: "sanitized-pack-collector-crypt-001",
    card_id: null,
    occurred_at: "2026-08-13T00:00:27Z",
    collected_at: "2026-08-13T00:00:38Z",
    data: {
      id: 9_000_001,
      pack_type: "sanitized-pack-collector-crypt-001",
      spin_status: null,
      send_nft_address: null,
      send_nft_status: null,
      buyback_status: null,
      buyback_refund_amount: null,
      free_spin: false,
    },
  } satisfies PullRecordV2),
  collectorCryptTrade: Object.freeze({
    stream: "trades",
    platform: "collector_crypt",
    record_id: "sanitized-trade-collector-crypt-001",
    card_id: "sanitized-card-collector-crypt-001",
    occurred_at: "2026-08-13T00:06:23Z",
    collected_at: "2026-08-13T00:06:49Z",
    event_type: "list",
    amount: 131,
    currency: "USDC",
    tx_hash: "sanitized-transaction-collector-crypt-001",
    data: {
      action: "List",
      cardId: "sanitized-card-collector-crypt-001",
      amount: "131",
      ownerId: "sanitized-owner-collector-crypt-001",
      transactionUrl:
        "https://solscan.io/tx/sanitized-transaction?cluster=mainnet-beta",
    },
  } satisfies TradeRecordV2),
  courtyardCatalogPack: Object.freeze({
    stream: "catalog",
    platform: "courtyard",
    entity: "pack",
    record_id: "sanitized-pack-courtyard-001",
    first_seen_at: "2026-08-10T17:33:42Z",
    occurred_at: "2026-08-14T12:20:29Z",
    collected_at: "2026-08-14T12:48:24Z",
    data: {
      id: "sanitized-pack-courtyard-001",
      title: "Sanitized Collectible Pack",
      status: "ACTIVE",
      outOfStock: false,
      odds: { sanitized: true },
    },
  } satisfies CatalogRecordV2),
  collectorCryptCatalogCard: Object.freeze({
    stream: "catalog",
    platform: "collector_crypt",
    entity: "card",
    record_id: "sanitized-card-collector-crypt-002",
    first_seen_at: "2026-08-12T16:08:54Z",
    occurred_at: "2026-08-13T00:00:07Z",
    collected_at: "2026-08-14T12:32:56Z",
    data: {
      asset: {
        title: "Sanitized collectible card",
        owner: "sanitized-owner-collector-crypt-002",
      },
      activity: [],
      offers: [],
    },
  } satisfies CatalogRecordV2),
});

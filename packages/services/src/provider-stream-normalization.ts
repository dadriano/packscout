import type {
  ProviderStreamRecordV2,
  TradeRecordV2,
} from "@packscout/contracts";

export type CanonicalTradeLifecycleCategory =
  | "listed"
  | "unlisted"
  | "sale"
  | "mint"
  | "transfer"
  | "other";

const canonicalLifecycleByRawValue: Readonly<
  Record<string, CanonicalTradeLifecycleCategory>
> = Object.freeze({
  list: "listed",
  listed: "listed",
  listing: "listed",
  unlist: "unlisted",
  unlisted: "unlisted",
  unlisting: "unlisted",
  sale: "sale",
  sold: "sale",
  buyback: "sale",
  mint: "mint",
  minted: "mint",
  transfer: "transfer",
  transferred: "transfer",
  shipped: "transfer",
});

export interface CanonicalTradeLifecycleEvidence {
  /** Exact protected outer-envelope value. */
  readonly rawEventType: string;
  readonly canonicalCategory: CanonicalTradeLifecycleCategory;
}

export function normalizeTradeLifecycleEvidence(
  rawEventType: string,
): CanonicalTradeLifecycleEvidence {
  if (rawEventType.trim().length === 0) {
    throw new RangeError("Trade event type cannot be blank.");
  }
  const normalized = rawEventType.trim().toLowerCase();
  return Object.freeze({
    rawEventType,
    canonicalCategory: canonicalLifecycleByRawValue[normalized] ?? "other",
  });
}

export interface ApprovedCurrencyReference {
  /** A provider symbol or token contract address approved by Engineering. */
  readonly reference: string;
  readonly canonicalSymbol: string;
}

export type CanonicalCurrencyEvidence =
  | {
      readonly status: "unavailable";
      readonly rawReference: null;
      readonly canonicalSymbol: null;
    }
  | {
      readonly status: "resolved";
      /** Exact protected outer-envelope value. */
      readonly rawReference: string;
      readonly canonicalSymbol: string;
    }
  | {
      readonly status: "unsupported";
      /** Exact protected outer-envelope value. */
      readonly rawReference: string;
      readonly canonicalSymbol: null;
    };

function currencyLookupKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new RangeError("Currency reference cannot be blank.");
  }
  return /^0x[0-9a-f]{40}$/i.test(trimmed)
    ? trimmed.toLowerCase()
    : trimmed.toUpperCase();
}

function canonicalCurrencySymbol(value: string): string {
  const symbol = value.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(symbol)) {
    throw new RangeError("Canonical currency symbol is invalid.");
  }
  return symbol;
}

export function resolveCanonicalCurrencyEvidence(
  rawReference: string | null,
  approvedReferences: readonly ApprovedCurrencyReference[],
): CanonicalCurrencyEvidence {
  if (rawReference === null) {
    return Object.freeze({
      status: "unavailable",
      rawReference: null,
      canonicalSymbol: null,
    });
  }
  const approved = new Map<string, string>();
  for (const entry of approvedReferences) {
    const key = currencyLookupKey(entry.reference);
    const symbol = canonicalCurrencySymbol(entry.canonicalSymbol);
    const existing = approved.get(key);
    if (existing && existing !== symbol) {
      throw new RangeError("Currency reference has conflicting approvals.");
    }
    approved.set(key, symbol);
  }
  const canonicalSymbol = approved.get(currencyLookupKey(rawReference)) ?? null;
  return canonicalSymbol
    ? Object.freeze({
        status: "resolved" as const,
        rawReference,
        canonicalSymbol,
      })
    : Object.freeze({
        status: "unsupported" as const,
        rawReference,
        canonicalSymbol: null,
      });
}

export type ProviderOuterRelationshipEvidence =
  | {
      readonly stream: "catalog";
      readonly entity: "pack" | "card";
      readonly recordId: string;
    }
  | {
      readonly stream: "pulls";
      readonly recordId: string;
      readonly packId: string;
      readonly cardId: string;
    }
  | {
      readonly stream: "trades";
      readonly recordId: string;
      readonly cardId: string;
      readonly transactionHash: string;
    };

/**
 * Selects authoritative outer-envelope identities. Nested lookalikes remain
 * protected evidence and cannot override these relationship keys.
 */
export function outerRelationshipEvidence(
  record: ProviderStreamRecordV2,
): ProviderOuterRelationshipEvidence {
  if (record.stream === "catalog") {
    return Object.freeze({
      stream: record.stream,
      entity: record.entity,
      recordId: record.record_id,
    });
  }
  if (record.stream === "pulls") {
    return Object.freeze({
      stream: record.stream,
      recordId: record.record_id,
      packId: record.pack_id,
      cardId: record.card_id,
    });
  }
  return Object.freeze({
    stream: record.stream,
    recordId: record.record_id,
    cardId: record.card_id,
    transactionHash: record.tx_hash,
  });
}

export interface NormalizedTradeEvidence {
  readonly relationship: Extract<
    ProviderOuterRelationshipEvidence,
    { readonly stream: "trades" }
  >;
  readonly lifecycle: CanonicalTradeLifecycleEvidence;
  readonly amount: number | null;
  readonly currency: CanonicalCurrencyEvidence;
}

export function normalizeTradeEvidence(
  record: TradeRecordV2,
  approvedReferences: readonly ApprovedCurrencyReference[],
): NormalizedTradeEvidence {
  return Object.freeze({
    relationship: outerRelationshipEvidence(record) as Extract<
      ProviderOuterRelationshipEvidence,
      { readonly stream: "trades" }
    >,
    lifecycle: normalizeTradeLifecycleEvidence(record.event_type),
    amount: record.amount,
    currency: resolveCanonicalCurrencyEvidence(
      record.currency,
      approvedReferences,
    ),
  });
}

import { randomUUID } from "node:crypto";
import { normalizeJsonObject, ProviderCanonicalInputError, requireDate, requireDigest,
  requireNonEmptyText, requirePairedValues, type PullWriteInput, type MarketEventWriteInput,
} from "./provider-canonical-contract.ts";
import { nullableText, nullableMoney, nullableCurrency, requirePositiveBigInt, toPrismaJson,
} from "./provider-canonical-mutable-helpers.ts";

// Keep pre-read validation separate: replay intentionally does not evaluate create-only fields.
export function normalizeProviderPullWrite(input: PullWriteInput) {
  const pullKey = requireNonEmptyText(input.pullKey, "pullKey");
  const factDigest = requireDigest(input.factDigest);
  const packKey = nullableText(input.packKey, "packKey");
  requirePairedValues(input.paidAmount, input.paidCurrency, "paid");
  if (input.items.length === 0) {
    throw new ProviderCanonicalInputError("A completed pull must contain at least one item.");
  }
  const items = input.items.map((item) => {
    const collectibleKey = nullableText(item.collectibleKey, "collectibleKey");
    if (item.collectibleId !== null && collectibleKey === null) {
      throw new ProviderCanonicalInputError(
      "A resolved pull item collectible requires its immutable source key.",
      );
    }
    if (item.collectibleInstanceId !== null && item.collectibleId === null) {
      throw new ProviderCanonicalInputError(
      "A collectible instance subject requires its collectible.",
      );
    }
    requirePairedValues(item.statedValueAmount, item.statedValueCurrency, "statedValue");
    return {
      ...item,
      collectibleKey,
      quantity: requirePositiveBigInt(item.quantity, "quantity"),
      statedValueAmount: nullableMoney(item.statedValueAmount, "statedValueAmount"),
      statedValueCurrency: nullableCurrency(item.statedValueCurrency, "statedValueCurrency"),
    };
  });
  if (packKey === null && items.every((item) => item.collectibleKey === null)) {
    throw new ProviderCanonicalInputError(
      "A completed pull requires at least one source pack or collectible relationship.",
    );
  }
  if (input.packId !== null && packKey === null) {
    throw new ProviderCanonicalInputError(
      "A resolved pull pack requires its immutable source key.",
    );
  }
  return { pullKey, factDigest, packKey, items };
}

export function providerPullCreateData(input: PullWriteInput, normalized: ReturnType<typeof normalizeProviderPullWrite>,
  pullId: string, itemIds: readonly string[]) {
  const { pullKey, factDigest, packKey, items } = normalized;
  return {
    pull: {
      id: pullId,
      pull_key: pullKey,
      fact_digest: factDigest,
      pack_key: packKey,
      pack_id: input.packId,
      provider_account_id: input.providerAccountId,
      item_count: items.length,
      occurred_at: requireDate(input.occurredAt, "occurredAt"),
      paid_amount: nullableMoney(input.paidAmount, "paidAmount"),
      paid_currency: nullableCurrency(input.paidCurrency, "paidCurrency"),
    },
    items: items.map((item, index) => ({
      id: itemIds[index] ?? randomUUID(),
      pull_id: pullId,
      ordinal: index + 1,
      collectible_key: item.collectibleKey,
      collectible_id: item.collectibleId,
      collectible_instance_id: item.collectibleInstanceId,
      quantity: item.quantity,
      stated_value_amount: item.statedValueAmount,
      stated_value_currency: item.statedValueCurrency,
    })),
  };
}

export function normalizeProviderMarketEventWrite(input: MarketEventWriteInput) {
  const eventKey = requireNonEmptyText(input.eventKey, "eventKey");
  const factDigest = requireDigest(input.factDigest);
  const packKey = nullableText(input.packKey, "packKey");
  const collectibleKey = nullableText(input.collectibleKey, "collectibleKey");
  requirePairedValues(input.amount, input.currency, "amount");
  if (packKey === null && collectibleKey === null) {
    throw new ProviderCanonicalInputError("A market event requires at least one source subject.");
  }
  if (input.packId !== null && packKey === null) {
    throw new ProviderCanonicalInputError(
      "A resolved market-event pack requires its immutable source key.",
    );
  }
  if (input.collectibleId !== null && collectibleKey === null) {
    throw new ProviderCanonicalInputError(
      "A resolved market-event collectible requires its immutable source key.",
    );
  }
  if (input.collectibleInstanceId !== null && input.collectibleId === null) {
    throw new ProviderCanonicalInputError("A collectible instance subject requires its collectible.");
  }
  return { eventKey, factDigest, packKey, collectibleKey };
}

export function providerMarketEventCreateData(input: MarketEventWriteInput,
  normalized: ReturnType<typeof normalizeProviderMarketEventWrite>, id: string) {
  const { eventKey, factDigest, packKey, collectibleKey } = normalized;
  return {
      id,
      event_key: eventKey,
      fact_digest: factDigest,
      event_group_id: input.eventGroupId,
      event_type: input.eventType,
      pack_key: packKey,
      pack_id: input.packId,
      collectible_key: collectibleKey,
      collectible_id: input.collectibleId,
      collectible_instance_id: input.collectibleInstanceId,
      from_provider_account_id: input.fromProviderAccountId,
      to_provider_account_id: input.toProviderAccountId,
      quantity: input.quantity === null ? null : requirePositiveBigInt(input.quantity, "quantity"),
      occurred_at: requireDate(input.occurredAt, "occurredAt"),
      amount: nullableMoney(input.amount, "amount"),
      currency: nullableCurrency(input.currency, "currency"),
      details: toPrismaJson(normalizeJsonObject(input.details, "details")),
  };
}

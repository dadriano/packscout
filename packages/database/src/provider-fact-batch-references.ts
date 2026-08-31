import type { ProviderTransactionClient } from "./provider-database.ts";
import type { CanonicalJsonObject, CanonicalJsonValue } from "./provider-canonical-contract.ts";
import { ProviderMixedCandidateError, type ProviderFactReferenceLookup } from "./provider-mixed-page-candidates.ts";
import type { ProviderMixedPageRecord } from "./provider-mixed-page-contract.ts";

export const PROVIDER_FACT_BATCH_MAX_ITEMS = 1_000;
const MAX_REFERENCE_KEYS = 1_000;

/** Prefetch only raw relationship keys; the existing candidate parser still validates every field. */
export async function readProviderFactBatchReferences(transaction: ProviderTransactionClient,
  records: readonly ProviderMixedPageRecord[]): Promise<ProviderFactReferenceLookup | null> {
  const packs = new Set<string>(), collectibles = new Set<string>();
  const instances = new Set<string>(), accounts = new Set<string>();
  const add = (set: Set<string>, value: CanonicalJsonValue | undefined) => {
    if (typeof value === "string") set.add(value);
  };
  let itemCount = 0;
  for (const record of records) {
    const value = record.candidate;
    add(packs, value.packKey);
    if (record.kind === "pull") {
      add(accounts, value.providerAccountKey);
      if (Array.isArray(value.items)) {
        itemCount += value.items.length;
        if (itemCount > PROVIDER_FACT_BATCH_MAX_ITEMS) return null;
        for (const item of value.items) {
          if (item && typeof item === "object" && !Array.isArray(item)) {
            add(collectibles, (item as CanonicalJsonObject).collectibleKey);
            add(instances, (item as CanonicalJsonObject).collectibleInstanceKey);
          }
        }
      }
    } else {
      add(collectibles, value.collectibleKey); add(instances, value.collectibleInstanceKey);
      add(accounts, value.fromProviderAccountKey); add(accounts, value.toProviderAccountKey);
    }
  }
  if ([packs, collectibles, instances, accounts].some(keys => keys.size > MAX_REFERENCE_KEYS)) return null;
  const packRows = packs.size === 0 ? [] : await transaction.packs.findMany({
    where: { pack_key: { in: [...packs] } }, select: { pack_key: true, id: true }, take: packs.size,
  });
  const collectibleRows = collectibles.size === 0 ? [] : await transaction.collectibles.findMany({
    where: { collectible_key: { in: [...collectibles] } }, select: { collectible_key: true, id: true }, take: collectibles.size,
  });
  const instanceRows = instances.size === 0 ? [] : await transaction.collectible_instances.findMany({
    where: { instance_key: { in: [...instances] } }, select: { instance_key: true, id: true, lifecycle: true }, take: instances.size,
  });
  const accountRows = accounts.size === 0 ? [] : await transaction.provider_accounts.findMany({
    where: { account_key: { in: [...accounts] } }, select: { account_key: true, id: true, lifecycle: true }, take: accounts.size,
  });
  const byPack = new Map(packRows.map(row => [row.pack_key, row.id]));
  const byCollectible = new Map(collectibleRows.map(row => [row.collectible_key, row.id]));
  const byInstance = new Map(instanceRows.map(row => [row.instance_key, row]));
  const byAccount = new Map(accountRows.map(row => [row.account_key, row]));
  const active = (row: { id: string; lifecycle: string } | undefined, field: string) => {
    if (row?.lifecycle !== "active") throw new ProviderMixedCandidateError(field);
    return row.id;
  };
  return {
    pack: async key => key === null ? null : byPack.get(key) ?? null,
    collectible: async key => key === null ? null : byCollectible.get(key) ?? null,
    instance: async (key, field) => active(byInstance.get(key), field),
    account: async (key, field) => key === null ? null : active(byAccount.get(key), field),
  };
}

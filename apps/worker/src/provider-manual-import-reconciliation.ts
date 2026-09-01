import type { FactReferenceReconciliationResult, ProviderFactReferenceScan,
  ProviderFactReferenceTargets, ValidatedProviderMixedPage } from "@packscout/database";

/** Known targets resolve on fact insertion; only arriving catalog keys can unblock old facts. */
export function providerPageFactReferenceTargets(page: ValidatedProviderMixedPage): ProviderFactReferenceTargets {
  const packKeys = new Set<string>();
  const collectibleKeys = new Set<string>();
  for (const record of page.records) {
    if (record.kind !== "catalog" || record.disposition === "quarantine"
      || record.operation === "retire") continue;
    const key = record.entityType === "pack" ? record.candidate.packKey
      : record.entityType === "collectible" ? record.candidate.collectibleKey : null;
    if (typeof key !== "string") continue;
    (record.entityType === "pack" ? packKeys : collectibleKeys).add(key);
  }
  return { packKeys: [...packKeys], collectibleKeys: [...collectibleKeys] };
}

export async function reconcileProviderPageFactReferences(input: {
  page: ValidatedProviderMixedPage;
  reachedHead: boolean;
  signal: AbortSignal;
  maximumBatches: number;
  renewLease(): Promise<boolean>;
  reconcile(scan: ProviderFactReferenceScan): Promise<FactReferenceReconciliationResult | null>;
}): Promise<"complete" | "aborted" | "lease_lost" | "limit_exceeded"> {
  const targets = input.reachedHead ? undefined : providerPageFactReferenceTargets(input.page);
  if (targets && targets.packKeys.length + targets.collectibleKeys.length === 0) return "complete";
  let after: ProviderFactReferenceScan["after"];
  for (let batch = 0; batch < input.maximumBatches; batch += 1) {
    if (input.signal.aborted) return "aborted";
    if (!await input.renewLease()) return "lease_lost";
    const result = await input.reconcile({ ...(targets ? { targets } : {}), ...(after ? { after } : {}) });
    if (result === null) return "lease_lost";
    // One opportunistic batch per source page; durable head scans drain all remaining work.
    if (!input.reachedHead) return "complete";
    // No matches in this keyset page says nothing about later target pages.
    if (result.nextScanCursor === null) return "complete";
    after = result.nextScanCursor;
  }
  return "limit_exceeded";
}

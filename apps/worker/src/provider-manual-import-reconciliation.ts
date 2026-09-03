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

export interface ProviderPageFactReferenceReconciliation {
  page: ValidatedProviderMixedPage;
  reachedHead: boolean;
  signal: AbortSignal;
  maximumBatches: number;
  renewLease(): Promise<boolean>;
  reconcile(scan: ProviderFactReferenceScan): Promise<FactReferenceReconciliationResult | null>;
}

export type ProviderPageFactReferenceOutcome =
  "complete" | "aborted" | "lease_lost" | "limit_exceeded";

export async function reconcileProviderPageFactReferences(
  input: ProviderPageFactReferenceReconciliation,
): Promise<ProviderPageFactReferenceOutcome> {
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

/**
 * Runs the non-head pass, absorbing database faults.
 *
 * That pass is opportunistic by construction: it executes a single batch and
 * discards whatever remains, because the durable head scan drains all remaining
 * work regardless. By the time it runs, the page is committed and the checkpoint
 * has already advanced - so failing to reconcile costs nothing and is undone by
 * the next head scan, while letting the fault propagate fails the run and latches
 * the provider behind a permanent-failure classification. collector_crypt sat
 * blocked for over an hour on a P2028 raised here, holding an intact checkpoint
 * and eight committed pages.
 *
 * Only database faults are absorbed. Anything else is a defect in our own code
 * and must still fail loudly.
 */
export async function reconcileProviderPageFactReferencesOpportunistically(
  input: ProviderPageFactReferenceReconciliation & {
    isDatabaseFailure(error: unknown): boolean;
  },
): Promise<ProviderPageFactReferenceOutcome> {
  try {
    return await reconcileProviderPageFactReferences(input);
  } catch (error) {
    if (!input.isDatabaseFailure(error)) throw error;
    return "complete";
  }
}

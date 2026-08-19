import {
  canonicalJson,
  globalCatalogAggregateObservationV1Schema,
  verifyGlobalCatalogManifestV1,
  type GlobalCatalogAggregateObservationV1,
  type GlobalCatalogManifestV1,
  type GlobalCatalogProviderReferenceV1,
} from "@packscout/contracts";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { refuseCatalogManifest } from "./catalogManifestErrors";
import { loadProviderOperationById } from "./providerReleaseOperations";
import {
  assertStoredProviderReleaseCompletion,
  storedProviderReleaseProof,
} from "./providerReleaseProof";

type ReadCtx = MutationCtx | QueryCtx;

export type ValidatedCatalogManifestProviders = Readonly<{
  providerReleases: readonly Doc<"providerCatalogReleases">[];
}>;

async function oneReferencedProviderRelease(
  ctx: ReadCtx,
  reference: GlobalCatalogProviderReferenceV1,
): Promise<Doc<"providerCatalogReleases">> {
  const releases = await ctx.db
    .query("providerCatalogReleases")
    .withIndex("by_platform_key_and_public_provider_release_id", (index) =>
      index
        .eq("platformKey", reference.platformKey)
        .eq("publicProviderReleaseId", reference.publicProviderReleaseId),
    )
    .take(2);
  if (releases.length > 1) {
    refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
  }
  const release = releases[0];
  if (release === undefined) {
    refuseCatalogManifest("CATALOG_MANIFEST_PROVIDER_RELEASE_MISSING");
  }
  if (
    release.lifecycle !== "complete" ||
    release.completedAt === null ||
    release.completionOperationId === null ||
    release.completionReceiptSha256 === null
  ) {
    refuseCatalogManifest("CATALOG_MANIFEST_PROVIDER_RELEASE_INCOMPLETE");
  }
  if (
    canonicalJson(storedProviderReleaseProof(release)) !==
      canonicalJson(reference)
  ) {
    refuseCatalogManifest("CATALOG_MANIFEST_PROVIDER_REFERENCE_MISMATCH");
  }
  try {
    await assertStoredProviderReleaseCompletion(ctx, release);
  } catch {
    refuseCatalogManifest("CATALOG_MANIFEST_PROVIDER_RELEASE_INCOMPLETE");
  }
  return release;
}

async function assertProviderReleaseNotBlocked(
  ctx: ReadCtx,
  reference: GlobalCatalogProviderReferenceV1,
): Promise<void> {
  const blocks = await ctx.db
    .query("providerCatalogReleaseBlocks")
    .withIndex("by_platform_key_and_provider_release_fingerprint", (index) =>
      index
        .eq("platformKey", reference.platformKey)
        .eq(
          "providerReleaseFingerprint",
          reference.providerReleaseFingerprint,
        ),
    )
    .take(2);
  if (blocks.length > 1) {
    refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
  }
  if (blocks.length !== 0) {
    refuseCatalogManifest("CATALOG_MANIFEST_PROVIDER_RELEASE_BLOCKED");
  }
}

async function loadCompletedHead(
  ctx: ReadCtx,
  platformKey: string,
): Promise<Doc<"providerCatalogCompletedHeads">> {
  const heads = await ctx.db
    .query("providerCatalogCompletedHeads")
    .withIndex("by_platform_key", (index) =>
      index.eq("platformKey", platformKey),
    )
    .take(2);
  if (heads.length > 1) {
    refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
  }
  return heads[0] ??
    refuseCatalogManifest("CATALOG_MANIFEST_PROVIDER_RELEASE_MISSING");
}

async function assertSelectionTerminalProof(
  ctx: ReadCtx,
  reference: GlobalCatalogProviderReferenceV1,
  selection: GlobalCatalogAggregateObservationV1["providerSelections"][number],
): Promise<void> {
  let terminal: Awaited<ReturnType<typeof loadProviderOperationById>>;
  try {
    terminal = await loadProviderOperationById(ctx, selection.terminalOperationId);
  } catch {
    refuseCatalogManifest("CATALOG_MANIFEST_PROVIDER_REFERENCE_MISMATCH");
  }
  if (
    terminal === null ||
    terminal.operation.kind !== selection.terminalOperationKind ||
    terminal.receipt.operationKind !== selection.terminalOperationKind ||
    terminal.operation.platformKey !== reference.platformKey ||
    terminal.operation.publicProviderReleaseId !==
      reference.publicProviderReleaseId ||
    terminal.terminalReceiptSha256 !== selection.terminalReceiptSha256 ||
    canonicalJson(terminal.receipt.details.completedHead.release) !==
      canonicalJson(reference) ||
    canonicalJson(terminal.receipt.details.completedHead.providerCheckpoint) !==
      canonicalJson(selection.selectedProviderCheckpoint) ||
    selection.selectedDataAsOf !== reference.dataAsOf
  ) {
    refuseCatalogManifest("CATALOG_MANIFEST_PROVIDER_REFERENCE_MISMATCH");
  }
}

function selectionLatestFactsCoverHead(
  selection: GlobalCatalogAggregateObservationV1["providerSelections"][number],
  head: Doc<"providerCatalogCompletedHeads">,
): boolean {
  // The completed head proves the selected release/checkpoint, but the signed
  // manifest observation is allowed to report newer settled/source facts while
  // that provider's next release is delayed. Treat the head as a lower bound;
  // equality would make truthful A2/B1 selection and observation refreshes
  // impossible until B completed another release.
  return BigInt(selection.latestAffectedSettledSequence) >=
      BigInt(head.providerCheckpoint.settledSequence) &&
    BigInt(selection.latestAffectedSourceHeadSequence) >=
      BigInt(head.observation.sourceHeadSequence) &&
    Date.parse(selection.lastSuccessfulObservationAt) >=
      Date.parse(head.observation.lastSuccessfulObservationAt) &&
    Date.parse(selection.staleAt) >= Date.parse(head.observation.staleAt);
}

export function catalogSelectionMatchesCompletedHead(
  selection: GlobalCatalogAggregateObservationV1["providerSelections"][number],
  release: Doc<"providerCatalogReleases">,
  head: Doc<"providerCatalogCompletedHeads">,
): boolean {
  return head.releaseId === release._id &&
    head.publicProviderReleaseId === release.publicProviderReleaseId &&
    head.terminalOperationId === selection.terminalOperationId &&
    head.terminalOperationKind === selection.terminalOperationKind &&
    head.terminalReceiptSha256 === selection.terminalReceiptSha256 &&
    canonicalJson(head.providerCheckpoint) ===
      canonicalJson(selection.selectedProviderCheckpoint);
}

export async function validateCatalogManifestProviders(
  ctx: ReadCtx,
  manifestInput: unknown,
  observationInput: unknown,
): Promise<ValidatedCatalogManifestProviders & Readonly<{
  manifest: GlobalCatalogManifestV1;
  observation: GlobalCatalogAggregateObservationV1;
}>> {
  let manifest: GlobalCatalogManifestV1;
  try {
    manifest = await verifyGlobalCatalogManifestV1(manifestInput);
  } catch {
    return refuseCatalogManifest("CATALOG_MANIFEST_RECONCILIATION_FAILED");
  }
  const parsedObservation = globalCatalogAggregateObservationV1Schema.safeParse(
    observationInput,
  );
  if (!parsedObservation.success) {
    refuseCatalogManifest("CATALOG_MANIFEST_FRESHNESS_INVALID");
  }
  const observation = parsedObservation.data;
  if (
    observation.publicReleaseId !== manifest.publicReleaseId ||
    observation.providerReferenceSetHash !== manifest.providerReferenceSetHash ||
    observation.providerSelections.length !== manifest.providerReferences.length
  ) {
    refuseCatalogManifest("CATALOG_MANIFEST_PROVIDER_REFERENCE_MISMATCH");
  }

  const providerReleases: Doc<"providerCatalogReleases">[] = [];
  for (let index = 0; index < manifest.providerReferences.length; index += 1) {
    const reference = manifest.providerReferences[index]!;
    const selection = observation.providerSelections[index]!;
    if (
      selection.platformKey !== reference.platformKey ||
      selection.publicProviderReleaseId !==
        reference.publicProviderReleaseId ||
      canonicalJson(reference.sharedConfigurationEpoch) !==
        canonicalJson(manifest.sharedConfigurationEpoch)
    ) {
      refuseCatalogManifest("CATALOG_MANIFEST_PROVIDER_REFERENCE_MISMATCH");
    }
    const release = await oneReferencedProviderRelease(ctx, reference);
    await assertProviderReleaseNotBlocked(ctx, reference);
    await assertSelectionTerminalProof(ctx, reference, selection);
    providerReleases.push(release);
  }
  return { manifest, observation, providerReleases };
}

export async function assertCatalogManifestSelectionPolicy(
  ctx: MutationCtx,
  manifest: GlobalCatalogManifestV1,
  observation: GlobalCatalogAggregateObservationV1,
  expectedManifest: GlobalCatalogManifestV1 | null,
): Promise<ValidatedCatalogManifestProviders> {
  // The publish role attests the settled PostgreSQL eligibility snapshot and
  // bounded composition proof produced by Task 011. Convex deliberately keeps
  // this transaction O(provider refs): it verifies each exact immutable
  // provider/terminal proof and selection policy, but does not mirror canonical
  // eligibility tables or scan provider entity rows before the pointer CAS.
  const validated = await validateCatalogManifestProviders(
    ctx,
    manifest,
    observation,
  );
  for (let index = 0; index < manifest.providerReferences.length; index += 1) {
    const reference = manifest.providerReferences[index]!;
    const selection = observation.providerSelections[index]!;
    const release = validated.providerReleases[index]!;
    const head = await loadCompletedHead(ctx, reference.platformKey);
    if (!selectionLatestFactsCoverHead(selection, head)) {
      refuseCatalogManifest("CATALOG_MANIFEST_FRESHNESS_INVALID");
    }
    const previousReference = expectedManifest?.providerReferences.find(
      (candidate) => candidate.platformKey === reference.platformKey,
    ) ?? null;
    const isRetainedReference = previousReference !== null &&
      canonicalJson(previousReference) === canonicalJson(reference);
    const mustMatchLatestHead = expectedManifest === null || !isRetainedReference;
    if (
      (mustMatchLatestHead &&
        !catalogSelectionMatchesCompletedHead(selection, release, head)) ||
      !selection.initialBackfillComplete ||
      (mustMatchLatestHead && !selection.affectedDerivationsSettled)
    ) {
      refuseCatalogManifest(
        !selection.initialBackfillComplete
          ? "CATALOG_MANIFEST_BACKFILL_INCOMPLETE"
          : !selection.affectedDerivationsSettled
          ? "CATALOG_MANIFEST_DERIVATION_UNSETTLED"
          : "CATALOG_MANIFEST_PREDECESSOR_CONFLICT",
      );
    }
  }
  return validated;
}

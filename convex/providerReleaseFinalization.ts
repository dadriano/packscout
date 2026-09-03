import { canonicalJson } from "@packscout/contracts";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { refuseProviderRelease } from "./providerReleaseErrors";

function reconciliationFailed(): never {
  refuseProviderRelease("PROVIDER_RELEASE_RECONCILIATION_FAILED");
}

/**
 * Verifies the durable proof accumulated while bounded release batches were
 * accepted. Every batch is validated before its entity writes, batch witness,
 * and these publication aggregates commit atomically. Production code never
 * mutates accepted entity rows while a release remains staging, so finalize
 * must verify this compact proof instead of rereading the release-wide graph.
 */
export async function assertProviderReleaseFinalization(
  ctx: MutationCtx,
  release: Doc<"providerCatalogReleases">,
  publication: Doc<"providerCatalogPublications">,
): Promise<void> {
  if (
    release.counts.vendors !== 1 ||
    release.batchCount < 1 ||
    publication.releaseId !== release._id ||
    publication.platformKey !== release.platformKey ||
    publication.publicProviderReleaseId !== release.publicProviderReleaseId ||
    publication.expectedBatchCount !== release.batchCount ||
    publication.acceptedBatchCount !== release.batchCount ||
    publication.expectedBatchChainHash !== release.batchChainHash ||
    publication.acceptedBatchChainHash !== release.batchChainHash ||
    canonicalJson(publication.expectedCounts) !==
      canonicalJson(release.counts) ||
    canonicalJson(publication.acceptedCounts) !==
      canonicalJson(release.counts) ||
    canonicalJson(publication.acceptedEntityHashes) !==
      canonicalJson(release.entityHashes) ||
    publication.lastBatchKind === null ||
    publication.lastRecordKey === null ||
    publication.acceptedSearchRowCount !== release.counts.repacks ||
    publication.unresolvedRepackCount !== 0 ||
    (publication.latestEvidenceAt !== null &&
      Date.parse(publication.latestEvidenceAt) > Date.now())
  ) {
    reconciliationFailed();
  }

  // The terminal batch is a constant-size witness that the aggregate chain
  // reached the release's declared end. Earlier batch/entity writes cannot be
  // absent independently because each witness and aggregate update is atomic.
  const terminalBatches = await ctx.db
    .query("providerCatalogBatches")
    .withIndex("by_release_id_and_batch_index", (index) =>
      index
        .eq("releaseId", release._id)
        .eq("batchIndex", release.batchCount - 1),
    )
    .take(2);
  const terminalBatch = terminalBatches[0];
  if (
    terminalBatches.length !== 1 ||
    terminalBatch === undefined ||
    terminalBatch.releaseId !== release._id ||
    terminalBatch.platformKey !== release.platformKey ||
    terminalBatch.publicProviderReleaseId !==
      release.publicProviderReleaseId ||
    terminalBatch.batchIndex !== release.batchCount - 1 ||
    terminalBatch.kind !== publication.lastBatchKind ||
    terminalBatch.recordCount < 1 ||
    terminalBatch.chainHash !== release.batchChainHash ||
    terminalBatch.entityHash !== release.entityHashes[terminalBatch.kind]
  ) {
    reconciliationFailed();
  }
}

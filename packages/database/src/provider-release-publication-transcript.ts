import {
  MAX_PROVIDER_CATALOG_RELEASE_BATCH_COUNT,
  type ProviderReleaseFinalizeRequest,
  type ProviderReleaseStartRequest,
} from "@packscout/contracts";
import type { ProviderTransactionClient } from "./provider-database.ts";
import {
  ProviderPublicationCompactProofError,
  verifyProviderPublicationCompactFinalizeProof,
} from "./provider-release-publication-proof.ts";

const PUBLICATION_BATCH_EVIDENCE_SELECT = Object.freeze({
  batch_index: true,
  batch_kind: true,
  batch_hash: true,
  record_count: true,
  byte_count: true,
  release_context_hash: true,
  search_shard_descriptors: true,
} as const);

interface StartOperationBytes {
  readonly operationId: string;
  readonly canonicalRequestBody: string;
  readonly requestSha256: string;
}

export async function verifyProviderPublicationFinalizeTranscript(input: {
  readonly transaction: ProviderTransactionClient;
  readonly providerReleaseId: string;
  readonly terminalRequest: ProviderReleaseFinalizeRequest;
  readonly parseStartRequest: (
    operation: StartOperationBytes,
  ) => ProviderReleaseStartRequest;
}): Promise<void> {
  const starts = await input.transaction.provider_publication_operations
    .findMany({
      where: {
        provider_release_id: input.providerReleaseId,
        operation_kind: "start",
        state: "accepted",
        receipt: { is: { outcome: "accepted" } },
      },
      take: 2,
      select: {
        idempotency_key: true,
        request_digest: true,
        request_bytes: true,
      },
    });
  if (starts.length !== 1) throw new ProviderPublicationCompactProofError();
  const start = starts[0]!;
  const startRequest = input.parseStartRequest({
    operationId: start.idempotency_key,
    canonicalRequestBody: new TextDecoder().decode(start.request_bytes),
    requestSha256: start.request_digest,
  });
  const storedBatches = await input.transaction
    .provider_publication_batch_evidence.findMany({
      where: {
        provider_release_id: input.providerReleaseId,
        operation: {
          is: {
            operation_kind: "applyBatch",
            state: "accepted",
            receipt: { is: { outcome: "accepted" } },
          },
        },
      },
      orderBy: { batch_index: "asc" },
      take: MAX_PROVIDER_CATALOG_RELEASE_BATCH_COUNT + 1,
      select: PUBLICATION_BATCH_EVIDENCE_SELECT,
    });
  await verifyProviderPublicationCompactFinalizeProof({
    startRequest,
    terminalRequest: input.terminalRequest,
    storedBatches,
  });
}

export { PUBLICATION_BATCH_EVIDENCE_SELECT };

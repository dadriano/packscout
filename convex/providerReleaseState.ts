import {
  canonicalJson,
  type ProviderReleaseCompletedHeadStateV1,
  type ProviderReleaseExpectedCompletedHeadV1,
} from "@packscout/contracts";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { refuseProviderRelease } from "./providerReleaseErrors";
import { loadProviderOperationById } from "./providerReleaseOperations";
import {
  assertStoredProviderReleaseCompletion,
  storedProviderReleaseProof,
} from "./providerReleaseProof";

export async function oneProviderCompletedHead(
  ctx: MutationCtx | QueryCtx,
  platformKey: string,
): Promise<Doc<"providerCatalogCompletedHeads"> | null> {
  const heads = await ctx.db
    .query("providerCatalogCompletedHeads")
    .withIndex("by_platform_key", (index) =>
      index.eq("platformKey", platformKey),
    )
    .take(2);
  if (heads.length > 1) {
    refuseProviderRelease("PROVIDER_RELEASE_STATE_CONFLICT");
  }
  return heads[0] ?? null;
}

export async function oneProviderRelease(
  ctx: MutationCtx | QueryCtx,
  platformKey: string,
  publicProviderReleaseId: string,
): Promise<Doc<"providerCatalogReleases"> | null> {
  const releases = await ctx.db
    .query("providerCatalogReleases")
    .withIndex("by_platform_key_and_public_provider_release_id", (index) =>
      index
        .eq("platformKey", platformKey)
        .eq("publicProviderReleaseId", publicProviderReleaseId),
    )
    .take(2);
  if (releases.length > 1) {
    refuseProviderRelease("PROVIDER_RELEASE_STATE_CONFLICT");
  }
  return releases[0] ?? null;
}

export async function oneProviderPublication(
  ctx: MutationCtx,
  publicProviderReleaseId: string,
): Promise<Doc<"providerCatalogPublications"> | null> {
  const publications = await ctx.db
    .query("providerCatalogPublications")
    .withIndex("by_public_provider_release_id", (index) =>
      index.eq("publicProviderReleaseId", publicProviderReleaseId),
    )
    .take(2);
  if (publications.length > 1) {
    refuseProviderRelease("PROVIDER_RELEASE_STATE_CONFLICT");
  }
  return publications[0] ?? null;
}

export function expectedHeadFromStored(
  platformKey: string,
  head: Doc<"providerCatalogCompletedHeads"> | null,
): ProviderReleaseExpectedCompletedHeadV1 {
  return head === null
    ? {
        platformKey,
        publicProviderReleaseId: null,
        sharedConfigurationEpoch: null,
        providerCheckpoint: { settledSequence: "0", settledAt: null },
        observation: null,
        terminalReceiptSha256: null,
      }
    : {
        platformKey: head.platformKey,
        publicProviderReleaseId: head.publicProviderReleaseId,
        sharedConfigurationEpoch: head.sharedConfigurationEpoch,
        providerCheckpoint: head.providerCheckpoint,
        observation: head.observation,
        terminalReceiptSha256: head.terminalReceiptSha256,
      };
}

export function expectedHeadFromPublication(
  publication: Doc<"providerCatalogPublications">,
): ProviderReleaseExpectedCompletedHeadV1 {
  return {
    platformKey: publication.platformKey,
    publicProviderReleaseId:
      publication.expectedCompletedHeadPublicProviderReleaseId,
    sharedConfigurationEpoch:
      publication.expectedCompletedHeadSharedConfigurationEpoch,
    providerCheckpoint: publication.expectedCompletedHeadCheckpoint,
    observation: publication.expectedCompletedHeadObservation,
    terminalReceiptSha256:
      publication.expectedCompletedHeadTerminalReceiptSha256,
  } as ProviderReleaseExpectedCompletedHeadV1;
}

export async function expectedHeadMatchesStored(
  ctx: MutationCtx,
  expected: ProviderReleaseExpectedCompletedHeadV1,
): Promise<boolean> {
  const stored = await oneProviderCompletedHead(ctx, expected.platformKey);
  return canonicalJson(expectedHeadFromStored(expected.platformKey, stored)) ===
    canonicalJson(expected);
}

export async function providerCompletedHeadState(
  ctx: MutationCtx | QueryCtx,
  platformKey: string,
): Promise<ProviderReleaseCompletedHeadStateV1> {
  const head = await oneProviderCompletedHead(ctx, platformKey);
  if (head === null) {
    return {
      platformKey,
      release: null,
      providerCheckpoint: { settledSequence: "0", settledAt: null },
      observation: null,
      terminalReceiptSha256: null,
    };
  }
  const release = await ctx.db.get("providerCatalogReleases", head.releaseId);
  if (
    release === null ||
    release.lifecycle !== "complete" ||
    release.platformKey !== platformKey ||
    release.publicProviderReleaseId !== head.publicProviderReleaseId ||
    canonicalJson(release.sharedConfigurationEpoch) !==
      canonicalJson(head.sharedConfigurationEpoch)
  ) {
    refuseProviderRelease("PROVIDER_RELEASE_STATE_CONFLICT");
  }
  await assertStoredProviderReleaseCompletion(ctx, release);
  const state = {
    platformKey,
    release: storedProviderReleaseProof(release),
    providerCheckpoint: head.providerCheckpoint,
    observation: head.observation,
    terminalReceiptSha256: head.terminalReceiptSha256,
  } satisfies ProviderReleaseCompletedHeadStateV1;
  const terminal = await loadProviderOperationById(
    ctx,
    head.terminalOperationId,
  );
  const completedHeadResult = {
    platformKey,
    release: state.release,
    providerCheckpoint: state.providerCheckpoint,
    observation: state.observation,
  };
  if (
    terminal === null ||
    terminal.operation.kind !== head.terminalOperationKind ||
    terminal.operation.platformKey !== platformKey ||
    terminal.operation.publicProviderReleaseId !==
      release.publicProviderReleaseId ||
    terminal.terminalReceiptSha256 !== head.terminalReceiptSha256 ||
    (terminal.receipt.operationKind !== "finalize" &&
      terminal.receipt.operationKind !== "confirmReuse") ||
    canonicalJson(terminal.receipt.details.completedHead) !==
      canonicalJson(completedHeadResult)
  ) {
    refuseProviderRelease("PROVIDER_RELEASE_STATE_CONFLICT");
  }
  return state;
}

import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { refuseCatalogRetention } from "./catalogRetentionErrors";
import { auditCatalogManifestProviderReferencePage } from
  "./catalogManifestRetentionReferences";

export type CatalogRetentionReferenceAudit = Readonly<{
  snapshotDigest: string;
  phase: "manifests" | "edges";
  cursor: string | null;
  complete: boolean;
  manifestPhaseComplete: boolean;
}>;

export async function loadCatalogRetentionState(
  ctx: MutationCtx,
): Promise<Readonly<{
  generation: number;
  document: Doc<"catalogRetentionState"> | null;
}>> {
  const states = await ctx.db
    .query("catalogRetentionState")
    .withIndex("by_key", (index) => index.eq("key", "singleton"))
    .take(2);
  if (states.length > 1) {
    refuseCatalogRetention("CATALOG_RETENTION_STATE_CONFLICT");
  }
  const document = states[0] ?? null;
  if (
    document !== null &&
    (!Number.isSafeInteger(document.generation) || document.generation <= 0 ||
      (document.referenceAuditComplete &&
        document.referenceAuditCursor !== null) ||
      (document.referenceAuditComplete &&
        document.referenceAuditPhase !== "edges") ||
      (document.manifestPhaseComplete && !document.referenceAuditComplete))
  ) {
    refuseCatalogRetention("CATALOG_RETENTION_STATE_CONFLICT");
  }
  return { generation: document?.generation ?? 0, document };
}

export async function advanceCatalogRetentionReferenceAudit(
  ctx: MutationCtx,
  current: Awaited<ReturnType<typeof loadCatalogRetentionState>>,
  snapshotDigest: string,
): Promise<CatalogRetentionReferenceAudit> {
  if (
    current.document?.referenceAuditSnapshotDigest === snapshotDigest &&
    current.document.referenceAuditComplete
  ) {
    return {
      snapshotDigest,
      phase: "edges",
      cursor: null,
      complete: true,
      manifestPhaseComplete: current.document.manifestPhaseComplete,
    };
  }
  const cursor = current.document?.referenceAuditSnapshotDigest ===
      snapshotDigest
    ? current.document.referenceAuditCursor
    : null;
  const phase = current.document?.referenceAuditSnapshotDigest ===
      snapshotDigest
    ? current.document.referenceAuditPhase
    : "manifests";
  let page;
  try {
    page = await auditCatalogManifestProviderReferencePage(ctx, phase, cursor);
  } catch {
    return refuseCatalogRetention("CATALOG_RETENTION_REFERENCE_INVALID");
  }
  return {
    snapshotDigest,
    phase: page.phase,
    cursor: page.continueCursor,
    complete: page.complete,
    manifestPhaseComplete: false,
  };
}

export async function assertCatalogRetentionGeneration(
  ctx: MutationCtx,
  expectedGeneration: number,
) {
  const state = await loadCatalogRetentionState(ctx);
  if (state.generation !== expectedGeneration) {
    refuseCatalogRetention("CATALOG_RETENTION_PREDECESSOR_CONFLICT");
  }
  return state;
}

export async function advanceCatalogRetentionGeneration(
  ctx: MutationCtx,
  current: Awaited<ReturnType<typeof loadCatalogRetentionState>>,
  updatedAt: string,
  referenceAudit: CatalogRetentionReferenceAudit,
): Promise<number> {
  const generation = current.generation + 1;
  const fields = {
    key: "singleton" as const,
    generation,
    referenceAuditSnapshotDigest: referenceAudit.snapshotDigest,
    referenceAuditPhase: referenceAudit.phase,
    referenceAuditCursor: referenceAudit.cursor,
    referenceAuditComplete: referenceAudit.complete,
    manifestPhaseComplete: referenceAudit.manifestPhaseComplete,
    updatedAt,
  };
  if (current.document === null) {
    await ctx.db.insert("catalogRetentionState", fields);
  } else {
    await ctx.db.replace("catalogRetentionState", current.document._id, fields);
  }
  return generation;
}

import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { refuseCatalogRetention } from "./catalogRetentionErrors";

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
    (!Number.isSafeInteger(document.generation) || document.generation <= 0)
  ) {
    refuseCatalogRetention("CATALOG_RETENTION_STATE_CONFLICT");
  }
  return { generation: document?.generation ?? 0, document };
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
): Promise<number> {
  const generation = current.generation + 1;
  const fields = { key: "singleton" as const, generation, updatedAt };
  if (current.document === null) {
    await ctx.db.insert("catalogRetentionState", fields);
  } else {
    await ctx.db.replace("catalogRetentionState", current.document._id, fields);
  }
  return generation;
}

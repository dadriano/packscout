import {
  PACK_CATALOG_V1,
  PACK_PUBLICATION_REPLAY_LIFETIME_MS,
  evaluatePublicationReplay,
  packCatalogPublicationReceiptSchema,
  packCatalogReceiptDigest,
  packCatalogRequestEntity,
  publicationReasonDefaultState,
  type PackCatalogOperationEntity,
  type PackCatalogPublicationReceipt,
  type PackCatalogPublicationRequest,
  type PublicationOperationResult,
  type PublicationReasonCode,
  type PublicationWorkState,
} from "@packscout/contracts";
import type { MutationCtx } from "./_generated/server";
import { refusePackCatalog } from "./packCatalogErrors";

/**
 * Exact-replay ledger for the V1 store. Every state-changing operation stores
 * one bounded receipt keyed by operation identity and idempotency key. An
 * exact repeat inside the 30-day window returns the stored bytes; a repeat
 * with different bytes is a `conflict`; a repeat after the window is
 * `operation_expired`. Status reads are not operations and store nothing.
 */

type Evidence = Pick<
  PackCatalogPublicationReceipt,
  "snapshotId" | "snapshotState" | "packHead" | "profileHead" | "statusOperation"
>;

export interface ReceiptOutcome extends Evidence {
  readonly result: PublicationOperationResult;
  /** Whether the outcome is durable: exact repeats must return this receipt. */
  readonly store: boolean;
}

export function refused(
  reasonCode: PublicationReasonCode,
  state: PublicationWorkState = publicationReasonDefaultState[reasonCode],
): PublicationOperationResult {
  return { outcome: "refused", state, reasonCode };
}

export function conflict(state: PublicationWorkState): PublicationOperationResult {
  return { outcome: "conflict", state, reasonCode: "ACTIVATION_CONFLICT" };
}

export function applied(
  outcome: "applied" | "already_applied" | "already_active",
  state: PublicationWorkState,
): PublicationOperationResult {
  return { outcome, state, reasonCode: null };
}

export function entityIdentityOf(entity: PackCatalogOperationEntity): string {
  switch (entity.entityKind) {
    case "pack":
      return `pack:${entity.publicRepackId}`;
    case "provider_profile":
      return `provider_profile:${entity.providerId}`;
    case "collectible_profile":
      return `collectible_profile:${entity.publicCollectibleId}`;
    case "catalog":
      return "catalog:pack_catalog_v1";
  }
}

export async function buildPackCatalogReceipt(input: {
  readonly request: PackCatalogPublicationRequest;
  readonly requestSha256: string;
  readonly now: string;
  readonly outcome: Omit<ReceiptOutcome, "store">;
}): Promise<PackCatalogPublicationReceipt> {
  const body = {
    schemaVersion: PACK_CATALOG_V1,
    operationKind: input.request.operationKind,
    operationId: input.request.operationId,
    idempotencyKey: input.request.idempotencyKey,
    requestSha256: input.requestSha256,
    result: input.outcome.result,
    entity: packCatalogRequestEntity(input.request),
    snapshotId: input.outcome.snapshotId,
    snapshotState: input.outcome.snapshotState,
    packHead: input.outcome.packHead,
    profileHead: input.outcome.profileHead,
    statusOperation: input.outcome.statusOperation,
    completedAt: input.now,
    expiresAt: new Date(Date.parse(input.now) + PACK_PUBLICATION_REPLAY_LIFETIME_MS).toISOString(),
  };
  return packCatalogPublicationReceiptSchema.parse({
    ...body,
    receiptDigest: await packCatalogReceiptDigest(body),
  });
}

export async function findPackCatalogReplay(
  ctx: MutationCtx,
  request: PackCatalogPublicationRequest,
  requestSha256: string,
  now: string,
): Promise<PackCatalogPublicationReceipt | null> {
  const [byOperationId, byIdempotencyKey] = await Promise.all([
    ctx.db.query("packCatalogOperations")
      .withIndex("by_operation_id", (index) => index.eq("operationId", request.operationId))
      .take(2),
    ctx.db.query("packCatalogOperations")
      .withIndex("by_idempotency_key", (index) => index.eq("idempotencyKey", request.idempotencyKey))
      .take(2),
  ]);
  if (byOperationId.length > 1 || byIdempotencyKey.length > 1) {
    refusePackCatalog("PACK_CATALOG_STATE_CONFLICT");
  }
  const operation = byOperationId[0] ?? byIdempotencyKey[0] ?? null;
  if (operation === null) return null;
  // A foreign operation identity is not a status capability: another scope's
  // record answers only that this caller may not use that identity.
  if (operation.authorizationScopeSha256 !== request.serviceIdentity.authorizationSha256 ||
    operation.entityIdentity !== entityIdentityOf(packCatalogRequestEntity(request))) {
    return await buildPackCatalogReceipt({
      request,
      requestSha256,
      now,
      outcome: { result: { outcome: "refused", state: "blocked", reasonCode: "AUTHORIZATION_REFUSED" }, snapshotId: null, snapshotState: null, packHead: null, profileHead: null, statusOperation: null },
    });
  }
  const sameIdentity = byOperationId[0]?._id === operation._id &&
    byIdempotencyKey[0]?._id === operation._id &&
    operation.operationKind === request.operationKind;
  const replay = evaluatePublicationReplay({
    record: {
      operationId: operation.operationId,
      idempotencyKey: operation.idempotencyKey,
      authorizationScopeSha256: operation.authorizationScopeSha256,
      entityIdentity: operation.entityIdentity,
      snapshotIdentity: operation.snapshotIdentity,
      requestSha256: operation.requestSha256,
      state: operation.state,
      completedAt: operation.completedAt,
      expiresAt: operation.expiresAt,
    },
    requestSha256,
    now,
  });
  if (replay.outcome === "already_applied" && sameIdentity) {
    const parsed = packCatalogPublicationReceiptSchema.safeParse(JSON.parse(operation.receiptJson));
    if (!parsed.success || parsed.data.receiptDigest !== operation.receiptDigest) {
      refusePackCatalog("PACK_CATALOG_STATE_CONFLICT");
    }
    return parsed.data;
  }
  return await buildPackCatalogReceipt({
    request,
    requestSha256,
    now,
    outcome: {
      result: replay.outcome === "already_applied"
        ? { outcome: "conflict", state: replay.state, reasonCode: "ACTIVATION_CONFLICT" }
        : replay,
      snapshotId: null,
      snapshotState: null,
      packHead: null,
      profileHead: null,
      statusOperation: null,
    },
  });
}

export async function storePackCatalogReceipt(
  ctx: MutationCtx,
  receipt: PackCatalogPublicationReceipt,
  authorizationScopeSha256: string,
): Promise<PackCatalogPublicationReceipt> {
  await ctx.db.insert("packCatalogOperations", {
    operationKind: receipt.operationKind,
    operationId: receipt.operationId,
    idempotencyKey: receipt.idempotencyKey,
    authorizationScopeSha256,
    entityIdentity: entityIdentityOf(receipt.entity),
    snapshotIdentity: receipt.snapshotId ?? "none",
    requestSha256: receipt.requestSha256,
    state: receipt.result.state,
    receiptJson: JSON.stringify(receipt),
    receiptDigest: receipt.receiptDigest,
    completedAt: receipt.completedAt,
    expiresAt: receipt.expiresAt,
  });
  return receipt;
}

/** Looks up one prior operation for a status read; never mutates. */
export async function describeOperation(
  ctx: MutationCtx,
  lookup: { readonly operationId: string; readonly requestSha256: string } | null,
  now: string,
  scope: { readonly authorizationScopeSha256: string; readonly entityIdentity: string },
): Promise<PackCatalogPublicationReceipt["statusOperation"]> {
  if (lookup === null) return null;
  const rows = await ctx.db.query("packCatalogOperations")
    .withIndex("by_operation_id", (index) => index.eq("operationId", lookup.operationId))
    .take(2);
  if (rows.length > 1) refusePackCatalog("PACK_CATALOG_STATE_CONFLICT");
  const operation = rows[0];
  // Records outside the caller's authority and entity read as absent.
  if (operation === undefined || operation.authorizationScopeSha256 !== scope.authorizationScopeSha256 ||
    operation.entityIdentity !== scope.entityIdentity) {
    return { found: false, result: null };
  }
  return {
    found: true,
    result: evaluatePublicationReplay({
      record: {
        operationId: operation.operationId,
        idempotencyKey: operation.idempotencyKey,
        authorizationScopeSha256: operation.authorizationScopeSha256,
        entityIdentity: operation.entityIdentity,
        snapshotIdentity: operation.snapshotIdentity,
        requestSha256: operation.requestSha256,
        state: operation.state,
        completedAt: operation.completedAt,
        expiresAt: operation.expiresAt,
      },
      requestSha256: lookup.requestSha256,
      now,
    }),
  };
}

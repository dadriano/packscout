import {
  publicCollectibleIdSchema,
  publicRepackIdSchema,
} from "@packscout/contracts";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";

const MAX_SAVED_ITEMS_PER_KIND = 250;

type SavedItemsErrorCode =
  | "AUTH_REQUIRED"
  | "AUTH_IDENTITY_INVALID"
  | "INVALID_PUBLIC_REPACK_ID"
  | "INVALID_PUBLIC_COLLECTIBLE_ID"
  | "SAVED_RESOURCE_UNAVAILABLE"
  | "SAVED_ITEM_LIMIT_REACHED"
  | "SAVED_ITEMS_STATE_CONFLICT";

type SavedItemIds = Readonly<{
  savedRepackIds: string[];
  savedCollectibleIds: string[];
}>;

type SetSavedResult = Readonly<{
  saved: boolean;
  prunedUnavailable: boolean;
}>;

const setSavedResultValidator = v.object({
  saved: v.boolean(),
  prunedUnavailable: v.boolean(),
});

function refuse(code: SavedItemsErrorCode): never {
  const message =
    code === "AUTH_REQUIRED"
      ? "Authentication is required to manage saved items."
      : code === "AUTH_IDENTITY_INVALID"
        ? "The authenticated identity is not valid for saved items."
        : code === "INVALID_PUBLIC_REPACK_ID" ||
            code === "INVALID_PUBLIC_COLLECTIBLE_ID"
          ? "The saved-item identifier is invalid."
          : code === "SAVED_RESOURCE_UNAVAILABLE"
            ? "The requested resource is not available in the active release."
            : code === "SAVED_ITEM_LIMIT_REACHED"
              ? "The saved-item limit has been reached."
              : "The saved-item state is inconsistent.";
  throw new ConvexError({ code, message });
}

async function requireOwner(ctx: Pick<QueryCtx, "auth">): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) refuse("AUTH_REQUIRED");
  const ownerTokenIdentifier = identity.tokenIdentifier;
  if (
    ownerTokenIdentifier.length === 0 ||
    ownerTokenIdentifier.length > 1_024
  ) {
    refuse("AUTH_IDENTITY_INVALID");
  }
  return ownerTokenIdentifier;
}

function validatePublicRepackId(publicRepackId: string): void {
  if (!publicRepackIdSchema.safeParse(publicRepackId).success) {
    refuse("INVALID_PUBLIC_REPACK_ID");
  }
}

function validatePublicCollectibleId(publicCollectibleId: string): void {
  if (!publicCollectibleIdSchema.safeParse(publicCollectibleId).success) {
    refuse("INVALID_PUBLIC_COLLECTIBLE_ID");
  }
}

async function activeCompleteReleaseId(
  ctx: MutationCtx,
): Promise<Id<"dataReleases">> {
  const states = await ctx.db
    .query("dataReleaseState")
    .withIndex("by_key", (index) => index.eq("key", "singleton"))
    .take(2);
  if (states.length !== 1 || states[0]!.activeReleaseId === null) {
    refuse("SAVED_RESOURCE_UNAVAILABLE");
  }
  const releaseId = states[0]!.activeReleaseId;
  const release = await ctx.db.get("dataReleases", releaseId);
  if (release === null || release.lifecycle !== "complete") {
    refuse("SAVED_RESOURCE_UNAVAILABLE");
  }
  return releaseId;
}

async function activeRepackExists(
  ctx: MutationCtx,
  releaseId: Id<"dataReleases">,
  publicRepackId: string,
): Promise<boolean> {
  const matches = await ctx.db
    .query("repacks")
    .withIndex("by_release_id_and_public_repack_id", (index) =>
      index.eq("releaseId", releaseId).eq("publicRepackId", publicRepackId),
    )
    .take(2);
  if (
    matches.length > 1 ||
    (matches[0] !== undefined &&
      matches[0].detail.publicRepackId !== publicRepackId)
  ) {
    refuse("SAVED_ITEMS_STATE_CONFLICT");
  }
  return matches.length === 1;
}

async function activeCollectibleExists(
  ctx: MutationCtx,
  releaseId: Id<"dataReleases">,
  publicCollectibleId: string,
): Promise<boolean> {
  const matches = await ctx.db
    .query("collectibles")
    .withIndex("by_release_id_and_public_collectible_id", (index) =>
      index
        .eq("releaseId", releaseId)
        .eq("publicCollectibleId", publicCollectibleId),
    )
    .take(2);
  if (
    matches.length > 1 ||
    (matches[0] !== undefined &&
      matches[0].detail.publicCollectibleId !== publicCollectibleId)
  ) {
    refuse("SAVED_ITEMS_STATE_CONFLICT");
  }
  return matches.length === 1;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareSavedItemCandidateOrder(
  leftCreationTime: number,
  leftPublicId: string,
  rightCreationTime: number,
  rightPublicId: string,
): number {
  return (
    leftCreationTime - rightCreationTime ||
    compareText(leftPublicId, rightPublicId)
  );
}

async function firstUnavailableSavedRepack(
  ctx: MutationCtx,
  releaseId: Id<"dataReleases">,
  savedItems: readonly Doc<"savedRepacks">[],
): Promise<Doc<"savedRepacks"> | null> {
  const candidates = [...savedItems].sort((left, right) =>
    compareSavedItemCandidateOrder(
      left._creationTime,
      left.publicRepackId,
      right._creationTime,
      right.publicRepackId,
    ),
  );
  for (const candidate of candidates) {
    if (!(await activeRepackExists(ctx, releaseId, candidate.publicRepackId))) {
      return candidate;
    }
  }
  return null;
}

async function firstUnavailableSavedCollectible(
  ctx: MutationCtx,
  releaseId: Id<"dataReleases">,
  savedItems: readonly Doc<"savedCollectibles">[],
): Promise<Doc<"savedCollectibles"> | null> {
  const candidates = [...savedItems].sort((left, right) =>
    compareSavedItemCandidateOrder(
      left._creationTime,
      left.publicCollectibleId,
      right._creationTime,
      right.publicCollectibleId,
    ),
  );
  for (const candidate of candidates) {
    if (
      !(await activeCollectibleExists(
        ctx,
        releaseId,
        candidate.publicCollectibleId,
      ))
    ) {
      return candidate;
    }
  }
  return null;
}

export const getSavedItemIds = query({
  args: {},
  returns: v.object({
    savedRepackIds: v.array(v.string()),
    savedCollectibleIds: v.array(v.string()),
  }),
  handler: async (ctx): Promise<SavedItemIds> => {
    const ownerTokenIdentifier = await requireOwner(ctx);
    const [savedRepacks, savedCollectibles] = await Promise.all([
      ctx.db
        .query("savedRepacks")
        .withIndex("by_owner_token_identifier_and_public_repack_id", (index) =>
          index.eq("ownerTokenIdentifier", ownerTokenIdentifier),
        )
        .take(MAX_SAVED_ITEMS_PER_KIND + 1),
      ctx.db
        .query("savedCollectibles")
        .withIndex(
          "by_owner_token_identifier_and_public_collectible_id",
          (index) => index.eq("ownerTokenIdentifier", ownerTokenIdentifier),
        )
        .take(MAX_SAVED_ITEMS_PER_KIND + 1),
    ]);
    if (
      savedRepacks.length > MAX_SAVED_ITEMS_PER_KIND ||
      savedCollectibles.length > MAX_SAVED_ITEMS_PER_KIND
    ) {
      refuse("SAVED_ITEMS_STATE_CONFLICT");
    }
    return {
      savedRepackIds: savedRepacks
        .map(({ publicRepackId }) => publicRepackId)
        .sort(),
      savedCollectibleIds: savedCollectibles
        .map(({ publicCollectibleId }) => publicCollectibleId)
        .sort(),
    };
  },
});

export const setSavedRepack = mutation({
  args: { publicRepackId: v.string(), saved: v.boolean() },
  returns: setSavedResultValidator,
  handler: async (ctx, args): Promise<SetSavedResult> => {
    const ownerTokenIdentifier = await requireOwner(ctx);
    validatePublicRepackId(args.publicRepackId);
    const matches = await ctx.db
      .query("savedRepacks")
      .withIndex("by_owner_token_identifier_and_public_repack_id", (index) =>
        index
          .eq("ownerTokenIdentifier", ownerTokenIdentifier)
          .eq("publicRepackId", args.publicRepackId),
      )
      .take(2);
    if (matches.length > 1) refuse("SAVED_ITEMS_STATE_CONFLICT");

    if (!args.saved) {
      if (matches[0] !== undefined) {
        await ctx.db.delete("savedRepacks", matches[0]._id);
      }
      return { saved: false, prunedUnavailable: false };
    }

    const releaseId = await activeCompleteReleaseId(ctx);
    if (!(await activeRepackExists(ctx, releaseId, args.publicRepackId))) {
      refuse("SAVED_RESOURCE_UNAVAILABLE");
    }
    if (matches[0] !== undefined) {
      return { saved: true, prunedUnavailable: false };
    }
    const savedItems = await ctx.db
      .query("savedRepacks")
      .withIndex("by_owner_token_identifier_and_public_repack_id", (index) =>
        index.eq("ownerTokenIdentifier", ownerTokenIdentifier),
      )
      .take(MAX_SAVED_ITEMS_PER_KIND + 1);
    if (savedItems.length > MAX_SAVED_ITEMS_PER_KIND) {
      refuse("SAVED_ITEMS_STATE_CONFLICT");
    }
    let prunedUnavailable = false;
    if (savedItems.length === MAX_SAVED_ITEMS_PER_KIND) {
      const stale = await firstUnavailableSavedRepack(
        ctx,
        releaseId,
        savedItems,
      );
      if (stale === null) refuse("SAVED_ITEM_LIMIT_REACHED");
      await ctx.db.delete("savedRepacks", stale._id);
      prunedUnavailable = true;
    }
    await ctx.db.insert("savedRepacks", {
      ownerTokenIdentifier,
      publicRepackId: args.publicRepackId,
    });
    return { saved: true, prunedUnavailable };
  },
});

export const setSavedCollectible = mutation({
  args: { publicCollectibleId: v.string(), saved: v.boolean() },
  returns: setSavedResultValidator,
  handler: async (ctx, args): Promise<SetSavedResult> => {
    const ownerTokenIdentifier = await requireOwner(ctx);
    validatePublicCollectibleId(args.publicCollectibleId);
    const matches = await ctx.db
      .query("savedCollectibles")
      .withIndex(
        "by_owner_token_identifier_and_public_collectible_id",
        (index) =>
          index
            .eq("ownerTokenIdentifier", ownerTokenIdentifier)
            .eq("publicCollectibleId", args.publicCollectibleId),
      )
      .take(2);
    if (matches.length > 1) refuse("SAVED_ITEMS_STATE_CONFLICT");

    if (!args.saved) {
      if (matches[0] !== undefined) {
        await ctx.db.delete("savedCollectibles", matches[0]._id);
      }
      return { saved: false, prunedUnavailable: false };
    }

    const releaseId = await activeCompleteReleaseId(ctx);
    if (
      !(await activeCollectibleExists(ctx, releaseId, args.publicCollectibleId))
    ) {
      refuse("SAVED_RESOURCE_UNAVAILABLE");
    }
    if (matches[0] !== undefined) {
      return { saved: true, prunedUnavailable: false };
    }
    const savedItems = await ctx.db
      .query("savedCollectibles")
      .withIndex(
        "by_owner_token_identifier_and_public_collectible_id",
        (index) => index.eq("ownerTokenIdentifier", ownerTokenIdentifier),
      )
      .take(MAX_SAVED_ITEMS_PER_KIND + 1);
    if (savedItems.length > MAX_SAVED_ITEMS_PER_KIND) {
      refuse("SAVED_ITEMS_STATE_CONFLICT");
    }
    let prunedUnavailable = false;
    if (savedItems.length === MAX_SAVED_ITEMS_PER_KIND) {
      const stale = await firstUnavailableSavedCollectible(
        ctx,
        releaseId,
        savedItems,
      );
      if (stale === null) refuse("SAVED_ITEM_LIMIT_REACHED");
      await ctx.db.delete("savedCollectibles", stale._id);
      prunedUnavailable = true;
    }
    await ctx.db.insert("savedCollectibles", {
      ownerTokenIdentifier,
      publicCollectibleId: args.publicCollectibleId,
    });
    return { saved: true, prunedUnavailable };
  },
});

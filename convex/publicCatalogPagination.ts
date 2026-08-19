import type { ListPublicRepacksInput } from "@packscout/contracts";
import type { QueryCtx } from "./_generated/server";
import { retainedPublicCatalogManifestExists } from "./publicCatalogManifestReadModel";
import {
  createQueryFingerprint,
  decodeRepackCursor,
  validateCursorSet,
} from "./publicRepackValidation";

export type PublicCatalogPaginationResolution =
  | { readonly ok: false; readonly code: "INVALID_QUERY" | "CURSOR_EXPIRED" }
  | {
      readonly ok: true;
      readonly offset: number;
      readonly paginationReset: "release_changed" | null;
    };

export async function resolvePublicCatalogPagination(
  ctx: QueryCtx,
  input: ListPublicRepacksInput,
  activePublicReleaseId: string,
  activeFingerprint: string,
): Promise<PublicCatalogPaginationResolution> {
  if (input.cursor === null) {
    const stack = validateCursorSet({
      cursor: null,
      cursorStack: input.cursorStack,
      expectedFingerprint: activeFingerprint,
      expectedReleaseId: activePublicReleaseId,
      pageSize: input.pageSize,
    });
    if (!stack.ok || stack.value.stack.length > 0) {
      return { ok: false, code: "INVALID_QUERY" };
    }
    return {
      ok: true,
      offset: 0,
      paginationReset:
        input.queryFingerprint !== null &&
        input.queryFingerprint !== activeFingerprint
          ? "release_changed"
          : null,
    };
  }

  const cursor = decodeRepackCursor(input.cursor);
  if (cursor === null || input.queryFingerprint !== cursor.queryFingerprint) {
    return { ok: false, code: "INVALID_QUERY" };
  }
  const expectedFingerprint = await createQueryFingerprint(
    cursor.publicReleaseId,
    input,
  );
  if (expectedFingerprint !== cursor.queryFingerprint) {
    return { ok: false, code: "INVALID_QUERY" };
  }
  const cursorSet = validateCursorSet({
    cursor: input.cursor,
    cursorStack: input.cursorStack,
    expectedFingerprint,
    expectedReleaseId: cursor.publicReleaseId,
    pageSize: input.pageSize,
  });
  if (!cursorSet.ok) return { ok: false, code: "INVALID_QUERY" };
  if (cursor.publicReleaseId === activePublicReleaseId) {
    return { ok: true, offset: cursor.offset, paginationReset: null };
  }
  return await retainedPublicCatalogManifestExists(
    ctx,
    cursor.publicReleaseId,
  )
    ? { ok: true, offset: 0, paginationReset: "release_changed" }
    : { ok: false, code: "CURSOR_EXPIRED" };
}

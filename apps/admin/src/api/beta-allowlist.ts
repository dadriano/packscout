import type {
  BetaAllowlistEntryChange,
  BetaAllowlistPage,
  BetaAllowlistRemoval,
  CreateBetaAllowlistEntryRequest,
  ListBetaAllowlistRequest,
  UpdateBetaAllowlistEntryRequest,
} from "@packscout/contracts";
import { requestJson } from "./client";

/**
 * The browser's only route to the beta allowlist. The admin server owns the
 * integration with the product backend; nothing here knows its address or its
 * credential. Email addresses, wallet addresses, search terms, and cursors
 * travel in request bodies so personal data never lands in a request URL, the
 * browser history, or an access log.
 */
export function listBetaAllowlist(
  request: ListBetaAllowlistRequest = {},
  signal?: AbortSignal,
): Promise<BetaAllowlistPage> {
  return requestJson("/beta-allowlist/list", {
    method: "POST",
    json: request,
    ...(signal ? { signal } : {}),
  });
}

/**
 * Adds an allowlist entry. The acting operator is the signed-in session; the
 * request cannot name one. The response reports how many waiting accounts the
 * entry admitted on the spot, which the caller must surface — it is the
 * difference between "added to a list" and "this person is in".
 */
export function createBetaAllowlistEntry(
  request: CreateBetaAllowlistEntryRequest,
): Promise<BetaAllowlistEntryChange> {
  return requestJson("/beta-allowlist/create", { method: "POST", json: request });
}

/**
 * Edits an entry with the same validation as adding. An omitted field keeps
 * its stored value and an explicit null clears it. The response reports any
 * waiting accounts the edited identifiers admitted.
 */
export function updateBetaAllowlistEntry(
  request: UpdateBetaAllowlistEntryRequest,
): Promise<BetaAllowlistEntryChange> {
  return requestJson("/beta-allowlist/update", { method: "POST", json: request });
}

/**
 * Removes an entry. This stops future automatic admission for the entry's
 * identifiers and changes no existing access decision — anyone already
 * approved keeps their access. `removed: false` means the entry was already
 * gone, so repeated actions converge.
 */
export function removeBetaAllowlistEntry(
  entryId: string,
): Promise<BetaAllowlistRemoval> {
  return requestJson("/beta-allowlist/remove", {
    method: "POST",
    json: { entryId },
  });
}

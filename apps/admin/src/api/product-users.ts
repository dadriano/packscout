import type {
  ListProductUserAccessQueueRequest,
  ListProductUsersRequest,
  ProductUserAccessAction,
  ProductUserAccessDecisionChange,
  ProductUserAccessQueueCount,
  ProductUserAccessQueuePage,
  ProductUserDetail,
  ProductUserDirectoryPage,
  ProductUserStanding,
  ProductUserStandingChange,
} from "@packscout/contracts";
import { requestJson } from "./client";

/**
 * The browser's only route to product-user data. The admin server owns the
 * integration with the product backend; nothing here knows its address or its
 * credential. Search terms, subject keys, and cursors travel in the request
 * body so personal data never lands in a request URL or an access log.
 */
export function listProductUsers(
  request: ListProductUsersRequest = {},
  signal?: AbortSignal,
): Promise<ProductUserDirectoryPage> {
  return requestJson("/product-users/list", {
    method: "POST",
    json: request,
    ...(signal ? { signal } : {}),
  });
}

/**
 * One user's identity summary and both saved-item collections, already
 * resolved against the active catalog by the product backend. This surface
 * reads; there is no browser call that changes what a user has saved.
 */
export function getProductUserDetail(
  subject: string,
  signal?: AbortSignal,
): Promise<ProductUserDetail> {
  return requestJson("/product-users/detail", {
    method: "POST",
    json: { subject },
    ...(signal ? { signal } : {}),
  });
}

/**
 * Sets one user's standing. The call names the standing it wants rather than
 * an operation, so acting on a stale row or clicking twice converges on the
 * same result instead of toggling the account back and forth. The response
 * carries the standing the backend now holds, which is what the caller should
 * render — not the one that was asked for.
 *
 * This is the only product-user call that changes anything, and all it changes
 * is standing: no browser call deletes a user or touches what they saved.
 */
export function setProductUserStanding(
  subject: string,
  standing: ProductUserStanding,
): Promise<ProductUserStandingChange> {
  return requestJson("/product-users/standing", {
    method: "POST",
    json: { subject, standing },
  });
}

/**
 * One bounded page of the review queue: identities in one decision state —
 * awaiting review unless another is named — oldest request first. The state
 * filter and cursor travel in the body like every other product-user request.
 */
export function listProductUserAccessQueue(
  request: ListProductUserAccessQueueRequest = {},
  signal?: AbortSignal,
): Promise<ProductUserAccessQueuePage> {
  return requestJson("/product-users/access/queue", {
    method: "POST",
    json: request,
    ...(signal ? { signal } : {}),
  });
}

/**
 * The bounded awaiting-review count for the page header. It carries no
 * personal data — a number, and whether the counting bound was hit.
 */
export function getProductUserAccessQueueCount(
  signal?: AbortSignal,
): Promise<ProductUserAccessQueueCount> {
  return requestJson("/product-users/access/queue-count", {
    method: "POST",
    json: {},
    ...(signal ? { signal } : {}),
  });
}

/**
 * One access decision. The action names the endpoint — approve, decline, or
 * revoke — from the closed contract vocabulary, and the body names only the
 * person; the acting operator is always the session on the server. The
 * response carries the decision the backend now holds, which is what the
 * caller should render: a repeat or a concurrent decision converges there and
 * reports `changed: false` with the authoritative state.
 *
 * These are reversible flips. No browser call deletes a user, touches what
 * they saved, or changes their standing through this surface.
 */
export function decideProductUserAccess(
  action: ProductUserAccessAction,
  subject: string,
): Promise<ProductUserAccessDecisionChange> {
  return requestJson(`/product-users/access/${action}`, {
    method: "POST",
    json: { subject },
  });
}

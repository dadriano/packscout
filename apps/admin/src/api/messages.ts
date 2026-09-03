import type {
  ListMessageDeliveriesRequest,
  MessageDeliveryCounts,
  MessageDeliveryDetail,
  MessageDeliveryListPage,
  MessageDeliveryRetryResponse,
} from "@packscout/contracts";
import { requestJson } from "./client";

/**
 * The browser's only route to the message-delivery history. Every read is a
 * POST with a request body: recipient addresses and search terms are personal
 * data, and a body can never land in a URL, the browser history, a referrer,
 * or an access log. Intent identities are the queue's own opaque UUIDs.
 */
export function listMessageDeliveries(
  request: ListMessageDeliveriesRequest = {},
  signal?: AbortSignal,
): Promise<MessageDeliveryListPage> {
  return requestJson("/messages/list", {
    method: "POST",
    json: request,
    ...(signal ? { signal } : {}),
  });
}

/** Queue depth by state, so a stuck queue is noticed rather than discovered. */
export function countMessageDeliveries(
  signal?: AbortSignal,
): Promise<MessageDeliveryCounts> {
  return requestJson("/messages/counts", {
    method: "POST",
    json: {},
    ...(signal ? { signal } : {}),
  });
}

/** One intent with its full attempt history, newest attempt last. */
export function getMessageDelivery(
  intentId: string,
  signal?: AbortSignal,
): Promise<MessageDeliveryDetail> {
  return requestJson("/messages/detail", {
    method: "POST",
    json: { intentId },
    ...(signal ? { signal } : {}),
  });
}

/**
 * Retries one terminally failed delivery by re-entering it into the normal
 * queue — the background drain delivers it; nothing is sent inline. The
 * server refuses any intent that is not terminally failed, and concurrent
 * retries of the same intent converge on one.
 */
export function retryMessageDelivery(
  intentId: string,
): Promise<MessageDeliveryRetryResponse> {
  return requestJson("/messages/retry", {
    method: "POST",
    json: { intentId },
  });
}

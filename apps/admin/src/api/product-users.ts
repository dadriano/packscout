import type {
  ListProductUsersRequest,
  ProductUserDirectoryPage,
} from "@packscout/contracts";
import { requestJson } from "./client";

/**
 * The browser's only route to product-user data. The admin server owns the
 * integration with the product backend; nothing here knows its address or its
 * credential. Search terms and cursors travel in the request body so personal
 * data never lands in a URL, browser history, or an access log.
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

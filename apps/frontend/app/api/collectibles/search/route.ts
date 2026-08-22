import {
  createAccessGuardedHandler,
  resolveVisitorAccessForRequest,
} from "@/lib/access-gate.server";
import { createDesiredCollectibleSearchHandler } from "@/lib/desired-collectible-search-route.server";
import { searchPublicCollectibles } from "@/lib/public-repacks.server";

export const dynamic = "force-dynamic";

/**
 * Catalog search serves product data, so it requires an admitted caller
 * (closed-beta-access/007): the guard resolves the identity cookie against
 * the product backend before the query is even parsed, refuses unadmitted
 * callers with a fixed non-leaking outcome, and passes through untouched for
 * admitted visitors and whenever the beta switch is off.
 */
export const GET = createAccessGuardedHandler(
  resolveVisitorAccessForRequest,
  createDesiredCollectibleSearchHandler(searchPublicCollectibles),
);

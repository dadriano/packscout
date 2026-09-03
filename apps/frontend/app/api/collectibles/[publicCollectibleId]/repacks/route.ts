import {
  createAccessGuardedHandler,
  resolveVisitorAccessForRequest,
} from "@/lib/access-gate.server";
import { createDesiredCollectibleRepacksHandler } from "@/lib/desired-collectible-repacks-route.server";
import { readRepacksByDesiredCollectible } from "@/lib/public-repacks.server";

export const dynamic = "force-dynamic";

/**
 * Chase-collectible pack lookup serves product data, so it requires an
 * admitted caller (closed-beta-access/007): the guard resolves the identity
 * cookie against the product backend before the path is even parsed.
 */
export const GET = createAccessGuardedHandler(
  resolveVisitorAccessForRequest,
  createDesiredCollectibleRepacksHandler(readRepacksByDesiredCollectible),
);

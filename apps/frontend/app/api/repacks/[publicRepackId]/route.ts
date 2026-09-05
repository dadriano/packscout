import {
  createAccessGuardedHandler,
  resolveVisitorAccessForRequest,
} from "@/lib/access-gate.server";
import { createPublicRepackDetailHandler } from "@/lib/public-repack-detail-route.server";
import {
  readPublicRepack,
  readPublicShellStatus,
} from "@/lib/public-repacks.server";

export const dynamic = "force-dynamic";

/**
 * Pack detail serves product data, so it requires an admitted caller
 * (closed-beta-access/007): the guard resolves the identity cookie against
 * the product backend before the path is even parsed.
 */
export const GET = createAccessGuardedHandler(
  resolveVisitorAccessForRequest,
  createPublicRepackDetailHandler(readPublicShellStatus, readPublicRepack),
);

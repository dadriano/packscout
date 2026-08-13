import { createDesiredCollectibleSearchHandler } from "@/lib/desired-collectible-search-route.server";
import { searchPublicCollectibles } from "@/lib/public-repacks.server";

export const dynamic = "force-dynamic";

export const GET = createDesiredCollectibleSearchHandler(
  searchPublicCollectibles,
);

import { fetchAction, fetchQuery } from "convex/nextjs";
import {
  publicReadError,
  type DashboardQueryInput,
  type FindRepacksByDesiredCollectibleInput,
  type GetPublicRepackInput,
  type ListPublicRepacksInput,
  type SearchPublicCollectiblesInput,
} from "@packscout/contracts";
import { api } from "../../../convex/_generated/api";
import {
  parseFindRepacksByDesiredCollectibleV3Result,
  parseGetPublicCatalogRecordUpdateStatusV3Result,
  parseGetDashboardBundleV3Result,
  parseGetPublicRepackV3Result,
  parseGetPublicShellStatusV3Result,
  parseListPublicRepacksV3Result,
  parseSearchPublicCollectiblesV3Result,
  type FindRepacksByDesiredCollectibleV3Result,
  type GetPublicCatalogRecordUpdateStatusV3Result,
  type GetDashboardBundleV3Result,
  type GetPublicRepackV3Result,
  type GetPublicShellStatusV3Result,
  type ListPublicRepacksV3Result,
  type SearchPublicCollectiblesV3Result,
} from "./public-repacks-v3";
import { catalogReadArguments, catalogReadOrigin, type CatalogReadEnvironment } from "./catalog-read-access.server";

/**
 * Server-side reads against the data_release_v3 public API. Time-sensitive
 * views use Convex actions so the backend, not this Next.js process or a URL,
 * mints the authoritative confidence/provider-health clock. Every read
 * presents the server-held catalog credential on that same round trip and
 * re-validates the result against the strict v3 contracts before rendering.
 */

export function publicRepackReadsConfigured(
  environment: CatalogReadEnvironment = process.env,
): boolean {
  return catalogReadOrigin(environment) !== null;
}

export async function readPublicShellStatus(): Promise<GetPublicShellStatusV3Result> {
  const url = catalogReadOrigin();
  if (url === null) return publicReadError("RELEASE_UNAVAILABLE");
  try {
    return parseGetPublicShellStatusV3Result(
      await fetchAction(
        api.publicRepacksV3.getPublicShellStatusV3,
        catalogReadArguments({}),
        { url },
      ),
    );
  } catch {
    return publicReadError("RELEASE_UNAVAILABLE");
  }
}

export async function readPublicCatalogRecordUpdateStatus(): Promise<GetPublicCatalogRecordUpdateStatusV3Result> {
  const url = catalogReadOrigin();
  if (url === null) return publicReadError("RELEASE_UNAVAILABLE");
  try {
    return parseGetPublicCatalogRecordUpdateStatusV3Result(
      await fetchAction(
        api.publicRepacksV3.getPublicCatalogRecordUpdateStatusV3,
        catalogReadArguments({}),
        { url },
      ),
    );
  } catch {
    return publicReadError("RELEASE_UNAVAILABLE");
  }
}

export async function readDashboardBundle(
  input: DashboardQueryInput,
): Promise<GetDashboardBundleV3Result> {
  const url = catalogReadOrigin();
  if (url === null) return publicReadError("RELEASE_UNAVAILABLE");
  try {
    return parseGetDashboardBundleV3Result(
      await fetchAction(
        api.publicRepacksV3.getDashboardBundleV3,
        catalogReadArguments({ ...input }),
        { url },
      ),
    );
  } catch {
    return publicReadError("RELEASE_UNAVAILABLE");
  }
}

export async function readPublicRepacks(
  input: ListPublicRepacksInput,
): Promise<ListPublicRepacksV3Result> {
  const url = catalogReadOrigin();
  if (url === null) return publicReadError("RELEASE_UNAVAILABLE");
  try {
    return parseListPublicRepacksV3Result(
      await fetchAction(
        api.publicRepacksV3.listPublicRepacksV3,
        catalogReadArguments({ ...input }),
        { url },
      ),
    );
  } catch {
    return publicReadError("RELEASE_UNAVAILABLE");
  }
}

export async function readPublicRepack(
  input: GetPublicRepackInput,
): Promise<GetPublicRepackV3Result> {
  const url = catalogReadOrigin();
  if (url === null) return publicReadError("RELEASE_UNAVAILABLE");
  try {
    return parseGetPublicRepackV3Result(
      await fetchAction(
        api.publicRepacksV3.getPublicRepackV3,
        catalogReadArguments({ ...input }),
        { url },
      ),
    );
  } catch {
    return publicReadError("RELEASE_UNAVAILABLE");
  }
}

export async function searchPublicCollectibles(
  input: SearchPublicCollectiblesInput,
): Promise<SearchPublicCollectiblesV3Result> {
  const url = catalogReadOrigin();
  if (url === null) return publicReadError("RELEASE_UNAVAILABLE");
  try {
    return parseSearchPublicCollectiblesV3Result(
      await fetchQuery(
        api.publicRepacksV3.searchPublicCollectiblesV3,
        catalogReadArguments({ ...input }),
        { url },
      ),
    );
  } catch {
    return publicReadError("RELEASE_UNAVAILABLE");
  }
}

export async function readRepacksByDesiredCollectible(
  input: FindRepacksByDesiredCollectibleInput,
): Promise<FindRepacksByDesiredCollectibleV3Result> {
  const url = catalogReadOrigin();
  if (url === null) return publicReadError("RELEASE_UNAVAILABLE");
  try {
    return parseFindRepacksByDesiredCollectibleV3Result(
      await fetchAction(
        api.publicRepacksV3.findRepacksByDesiredCollectibleV3,
        catalogReadArguments({ ...input }),
        { url },
      ),
    );
  } catch {
    return publicReadError("RELEASE_UNAVAILABLE");
  }
}

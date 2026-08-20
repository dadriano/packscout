import { fetchQuery } from "convex/nextjs";
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
  parseGetDashboardBundleV3Result,
  parseGetPublicRepackV3Result,
  parseGetPublicShellStatusV3Result,
  parseListPublicRepacksV3Result,
  parseSearchPublicCollectiblesV3Result,
  type FindRepacksByDesiredCollectibleV3Result,
  type GetDashboardBundleV3Result,
  type GetPublicRepackV3Result,
  type GetPublicShellStatusV3Result,
  type ListPublicRepacksV3Result,
  type SearchPublicCollectiblesV3Result,
} from "./public-repacks-v3";
import { readPublicConvexOrigin } from "./security-policy.server";

/**
 * Server-side reads against the data_release_v3 public queries. Every read
 * carries the server clock so the backend can apply its authoritative
 * deadline conversion, and every result is re-validated against the strict
 * v3 contracts before rendering.
 */

type PublicRepacksEnvironment = Readonly<{
  NODE_ENV?: string;
  NEXT_PUBLIC_CONVEX_URL?: string;
}>;

function convexUrl(environment: PublicRepacksEnvironment = process.env): string | null {
  try {
    return readPublicConvexOrigin(environment);
  } catch {
    return null;
  }
}

export function publicRepackReadsConfigured(
  environment: PublicRepacksEnvironment = process.env,
): boolean {
  return convexUrl(environment) !== null;
}

export async function readPublicShellStatus(): Promise<GetPublicShellStatusV3Result> {
  const url = convexUrl();
  if (url === null) return publicReadError("RELEASE_UNAVAILABLE");
  try {
    return parseGetPublicShellStatusV3Result(
      await fetchQuery(api.publicRepacksV3.getPublicShellStatusV3, {}, { url }),
    );
  } catch {
    return publicReadError("RELEASE_UNAVAILABLE");
  }
}

export async function readDashboardBundle(
  input: DashboardQueryInput,
): Promise<GetDashboardBundleV3Result> {
  const url = convexUrl();
  if (url === null) return publicReadError("RELEASE_UNAVAILABLE");
  try {
    return parseGetDashboardBundleV3Result(
      await fetchQuery(api.publicRepacksV3.getDashboardBundleV3, {
        ...input,
        currentTime: Date.now(),
      }, { url }),
    );
  } catch {
    return publicReadError("RELEASE_UNAVAILABLE");
  }
}

export async function readPublicRepacks(
  input: ListPublicRepacksInput,
): Promise<ListPublicRepacksV3Result> {
  const url = convexUrl();
  if (url === null) return publicReadError("RELEASE_UNAVAILABLE");
  try {
    return parseListPublicRepacksV3Result(
      await fetchQuery(api.publicRepacksV3.listPublicRepacksV3, {
        ...input,
        currentTime: Date.now(),
      }, { url }),
    );
  } catch {
    return publicReadError("RELEASE_UNAVAILABLE");
  }
}

export async function readPublicRepack(
  input: GetPublicRepackInput,
): Promise<GetPublicRepackV3Result> {
  const url = convexUrl();
  if (url === null) return publicReadError("RELEASE_UNAVAILABLE");
  try {
    return parseGetPublicRepackV3Result(
      await fetchQuery(api.publicRepacksV3.getPublicRepackV3, {
        ...input,
        currentTime: Date.now(),
      }, { url }),
    );
  } catch {
    return publicReadError("RELEASE_UNAVAILABLE");
  }
}

export async function searchPublicCollectibles(
  input: SearchPublicCollectiblesInput,
): Promise<SearchPublicCollectiblesV3Result> {
  const url = convexUrl();
  if (url === null) return publicReadError("RELEASE_UNAVAILABLE");
  try {
    return parseSearchPublicCollectiblesV3Result(
      await fetchQuery(api.publicRepacksV3.searchPublicCollectiblesV3, input, {
        url,
      }),
    );
  } catch {
    return publicReadError("RELEASE_UNAVAILABLE");
  }
}

export async function readRepacksByDesiredCollectible(
  input: FindRepacksByDesiredCollectibleInput,
): Promise<FindRepacksByDesiredCollectibleV3Result> {
  const url = convexUrl();
  if (url === null) return publicReadError("RELEASE_UNAVAILABLE");
  try {
    return parseFindRepacksByDesiredCollectibleV3Result(
      await fetchQuery(api.publicRepacksV3.findRepacksByDesiredCollectibleV3, {
        ...input,
        currentTime: Date.now(),
      }, { url }),
    );
  } catch {
    return publicReadError("RELEASE_UNAVAILABLE");
  }
}

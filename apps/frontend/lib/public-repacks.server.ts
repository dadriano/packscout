import { fetchQuery } from "convex/nextjs";
import {
  findRepacksByDesiredCollectibleResultSchema,
  getDashboardBundleResultSchema,
  getPublicRepackResultSchema,
  getPublicShellStatusResultSchema,
  listPublicRepacksResultSchema,
  publicReadError,
  searchPublicCollectiblesResultSchema,
  type DashboardQueryInput,
  type FindRepacksByDesiredCollectibleInput,
  type FindRepacksByDesiredCollectibleResult,
  type GetDashboardBundleResult,
  type GetPublicRepackInput,
  type GetPublicRepackResult,
  type GetPublicShellStatusResult,
  type ListPublicRepacksInput,
  type ListPublicRepacksResult,
  type SearchPublicCollectiblesInput,
  type SearchPublicCollectiblesResult,
} from "@packscout/contracts";
import { api } from "../../../convex/_generated/api";
import { readPublicConvexOrigin } from "./security-policy.server";

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

export async function readPublicShellStatus(): Promise<GetPublicShellStatusResult> {
  const url = convexUrl();
  if (url === null) return publicReadError("RELEASE_UNAVAILABLE");
  try {
    return getPublicShellStatusResultSchema.parse(
      await fetchQuery(api.publicRepacks.getPublicShellStatus, {}, { url }),
    );
  } catch {
    return publicReadError("RELEASE_UNAVAILABLE");
  }
}

export async function readDashboardBundle(
  input: DashboardQueryInput,
): Promise<GetDashboardBundleResult> {
  const url = convexUrl();
  if (url === null) return publicReadError("RELEASE_UNAVAILABLE");
  try {
    return getDashboardBundleResultSchema.parse(
      await fetchQuery(api.publicRepacks.getDashboardBundle, {
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
): Promise<ListPublicRepacksResult> {
  const url = convexUrl();
  if (url === null) return publicReadError("RELEASE_UNAVAILABLE");
  try {
    return listPublicRepacksResultSchema.parse(
      await fetchQuery(api.publicRepacks.listPublicRepacks, {
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
): Promise<GetPublicRepackResult> {
  const url = convexUrl();
  if (url === null) return publicReadError("RELEASE_UNAVAILABLE");
  try {
    return getPublicRepackResultSchema.parse(
      await fetchQuery(api.publicRepacks.getPublicRepack, {
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
): Promise<SearchPublicCollectiblesResult> {
  const url = convexUrl();
  if (url === null) return publicReadError("RELEASE_UNAVAILABLE");
  try {
    return searchPublicCollectiblesResultSchema.parse(
      await fetchQuery(api.publicRepacks.searchPublicCollectibles, input, { url }),
    );
  } catch {
    return publicReadError("RELEASE_UNAVAILABLE");
  }
}

export async function readRepacksByDesiredCollectible(
  input: FindRepacksByDesiredCollectibleInput,
): Promise<FindRepacksByDesiredCollectibleResult> {
  const url = convexUrl();
  if (url === null) return publicReadError("RELEASE_UNAVAILABLE");
  try {
    return findRepacksByDesiredCollectibleResultSchema.parse(
      await fetchQuery(api.publicRepacks.findRepacksByDesiredCollectible, {
        ...input,
        currentTime: Date.now(),
      }, { url }),
    );
  } catch {
    return publicReadError("RELEASE_UNAVAILABLE");
  }
}

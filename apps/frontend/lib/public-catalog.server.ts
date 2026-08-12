import { fetchQuery } from "convex/nextjs";
import {
  getDashboardBundleResultSchema,
  getPublicPackResultSchema,
  getPublicShellStatusResultSchema,
  listPublicPacksResultSchema,
  publicReadError,
  type DashboardQueryInput,
  type GetDashboardBundleResult,
  type GetPublicPackInput,
  type GetPublicPackResult,
  type GetPublicShellStatusResult,
  type ListPublicPacksInput,
  type ListPublicPacksResult,
} from "@packscout/contracts";
import { api } from "../../../convex/_generated/api";
import { readPublicConvexOrigin } from "./security-policy.server";

type PublicCatalogEnvironment = Readonly<{
  NODE_ENV?: string;
  NEXT_PUBLIC_CONVEX_URL?: string;
}>;

function convexUrl(environment: PublicCatalogEnvironment = process.env): string | null {
  try {
    return readPublicConvexOrigin(environment);
  } catch {
    return null;
  }
}

export function publicCatalogReadsConfigured(
  environment: PublicCatalogEnvironment = process.env,
): boolean {
  return convexUrl(environment) !== null;
}

export async function readPublicShellStatus(): Promise<GetPublicShellStatusResult> {
  const url = convexUrl();
  if (url === null) return publicReadError("SNAPSHOT_UNAVAILABLE");
  try {
    return getPublicShellStatusResultSchema.parse(
      await fetchQuery(api.publicCatalog.getPublicShellStatus, {}, { url }),
    );
  } catch {
    return publicReadError("SNAPSHOT_UNAVAILABLE");
  }
}

export async function readDashboardBundle(
  input: DashboardQueryInput,
): Promise<GetDashboardBundleResult> {
  const url = convexUrl();
  if (url === null) return publicReadError("SNAPSHOT_UNAVAILABLE");
  try {
    return getDashboardBundleResultSchema.parse(
      await fetchQuery(api.publicCatalog.getDashboardBundle, input, { url }),
    );
  } catch {
    return publicReadError("SNAPSHOT_UNAVAILABLE");
  }
}

export async function readPublicPacks(
  input: ListPublicPacksInput,
): Promise<ListPublicPacksResult> {
  const url = convexUrl();
  if (url === null) return publicReadError("SNAPSHOT_UNAVAILABLE");
  try {
    return listPublicPacksResultSchema.parse(
      await fetchQuery(api.publicCatalog.listPublicPacks, input, { url }),
    );
  } catch {
    return publicReadError("SNAPSHOT_UNAVAILABLE");
  }
}

export async function readPublicPack(
  input: GetPublicPackInput,
): Promise<GetPublicPackResult> {
  const url = convexUrl();
  if (url === null) return publicReadError("SNAPSHOT_UNAVAILABLE");
  try {
    return getPublicPackResultSchema.parse(
      await fetchQuery(api.publicCatalog.getPublicPack, input, { url }),
    );
  } catch {
    return publicReadError("SNAPSHOT_UNAVAILABLE");
  }
}

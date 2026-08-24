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
  PACKSCOUT_CATALOG_READ_TOKEN?: string;
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

/**
 * Bounds for the server-held catalog-read credential, mirroring the product
 * backend's acceptance window. A value outside them is treated as
 * unconfigured — the read goes out without a credential and, while the beta
 * is on, degrades to the existing bounded unavailable state rather than
 * crashing or logging anything about the misconfiguration.
 */
export const CATALOG_READ_TOKEN_MINIMUM_LENGTH = 32;
export const CATALOG_READ_TOKEN_MAXIMUM_LENGTH = 512;

/**
 * The server-held credential that authorizes PackScout's own rendering path
 * against the closed catalog read model (closed-beta-access/005), or null
 * when this deployment holds none. Server-side configuration only: the
 * variable is deliberately not `NEXT_PUBLIC_`, this module is server-only,
 * and the value is never logged, never rendered, and never part of an error.
 */
export function readCatalogReadCredential(
  environment: PublicRepacksEnvironment = process.env,
): string | null {
  const configured = environment.PACKSCOUT_CATALOG_READ_TOKEN?.trim() ?? "";
  return configured.length >= CATALOG_READ_TOKEN_MINIMUM_LENGTH &&
      configured.length <= CATALOG_READ_TOKEN_MAXIMUM_LENGTH
    ? configured
    : null;
}

/**
 * Attaches the catalog-read credential to one read's arguments. Every
 * catalog `fetchQuery` below routes its arguments through here, so the
 * rendering path presents the credential on each existing round trip — no
 * additional requests — and callers' argument shapes are untouched whenever
 * no credential is configured (the beta-off contract).
 */
export function catalogReadArguments<T extends Record<string, unknown>>(
  input: T,
  environment: PublicRepacksEnvironment = process.env,
): T & { catalogReadToken?: string } {
  const credential = readCatalogReadCredential(environment);
  return credential === null
    ? input
    : { ...input, catalogReadToken: credential };
}

export async function readPublicShellStatus(): Promise<GetPublicShellStatusResult> {
  const url = convexUrl();
  if (url === null) return publicReadError("RELEASE_UNAVAILABLE");
  try {
    return getPublicShellStatusResultSchema.parse(
      await fetchQuery(
        api.publicRepacks.getPublicShellStatus,
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
): Promise<GetDashboardBundleResult> {
  const url = convexUrl();
  if (url === null) return publicReadError("RELEASE_UNAVAILABLE");
  try {
    return getDashboardBundleResultSchema.parse(
      await fetchQuery(api.publicRepacks.getDashboardBundle, catalogReadArguments({
        ...input,
        currentTime: Date.now(),
      }), { url }),
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
      await fetchQuery(api.publicRepacks.listPublicRepacks, catalogReadArguments({
        ...input,
        currentTime: Date.now(),
      }), { url }),
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
      await fetchQuery(api.publicRepacks.getPublicRepack, catalogReadArguments({
        ...input,
        currentTime: Date.now(),
      }), { url }),
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
      await fetchQuery(
        api.publicRepacks.searchPublicCollectibles,
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
): Promise<FindRepacksByDesiredCollectibleResult> {
  const url = convexUrl();
  if (url === null) return publicReadError("RELEASE_UNAVAILABLE");
  try {
    return findRepacksByDesiredCollectibleResultSchema.parse(
      await fetchQuery(api.publicRepacks.findRepacksByDesiredCollectible, catalogReadArguments({
        ...input,
        currentTime: Date.now(),
      }), { url }),
    );
  } catch {
    return publicReadError("RELEASE_UNAVAILABLE");
  }
}

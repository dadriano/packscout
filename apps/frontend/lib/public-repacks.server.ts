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
 * confidence aging, presents the server-held catalog-read credential on
 * that same round trip, and re-validates every result against the strict v3
 * contracts before rendering.
 */

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

export async function readPublicShellStatus(): Promise<GetPublicShellStatusV3Result> {
  const url = convexUrl();
  if (url === null) return publicReadError("RELEASE_UNAVAILABLE");
  try {
    return parseGetPublicShellStatusV3Result(
      await fetchQuery(
        api.publicRepacksV3.getPublicShellStatusV3,
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
  const url = convexUrl();
  if (url === null) return publicReadError("RELEASE_UNAVAILABLE");
  try {
    return parseGetDashboardBundleV3Result(
      await fetchQuery(api.publicRepacksV3.getDashboardBundleV3, catalogReadArguments({
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
): Promise<ListPublicRepacksV3Result> {
  const url = convexUrl();
  if (url === null) return publicReadError("RELEASE_UNAVAILABLE");
  try {
    return parseListPublicRepacksV3Result(
      await fetchQuery(api.publicRepacksV3.listPublicRepacksV3, catalogReadArguments({
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
): Promise<GetPublicRepackV3Result> {
  const url = convexUrl();
  if (url === null) return publicReadError("RELEASE_UNAVAILABLE");
  try {
    return parseGetPublicRepackV3Result(
      await fetchQuery(api.publicRepacksV3.getPublicRepackV3, catalogReadArguments({
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
): Promise<SearchPublicCollectiblesV3Result> {
  const url = convexUrl();
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
  const url = convexUrl();
  if (url === null) return publicReadError("RELEASE_UNAVAILABLE");
  try {
    return parseFindRepacksByDesiredCollectibleV3Result(
      await fetchQuery(api.publicRepacksV3.findRepacksByDesiredCollectibleV3, catalogReadArguments({
        ...input,
        currentTime: Date.now(),
      }), { url }),
    );
  } catch {
    return publicReadError("RELEASE_UNAVAILABLE");
  }
}

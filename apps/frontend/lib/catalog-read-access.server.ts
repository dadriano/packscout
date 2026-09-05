import { readPublicConvexOrigin } from "./security-policy.server";

export type CatalogReadEnvironment = Readonly<{
  NODE_ENV?: string;
  NEXT_PUBLIC_CONVEX_URL?: string;
  PACKSCOUT_CATALOG_READ_TOKEN?: string;
}>;

export const CATALOG_READ_TOKEN_MINIMUM_LENGTH = 32;
export const CATALOG_READ_TOKEN_MAXIMUM_LENGTH = 512;

/** A shared server-only access boundary; neither configuration nor credentials enter DTOs. */
export function catalogReadOrigin(environment: CatalogReadEnvironment = process.env): string | null {
  try {
    return readPublicConvexOrigin(environment);
  } catch {
    return null;
  }
}

export function readCatalogReadCredential(environment: CatalogReadEnvironment = process.env): string | null {
  const configured = environment.PACKSCOUT_CATALOG_READ_TOKEN?.trim() ?? "";
  return configured.length >= CATALOG_READ_TOKEN_MINIMUM_LENGTH &&
    configured.length <= CATALOG_READ_TOKEN_MAXIMUM_LENGTH ? configured : null;
}

export function catalogReadArguments<T extends Record<string, unknown>>(
  input: T,
  environment: CatalogReadEnvironment = process.env,
): T & { catalogReadToken?: string } {
  const credential = readCatalogReadCredential(environment);
  return credential === null ? input : { ...input, catalogReadToken: credential };
}

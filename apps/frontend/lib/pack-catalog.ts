import { packCatalogReadErrorSchema, packCatalogV1QueryContracts } from "@packscout/contracts";

type Contracts = typeof packCatalogV1QueryContracts;
export type PackCatalogOperation = keyof Contracts;
export type PackCatalogInput<K extends PackCatalogOperation> = ReturnType<Contracts[K]["input"]["parse"]>;
export type PackCatalogResult<K extends PackCatalogOperation> = ReturnType<Contracts[K]["output"]["parse"]>;
export type PackCatalogData<K extends PackCatalogOperation> = Extract<PackCatalogResult<K>, { ok: true }>["data"];
export type PackCatalogError = ReturnType<typeof packCatalogReadErrorSchema.parse>;
export type PackCatalogPagedOperation = Exclude<PackCatalogOperation, "getPublicShellStatus" | "getDashboardBundle">;

const errorCopy: Record<PackCatalogError["code"], string> = {
  INVALID_QUERY: "This catalog link cannot be applied. Reset the query to continue.",
  CURSOR_EXPIRED: "This page has expired. Return to the first page to continue.",
  CATALOG_UNAVAILABLE: "The catalog is unavailable right now. Try again later.",
  PACK_NOT_FOUND: "This pack is no longer in the catalog.",
  COLLECTIBLE_NOT_FOUND: "This collectible is no longer in the catalog.",
  AUTH_REQUIRED: "Sign in to view this catalog.",
  UNAUTHORIZED: "Your account does not have access to this catalog.",
};

/** Render only the declared code's copy, never server-provided prose or exception messages. */
export function packCatalogError(code: PackCatalogError["code"]): PackCatalogError {
  return { ok: false, code, error: errorCopy[code], retryable: code === "CATALOG_UNAVAILABLE" };
}

export function parsePackCatalogResult<K extends PackCatalogOperation>(
  operation: K,
  value: unknown,
): PackCatalogResult<K> {
  const parsed = packCatalogV1QueryContracts[operation].output.safeParse(value);
  if (!parsed.success) return packCatalogError("CATALOG_UNAVAILABLE") as PackCatalogResult<K>;
  // The operation selects the same input/output pair from the executable V1 contract.
  return (parsed.data.ok ? parsed.data : packCatalogError(parsed.data.code)) as PackCatalogResult<K>;
}

export function packCatalogErrorHttpStatus(code: PackCatalogError["code"]): number {
  switch (code) {
    case "AUTH_REQUIRED": return 401;
    case "UNAUTHORIZED": return 403;
    case "PACK_NOT_FOUND":
    case "COLLECTIBLE_NOT_FOUND": return 404;
    case "CATALOG_UNAVAILABLE": return 503;
    case "CURSOR_EXPIRED": return 409;
    case "INVALID_QUERY": return 400;
  }
}

import { fetchAction } from "convex/nextjs";
import type { FunctionReference } from "convex/server";
import { packCatalogV1QueryContracts } from "@packscout/contracts";
import { api } from "../../../convex/_generated/api";
import { catalogReadArguments, catalogReadOrigin, type CatalogReadEnvironment } from "./catalog-read-access.server";
import {
  packCatalogError,
  parsePackCatalogResult,
  type PackCatalogInput,
  type PackCatalogOperation,
  type PackCatalogPagedOperation,
  type PackCatalogResult,
} from "./pack-catalog";

export type PackCatalogTransport = (
  reference: FunctionReference<"action", "public">,
  args: { request: unknown; catalogReadToken?: string },
  options: { url: string },
) => Promise<unknown>;

const references = {
  getPublicShellStatus: api.packCatalogV1.getPublicShellStatus,
  getDashboardBundle: api.packCatalogV1.getDashboardBundle,
  listPublicPacks: api.packCatalogV1.listPublicPacks,
  getPublicPack: api.packCatalogV1.getPublicPack,
  searchPublicCollectibles: api.packCatalogV1.searchPublicCollectibles,
  findPacksByDesiredCollectible: api.packCatalogV1.findPacksByDesiredCollectible,
} satisfies Record<PackCatalogOperation, FunctionReference<"action", "public">>;

function cursorKey(operation: PackCatalogOperation): "cursor" | "contentsCursor" | null {
  if (operation === "getPublicPack") return "contentsCursor";
  return operation === "getPublicShellStatus" || operation === "getDashboardBundle" ? null : "cursor";
}

function withoutCursor(operation: PackCatalogOperation, input: unknown): Record<string, unknown> | null {
  const key = cursorKey(operation);
  if (key === null || typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const cursor = record[key];
  // Only bounded opaque text is recoverable pagination state; an arbitrary value is invalid input.
  return typeof cursor === "string" && cursor.length > 0 && cursor.length <= 8_192
    ? { ...record, [key]: null } : null;
}

/** Injectable at the transport boundary for local fixtures; production always calls the six native actions. */
export function createPackCatalogReader(options: Readonly<{
  environment?: CatalogReadEnvironment;
  transport?: PackCatalogTransport;
}> = {}) {
  const environment = options.environment ?? process.env;
  const transport: PackCatalogTransport = options.transport ?? ((reference, args, settings) => fetchAction(reference, args, settings));

  async function read<K extends PackCatalogOperation>(operation: K, input: unknown): Promise<PackCatalogResult<K>> {
    const contract = packCatalogV1QueryContracts[operation];
    const parsed = contract.input.safeParse(input);
    if (!parsed.success) {
      const firstPage = withoutCursor(operation, input);
      const code = firstPage !== null && contract.input.safeParse(firstPage).success ? "CURSOR_EXPIRED" : "INVALID_QUERY";
      return packCatalogError(code) as PackCatalogResult<K>;
    }
    const url = catalogReadOrigin(environment);
    if (url === null) return packCatalogError("CATALOG_UNAVAILABLE") as PackCatalogResult<K>;
    try {
      const result = await transport(references[operation], catalogReadArguments({ request: parsed.data }, environment), { url });
      const response = parsePackCatalogResult(operation, result);
      // A coherent entity response must also belong to this parsed request, including after a cursor reset.
      if (response.ok && (
        (operation === "getPublicPack" && "publicRepackId" in parsed.data && "snapshot" in response.data &&
          response.data.snapshot.publicRepackId !== parsed.data.publicRepackId) ||
        (operation === "findPacksByDesiredCollectible" && "publicCollectibleId" in parsed.data && "publicCollectibleId" in response.data &&
          response.data.publicCollectibleId !== parsed.data.publicCollectibleId)
      )) return packCatalogError("CATALOG_UNAVAILABLE") as PackCatalogResult<K>;
      return response;
    } catch {
      return packCatalogError("CATALOG_UNAVAILABLE") as PackCatalogResult<K>;
    }
  }

  async function readPage<K extends PackCatalogPagedOperation>(operation: K, input: PackCatalogInput<K>) {
    const result = await read(operation, input);
    const firstPage = withoutCursor(operation, input);
    if (result.ok || result.code !== "CURSOR_EXPIRED" || firstPage === null) {
      return { result, paginationReset: false };
    }
    // Exactly one retry. A second expiry is returned directly, even if the server misbehaves.
    return { result: await read(operation, firstPage), paginationReset: true };
  }

  return { read, readPage };
}

export const packCatalogReader = createPackCatalogReader();

import type { CentralQueryClient } from "./central-database.ts";
import {
  GlobalCatalogConflictError,
  requireCatalogUuid,
  type GlobalCollectibleType,
} from "./global-catalog-contract.ts";

export interface StoredGlobalCollectibleIdentity {
  readonly id: string;
  readonly collectibleType: GlobalCollectibleType;
  readonly identityState: "provisional" | "canonical" | "retired";
  readonly rowVersion: bigint;
  readonly updatedAt: Date;
}

export interface DatabaseAliasResolution {
  readonly canonical: StoredGlobalCollectibleIdentity | null;
  readonly path: readonly string[];
}

export async function resolveStoredCollectible(
  client: CentralQueryClient,
  inputId: string,
): Promise<DatabaseAliasResolution> {
  let current = requireCatalogUuid(inputId, "collectibleId");
  const path: string[] = [];
  const visited = new Set<string>();
  while (true) {
    if (visited.has(current) || path.length >= 64) {
      throw new GlobalCatalogConflictError(
        "ALIAS_CYCLE",
        "Collectible alias resolution encountered an invalid chain.",
      );
    }
    visited.add(current);
    path.push(current);
    const alias = await client.collectible_aliases.findUnique({
      where: { alias_collectible_id: current },
      select: { canonical_collectible_id: true },
    });
    if (alias) {
      current = alias.canonical_collectible_id;
      continue;
    }
    const collectible = await client.global_collectibles.findUnique({
      where: { id: current },
      select: {
        id: true,
        collectible_type: true,
        identity_state: true,
        row_version: true,
        updated_at: true,
      },
    });
    return {
      canonical: collectible === null ? null : {
        id: collectible.id,
        collectibleType: collectible.collectible_type,
        identityState: collectible.identity_state,
        rowVersion: collectible.row_version,
        updatedAt: collectible.updated_at,
      },
      path,
    };
  }
}

export async function findAliasAncestors(
  client: CentralQueryClient,
  collectibleIds: readonly string[],
): Promise<readonly string[]> {
  const all = new Set(collectibleIds.map((id) => requireCatalogUuid(id, "collectibleId")));
  let frontier = [...all];
  for (let depth = 0; frontier.length > 0 && depth < 64; depth += 1) {
    const parents = await client.collectible_aliases.findMany({
      where: { canonical_collectible_id: { in: frontier } },
      select: { alias_collectible_id: true },
      orderBy: { alias_collectible_id: "asc" },
    });
    frontier = [];
    for (const parent of parents) {
      if (!all.has(parent.alias_collectible_id)) {
        all.add(parent.alias_collectible_id);
        frontier.push(parent.alias_collectible_id);
      }
    }
  }
  if (frontier.length > 0) {
    throw new GlobalCatalogConflictError(
      "ALIAS_CYCLE",
      "Collectible alias ancestry exceeded its maximum depth.",
    );
  }
  return [...all].sort();
}

export async function affectedProvidersForCollectibles(
  client: CentralQueryClient,
  collectibleIds: readonly string[],
): Promise<readonly string[]> {
  const identities = await findAliasAncestors(client, collectibleIds);
  const correlations = await client.provider_collectible_correlations.findMany({
    where: {
      global_collectible_id: { in: [...identities] },
      valid_to_event_sequence: null,
    },
    select: { provider_id: true },
    distinct: ["provider_id"],
    orderBy: { provider_id: "asc" },
  });
  return correlations.map((correlation) => correlation.provider_id);
}

import { Prisma as ProviderPrisma } from "../prisma/generated/provider/index.js";
import type { ProviderQueryClient } from "./provider-database.ts";

export interface ProviderResolvedFactRow {
  readonly id: string;
  readonly row_version: bigint;
}

export interface ProviderResolvedFactReferences {
  readonly pulls: readonly ProviderResolvedFactRow[];
  readonly pullItems: readonly ProviderResolvedFactRow[];
  readonly marketEventPacks: readonly ProviderResolvedFactRow[];
  readonly marketEventCollectibles: readonly ProviderResolvedFactRow[];
}

const FACT_REFERENCE_RECONCILIATION_LIMIT = 500;

/**
 * Called only inside the import-fenced canonical transaction. Catalog keys
 * drive parameterized probes of the partial (key, id) unresolved-fact indexes.
 * A fact-first ORDER BY id can instead scan the entire history looking for a
 * catalog key that has not arrived. The lateral LIMIT prevents that plan from
 * being flattened, and the outer LIMIT caps each relationship batch at 500.
 */
export async function resolveProviderFactReferencesBatch(
  client: Pick<ProviderQueryClient, "$queryRaw">,
): Promise<ProviderResolvedFactReferences> {
  const [targets] = await client.$queryRaw<{
    packs: boolean;
    collectibles: boolean;
  }[]>(ProviderPrisma.sql`
    SELECT EXISTS (SELECT 1 FROM packs) AS packs,
           EXISTS (SELECT 1 FROM collectibles) AS collectibles
  `);
  if (targets === undefined) {
    throw new Error("Provider reconciliation target inspection failed.");
  }

  // Recheck on every invocation, never cache an empty catalog: later pages can
  // introduce the targets needed to resolve previously accepted facts.
  const pulls = targets.packs
    ? await client.$queryRaw<ProviderResolvedFactRow[]>(ProviderPrisma.sql`
      WITH candidates AS MATERIALIZED (
        SELECT pending.id, target.id AS target_id
        FROM packs AS target
        CROSS JOIN LATERAL (
          SELECT unresolved.id
          FROM pulls AS unresolved
          WHERE unresolved.pack_id IS NULL
            AND unresolved.pack_key IS NOT NULL
            AND unresolved.pack_key = target.pack_key
          ORDER BY unresolved.id
          LIMIT ${FACT_REFERENCE_RECONCILIATION_LIMIT}
          FOR UPDATE OF unresolved SKIP LOCKED
        ) AS pending
        LIMIT ${FACT_REFERENCE_RECONCILIATION_LIMIT}
      )
      UPDATE pulls AS fact
      SET pack_id = candidates.target_id,
          row_version = fact.row_version + 1,
          updated_at = CURRENT_TIMESTAMP
      FROM candidates
      WHERE fact.id = candidates.id
      RETURNING fact.id, fact.row_version
    `)
    : [];
  const pullItems = targets.collectibles
    ? await client.$queryRaw<ProviderResolvedFactRow[]>(ProviderPrisma.sql`
      WITH candidates AS MATERIALIZED (
        SELECT pending.id, target.id AS target_id
        FROM collectibles AS target
        CROSS JOIN LATERAL (
          SELECT unresolved.id
          FROM pull_items AS unresolved
          WHERE unresolved.collectible_id IS NULL
            AND unresolved.collectible_key IS NOT NULL
            AND unresolved.collectible_key = target.collectible_key
          ORDER BY unresolved.id
          LIMIT ${FACT_REFERENCE_RECONCILIATION_LIMIT}
          FOR UPDATE OF unresolved SKIP LOCKED
        ) AS pending
        LIMIT ${FACT_REFERENCE_RECONCILIATION_LIMIT}
      )
      UPDATE pull_items AS fact
      SET collectible_id = candidates.target_id,
          row_version = fact.row_version + 1,
          updated_at = CURRENT_TIMESTAMP
      FROM candidates
      WHERE fact.id = candidates.id
      RETURNING fact.id, fact.row_version
    `)
    : [];
  const marketEventPacks = targets.packs
    ? await client.$queryRaw<ProviderResolvedFactRow[]>(ProviderPrisma.sql`
      WITH candidates AS MATERIALIZED (
        SELECT pending.id, target.id AS target_id
        FROM packs AS target
        CROSS JOIN LATERAL (
          SELECT unresolved.id
          FROM market_events AS unresolved
          WHERE unresolved.pack_id IS NULL
            AND unresolved.pack_key IS NOT NULL
            AND unresolved.pack_key = target.pack_key
          ORDER BY unresolved.id
          LIMIT ${FACT_REFERENCE_RECONCILIATION_LIMIT}
          FOR UPDATE OF unresolved SKIP LOCKED
        ) AS pending
        LIMIT ${FACT_REFERENCE_RECONCILIATION_LIMIT}
      )
      UPDATE market_events AS fact
      SET pack_id = candidates.target_id,
          row_version = fact.row_version + 1,
          updated_at = CURRENT_TIMESTAMP
      FROM candidates
      WHERE fact.id = candidates.id
      RETURNING fact.id, fact.row_version
    `)
    : [];
  const marketEventCollectibles = targets.collectibles
    ? await client.$queryRaw<ProviderResolvedFactRow[]>(ProviderPrisma.sql`
      WITH candidates AS MATERIALIZED (
        SELECT pending.id, target.id AS target_id
        FROM collectibles AS target
        CROSS JOIN LATERAL (
          SELECT unresolved.id
          FROM market_events AS unresolved
          WHERE unresolved.collectible_id IS NULL
            AND unresolved.collectible_key IS NOT NULL
            AND unresolved.collectible_key = target.collectible_key
          ORDER BY unresolved.id
          LIMIT ${FACT_REFERENCE_RECONCILIATION_LIMIT}
          FOR UPDATE OF unresolved SKIP LOCKED
        ) AS pending
        LIMIT ${FACT_REFERENCE_RECONCILIATION_LIMIT}
      )
      UPDATE market_events AS fact
      SET collectible_id = candidates.target_id,
          row_version = fact.row_version + 1,
          updated_at = CURRENT_TIMESTAMP
      FROM candidates
      WHERE fact.id = candidates.id
      RETURNING fact.id, fact.row_version
    `)
    : [];
  return { pulls, pullItems, marketEventPacks, marketEventCollectibles };
}

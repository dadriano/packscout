import { Prisma as ProviderPrisma } from "../prisma/generated/provider/index.js";
import { PROVIDER_MIXED_PAGE_MAX_RECORDS } from "./provider-mixed-page-contract.ts";
import type { ProviderQueryClient } from "./provider-database.ts";
import { ProviderCanonicalInputError, type ProviderFactReferenceScan,
  type ProviderFactReferenceScanCursor } from "./provider-canonical-contract.ts";

export interface ProviderResolvedFactRow {
  readonly id: string;
  readonly row_version: bigint;
}

export interface ProviderResolvedFactReferences {
  readonly pulls: readonly ProviderResolvedFactRow[];
  readonly pullItems: readonly ProviderResolvedFactRow[];
  readonly marketEventPacks: readonly ProviderResolvedFactRow[];
  readonly marketEventCollectibles: readonly ProviderResolvedFactRow[];
  readonly nextScanCursor: ProviderFactReferenceScanCursor | null;
}

export const PROVIDER_FACT_REFERENCE_TARGET_BATCH = 250;
// Rows resolved per relationship per batch. Each batch is its own bounded
// transaction, so this bounds one UPDATE, not the scan: a probe for 500 rows
// measured 67 ms on the largest provider database while the fixed per-batch
// round trips cost about 4 s, so a 7.2M-row backlog took ~14,400 batches (about
// 16 hours of head reconciliation) at 500 and takes ~1,440 at this value.
export const FACT_REFERENCE_RECONCILIATION_LIMIT = 5_000;
type QueryClient = Pick<ProviderQueryClient, "$queryRaw">;
type Target = Readonly<{ id: string; key: string }>;
type Position = ProviderFactReferenceScanCursor["packs"];
const initial: Position = Object.freeze({ afterKey: null, done: false });

function boundedKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 2_048;
}

function validateScan(scan: ProviderFactReferenceScan): void {
  for (const position of [scan.after?.packs, scan.after?.collectibles]) {
    if (position !== undefined && (typeof position.done !== "boolean"
      || (position.afterKey !== null && !boundedKey(position.afterKey)))) {
      throw new ProviderCanonicalInputError("The fact reference scan cursor is invalid.");
    }
  }
  for (const keys of [scan.targets?.packKeys, scan.targets?.collectibleKeys]) {
    if (keys !== undefined && (!Array.isArray(keys) || keys.length > PROVIDER_MIXED_PAGE_MAX_RECORDS
      || keys.some((key) => !boundedKey(key)))) {
      throw new ProviderCanonicalInputError("The fact reference target scope is invalid.");
    }
  }
}

async function targetPage(client: QueryClient, table: "packs" | "collectibles",
  position: Position, keys: readonly string[] | undefined): Promise<readonly Target[]> {
  if (position.done || keys?.length === 0) return [];
  const key = ProviderPrisma.raw(table === "packs" ? "pack_key" : "collectible_key");
  return client.$queryRaw<Target[]>(ProviderPrisma.sql`
    SELECT id, ${key} AS key FROM ${ProviderPrisma.raw(table)}
    WHERE ${position.afterKey === null ? ProviderPrisma.sql`TRUE`
      : ProviderPrisma.sql`${key} > ${position.afterKey}`}
      AND ${keys === undefined ? ProviderPrisma.sql`TRUE`
        : ProviderPrisma.sql`${key} IN (${ProviderPrisma.join(keys)})`}
    ORDER BY ${key} LIMIT ${PROVIDER_FACT_REFERENCE_TARGET_BATCH + 1}
  `);
}

/** A bounded target page drives indexed unresolved-fact probes, including no-match scans. */
async function resolve(client: QueryClient, table: "pulls" | "pull_items" | "market_events",
  relationship: "pack" | "collectible", targets: readonly Target[]): Promise<readonly ProviderResolvedFactRow[]> {
  if (targets.length === 0) return [];
  const fact = ProviderPrisma.raw(table);
  const foreignKey = ProviderPrisma.raw(`${relationship}_id`);
  const sourceKey = ProviderPrisma.raw(`${relationship}_key`);
  const values = targets.slice(0, PROVIDER_FACT_REFERENCE_TARGET_BATCH)
    .map((target) => ProviderPrisma.sql`(${target.id}::uuid, ${target.key}::text)`);
  return client.$queryRaw<ProviderResolvedFactRow[]>(ProviderPrisma.sql`
    WITH targets(id, key) AS (VALUES ${ProviderPrisma.join(values)}),
    candidates AS MATERIALIZED (
      SELECT pending.id, target.id AS target_id
      FROM targets AS target
      CROSS JOIN LATERAL (
        SELECT unresolved.id FROM ${fact} AS unresolved
        WHERE unresolved.${foreignKey} IS NULL
          AND unresolved.${sourceKey} IS NOT NULL
          AND unresolved.${sourceKey} = target.key
        ORDER BY unresolved.id LIMIT ${FACT_REFERENCE_RECONCILIATION_LIMIT}
        FOR UPDATE OF unresolved SKIP LOCKED
      ) AS pending
      LIMIT ${FACT_REFERENCE_RECONCILIATION_LIMIT}
    )
    UPDATE ${fact} AS fact SET ${foreignKey} = candidates.target_id,
      row_version = fact.row_version + 1, updated_at = CURRENT_TIMESTAMP
    FROM candidates WHERE fact.id = candidates.id
    RETURNING fact.id, fact.row_version
  `);
}

function advance(position: Position, targets: readonly Target[], counts: readonly number[]): Position {
  // Full fact batches must drain this same target page before its keyset advances.
  if (counts.some((count) => count === FACT_REFERENCE_RECONCILIATION_LIMIT)) return position;
  return targets.length > PROVIDER_FACT_REFERENCE_TARGET_BATCH
    ? { afterKey: targets[PROVIDER_FACT_REFERENCE_TARGET_BATCH - 1]!.key, done: false }
    : { afterKey: position.afterKey, done: true };
}

/** Called only inside the import-fenced canonical transaction; no source cursor is changed. */
export async function resolveProviderFactReferencesBatch(
  client: QueryClient, scan: ProviderFactReferenceScan = {},
): Promise<ProviderResolvedFactReferences> {
  validateScan(scan);
  const packPosition = scan.after?.packs ?? initial;
  const collectiblePosition = scan.after?.collectibles ?? initial;
  const packTargets = await targetPage(client, "packs", packPosition, scan.targets?.packKeys);
  const collectibleTargets = await targetPage(client, "collectibles", collectiblePosition,
    scan.targets?.collectibleKeys);
  const pulls = await resolve(client, "pulls", "pack", packTargets);
  const pullItems = await resolve(client, "pull_items", "collectible", collectibleTargets);
  const marketEventPacks = await resolve(client, "market_events", "pack", packTargets);
  const marketEventCollectibles = await resolve(client, "market_events", "collectible", collectibleTargets);
  const packs = advance(packPosition, packTargets, [pulls.length, marketEventPacks.length]);
  const collectibles = advance(collectiblePosition, collectibleTargets,
    [pullItems.length, marketEventCollectibles.length]);
  return { pulls, pullItems, marketEventPacks, marketEventCollectibles,
    nextScanCursor: packs.done && collectibles.done ? null : { packs, collectibles } };
}

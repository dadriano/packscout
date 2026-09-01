import { MAX_PROVIDER_PACK_CONTENT_SNAPSHOT_ITEMS } from "@packscout/contracts";
import { Prisma } from "../prisma/generated/provider/index.js";
import type { ProviderTransactionClient } from "./provider-database.ts";
import { ProviderCanonicalInputError, ProviderCanonicalWriteConflictError, type PackContentWriteInput } from "./provider-canonical-contract.ts";
import type { normalizeProviderPackContentWrite } from "./provider-canonical-pack-content-write.ts";
import { appendPromotionRange, createProviderCanonicalTransaction } from "./provider-canonical-repository.ts";
import { providerBatchRecordConstraint } from "./provider-canonical-batch-constraint.ts";

export const PROVIDER_SNAPSHOT_MEMBERSHIP_CHUNK_SIZE = 100;
export interface SnapshotMembershipVersion { readonly id: string; readonly row_version: bigint }
export interface SnapshotMembershipUpsert {
  readonly id: string;
  readonly expectedVersion: bigint | null;
  readonly data: ReturnType<typeof normalizeProviderPackContentWrite>;
}
interface SnapshotMembershipPlan {
  readonly retirements: readonly SnapshotMembershipVersion[];
  readonly upserts: readonly SnapshotMembershipUpsert[];
  readonly retiredAt: Date;
}

function assertUpdated(expected: readonly SnapshotMembershipVersion[], actual: readonly SnapshotMembershipVersion[]) {
  const versions = new Map(expected.map(row => [row.id, row.row_version + 1n]));
  if (actual.length !== expected.length || versions.size !== expected.length
    || new Set(actual.map(row => row.id)).size !== actual.length
    || actual.some(row => versions.get(row.id) !== row.row_version)) throw new ProviderCanonicalWriteConflictError();
}

/** The snapshot already holds the pack lock and has resolved every member.
 * Each existing row still requires its exact observed version and lifecycle. */
async function persistSnapshotMembershipBatch(transaction: ProviderTransactionClient, input: SnapshotMembershipPlan): Promise<void> {
  if (input.retirements.length > MAX_PROVIDER_PACK_CONTENT_SNAPSHOT_ITEMS
    || input.upserts.length > MAX_PROVIDER_PACK_CONTENT_SNAPSHOT_ITEMS) {
    throw new ProviderCanonicalInputError("The provider pack membership batch exceeds its bound.");
  }
  for (let offset = 0; offset < input.retirements.length; offset += PROVIDER_SNAPSHOT_MEMBERSHIP_CHUNK_SIZE) {
    const rows = input.retirements.slice(offset, offset + PROVIDER_SNAPSHOT_MEMBERSHIP_CHUNK_SIZE);
    const updated = await transaction.$queryRaw<SnapshotMembershipVersion[]>(Prisma.sql`
      WITH wanted(id, expected_version) AS (VALUES ${Prisma.join(rows.map(row =>
        Prisma.sql`(${row.id}::uuid, ${row.row_version}::bigint)`))})
      UPDATE pack_contents AS current
      SET lifecycle = 'retired', retired_at = ${input.retiredAt}, row_version = current.row_version + 1
      FROM wanted WHERE current.id = wanted.id AND current.row_version = wanted.expected_version
        AND current.lifecycle = 'active'
      RETURNING current.id, current.row_version
    `);
    assertUpdated(rows, updated);
  }
  for (let offset = 0; offset < input.upserts.length; offset += PROVIDER_SNAPSHOT_MEMBERSHIP_CHUNK_SIZE) {
    const rows = input.upserts.slice(offset, offset + PROVIDER_SNAPSHOT_MEMBERSHIP_CHUNK_SIZE);
    const inserted = rows.filter(row => row.expectedVersion === null);
    if (inserted.length > 0) {
      const result = await transaction.pack_contents.createMany({ data: inserted.map(row => ({ id: row.id, ...row.data })) });
      if (result.count !== inserted.length) throw new ProviderCanonicalWriteConflictError();
    }
    const existing = rows.filter((row): row is SnapshotMembershipUpsert & { expectedVersion: bigint } => row.expectedVersion !== null);
    if (existing.length === 0) continue;
    const values = JSON.stringify(existing.map(row => ({ id: row.id, expected_version: row.expectedVersion, ...row.data })),
      (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
    const updated = await transaction.$queryRaw<SnapshotMembershipVersion[]>(Prisma.sql`
      UPDATE pack_contents AS current SET
        source_snapshot_id = incoming.source_snapshot_id, pack_id = incoming.pack_id,
        collectible_id = incoming.collectible_id, collectible_instance_id = incoming.collectible_instance_id,
        total_quantity = incoming.total_quantity, available_quantity = incoming.available_quantity,
        content_role = incoming.content_role, probability = incoming.probability,
        stated_value_amount = incoming.stated_value_amount, stated_value_currency = incoming.stated_value_currency,
        evidence_kinds = incoming.evidence_kinds, match_confidence_basis_points = incoming.match_confidence_basis_points,
        match_confidence_band = incoming.match_confidence_band, observed_at = incoming.observed_at,
        display_order = incoming.display_order, row_version = current.row_version + 1
      FROM jsonb_to_recordset(${values}::jsonb) AS incoming(
        id uuid, expected_version bigint, source_snapshot_id uuid, pack_id uuid,
        collectible_id uuid, collectible_instance_id uuid, total_quantity bigint, available_quantity bigint,
        content_role content_role, probability numeric, stated_value_amount numeric, stated_value_currency text,
        evidence_kinds text[], match_confidence_basis_points integer, match_confidence_band text,
        observed_at timestamptz, display_order integer)
      WHERE current.id = incoming.id AND current.row_version = incoming.expected_version
        AND current.lifecycle = 'active'
      RETURNING current.id, current.row_version
    `);
    assertUpdated(existing.map(row => ({ id: row.id, row_version: row.expectedVersion })), updated);
  }
}

/** A raw constraint does not itself authorize quarantine. Restore the snapshot's
 * member writes, then let the original canonical API classify that same record. */
export async function applySnapshotMembershipChanges(transaction: ProviderTransactionClient,
  input: SnapshotMembershipPlan & { readonly requests: readonly PackContentWriteInput[]; readonly snapshotId: string }) {
  await transaction.$executeRawUnsafe("SAVEPOINT packscout_snapshot_membership_batch");
  try {
    await persistSnapshotMembershipBatch(transaction, input);
    await transaction.$executeRawUnsafe("RELEASE SAVEPOINT packscout_snapshot_membership_batch");
  } catch (error) {
    if (!providerBatchRecordConstraint(error)) throw error;
    await transaction.$executeRawUnsafe("ROLLBACK TO SAVEPOINT packscout_snapshot_membership_batch");
    await transaction.$executeRawUnsafe("RELEASE SAVEPOINT packscout_snapshot_membership_batch");
    const canonical = createProviderCanonicalTransaction(transaction);
    let first: bigint | null = null, retiredCount = 0, upsertedCount = 0;
    for (const row of input.retirements) {
      const result = await canonical.retirePackContent({ id: row.id, expectedRowVersion: row.row_version, retiredAt: input.retiredAt });
      if (result.materialChange) { first ??= result.promotionSequence; retiredCount += 1; }
    }
    for (const request of input.requests) {
      const result = await canonical.upsertPackContent(request);
      if (result.materialChange) { first ??= result.promotionSequence; upsertedCount += 1; }
    }
    const range = await appendPromotionRange(transaction, [{ entityType: "pack_content_snapshot",
      entityId: input.snapshotId, entityVersion: 1n, operation: "upsert" }]);
    return { upsertedCount, retiredCount, promotionRange: { first: first ?? range.first, last: range.last } };
  }
  // Retirement evidence keeps its source-effective time. The ledger row lock
  // makes the following two ranges contiguous within this atomic snapshot.
  const retiredRange = input.retirements.length === 0 ? null : await appendPromotionRange(transaction,
    input.retirements.map(row => ({ entityType: "pack_content", entityId: row.id,
      entityVersion: row.row_version + 1n, operation: "retire" })), input.retiredAt);
  const range = await appendPromotionRange(transaction, [...input.upserts.map(row => ({
    entityType: "pack_content" as const, entityId: row.id,
    entityVersion: (row.expectedVersion ?? 0n) + 1n, operation: "upsert" as const,
  })), { entityType: "pack_content_snapshot", entityId: input.snapshotId, entityVersion: 1n, operation: "upsert" }]);
  return { upsertedCount: input.upserts.length, retiredCount: input.retirements.length,
    promotionRange: { first: retiredRange?.first ?? range.first, last: range.last } };
}

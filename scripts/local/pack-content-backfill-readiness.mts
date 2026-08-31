import type { ProviderTransactionClient } from "@packscout/database";
import {
  PACK_CONTENT_BACKFILL_ACTION,
  packContentBackfillChangesDigest,
  packContentBackfillDigest,
  packContentBackfillReceiptSchema,
  type BackfillPromotionChange,
} from "./pack-content-backfill-contract.mts";

const MAX_CHANGES = 10_200;
const MAX_RECEIPTS = 100;

export class PackContentBackfillReadinessError extends Error {
  readonly code = "PACK_CONTENT_BACKFILL_NOT_SETTLED";
  constructor() { super("The catalog backfill is not proven settled."); }
}
function refuse(): never { throw new PackContentBackfillReadinessError(); }

export interface PackContentBackfillReadinessScope {
  readonly organizationId: string;
  readonly providerId: string;
  readonly configVersionId: string;
  readonly configVersionNumber: bigint;
  readonly sourceHeadRunId: string;
  readonly sourceHeadFinishedAt: Date;
  readonly sourceCheckpointHash: string | null;
  readonly sourceGeneration: bigint;
  readonly importLeaseFence: bigint;
  readonly promotionSequence: bigint;
}

export interface PackContentBackfillReadinessProof {
  readonly settledAt: Date;
  readonly digest: string | null;
}

interface AuditRow {
  readonly correlation_id: string;
  readonly target_id: string;
  readonly actor_operator_id: string | null;
  readonly outcome: string;
  readonly occurred_at: Date;
  readonly details: unknown;
}
interface SnapshotRow {
  readonly id: string;
  readonly pack_id: string;
  readonly snapshot_digest: string;
  readonly effective_at: Date;
  readonly collected_at: Date;
  readonly created_at: Date;
  readonly pack: { readonly pack_key: string };
}
interface ContentRow {
  readonly id: string;
  readonly pack_id: string;
  readonly row_version: bigint;
}

/** Only a complete, scoped, contiguous audited delta can extend a source head. */
export function verifyPackContentBackfillReadiness(input: {
  readonly scope: PackContentBackfillReadinessScope;
  readonly changes: readonly BackfillPromotionChange[];
  readonly audits: readonly AuditRow[];
  readonly snapshots: readonly SnapshotRow[];
  readonly contents: readonly ContentRow[];
}): PackContentBackfillReadinessProof {
  const { scope, changes } = input;
  const sourceAt = scope.sourceHeadFinishedAt.getTime();
  if (!Number.isFinite(sourceAt) || changes.length > MAX_CHANGES || input.audits.length > MAX_RECEIPTS) return refuse();
  if (changes.length === 0) return { settledAt: new Date(sourceAt), digest: null };
  if (changes.at(-1)!.sequence !== scope.promotionSequence) return refuse();
  const snapshots = new Map(input.snapshots.map((row) => [row.id, row]));
  const contents = new Map(input.contents.map((row) => [row.id, row]));
  if (snapshots.size !== input.snapshots.length || contents.size !== input.contents.length) return refuse();
  const audits = input.audits.map((audit) => {
    const result = packContentBackfillReceiptSchema.safeParse(audit.details);
    if (!result.success) return refuse();
    return { audit, receipt: result.data };
  }).sort((left, right) => {
    const a = BigInt(left.receipt.firstPromotionSequence), b = BigInt(right.receipt.firstPromotionSequence);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  let next = changes[0]!.sequence;
  let offset = 0;
  let settledAt = sourceAt;
  const confirmed = [];
  for (const { audit, receipt } of audits) {
    const first = BigInt(receipt.firstPromotionSequence), last = BigInt(receipt.lastPromotionSequence);
    if (last < next) continue;
    if (first !== next || BigInt(receipt.basePromotionSequence) !== first - 1n ||
        receipt.organizationId !== scope.organizationId || receipt.providerId !== scope.providerId ||
        receipt.configVersionId !== scope.configVersionId || BigInt(receipt.configVersionNumber) !== scope.configVersionNumber ||
        receipt.sourceHeadRunId !== scope.sourceHeadRunId || Date.parse(receipt.sourceHeadFinishedAt) !== sourceAt ||
        receipt.sourceCheckpointHash !== scope.sourceCheckpointHash || BigInt(receipt.sourceGeneration) !== scope.sourceGeneration ||
        BigInt(receipt.importLeaseFence) < 1n || BigInt(receipt.importLeaseFence) > scope.importLeaseFence ||
        audit.correlation_id !== receipt.operationId || audit.target_id !== scope.providerId ||
        audit.actor_operator_id !== receipt.operatorId || audit.outcome !== "success" ||
        audit.occurred_at.toISOString() !== receipt.completedAt) return refuse();
    const completedAt = Date.parse(receipt.completedAt);
    if (!Number.isFinite(completedAt) || completedAt < settledAt) return refuse();
    const selected = changes.slice(offset, offset + Number(last - first + 1n));
    if (selected.length !== Number(last - first + 1n) || selected.some((row, index) =>
      row.sequence !== first + BigInt(index) || !Number.isFinite(row.changed_at.getTime()) ||
      row.changed_at.getTime() <= sourceAt || row.changed_at.getTime() > completedAt || row.entity_version < 1n)) return refuse();
    if (packContentBackfillChangesDigest(selected) !== receipt.promotionChangesDigest) return refuse();
    const declaredSnapshotIds = new Set(receipt.snapshots.map(({ id }) => id));
    const declaredPackIds = new Set<string>();
    for (const declared of receipt.snapshots) {
      const row = snapshots.get(declared.id);
      if (row === undefined || row.pack.pack_key !== declared.packKey || row.snapshot_digest !== declared.digest ||
          row.effective_at.getTime() > row.collected_at.getTime() || row.collected_at.getTime() > completedAt ||
          row.created_at.getTime() > completedAt) return refuse();
      declaredPackIds.add(row.pack_id);
    }
    const changedSnapshots = new Set<string>();
    for (const row of selected) {
      if (row.entity_type === "pack_content_snapshot") {
        if (!declaredSnapshotIds.has(row.entity_id) || row.operation !== "upsert" || row.entity_version !== 1n || changedSnapshots.has(row.entity_id)) return refuse();
        changedSnapshots.add(row.entity_id);
      } else if (row.entity_type === "pack_content") {
        const content = contents.get(row.entity_id);
        if (content === undefined || !declaredPackIds.has(content.pack_id) || row.entity_version > content.row_version ||
            (row.operation !== "upsert" && row.operation !== "retire")) return refuse();
      } else return refuse();
    }
    if (changedSnapshots.size !== declaredSnapshotIds.size) return refuse();
    confirmed.push(receipt);
    offset += selected.length;
    next = last + 1n;
    settledAt = completedAt;
  }
  if (offset !== changes.length || next !== scope.promotionSequence + 1n) return refuse();
  return { settledAt: new Date(settledAt), digest: packContentBackfillDigest(confirmed) };
}

export async function loadPackContentBackfillReadiness(
  transaction: ProviderTransactionClient,
  scope: PackContentBackfillReadinessScope,
): Promise<PackContentBackfillReadinessProof> {
  const changes = await transaction.promotion_changes.findMany({
    where: { changed_at: { gt: scope.sourceHeadFinishedAt } },
    orderBy: { sequence: "asc" }, take: MAX_CHANGES + 1,
  });
  if (changes.length > MAX_CHANGES) return refuse();
  if (changes.length === 0) return verifyPackContentBackfillReadiness({ scope, changes, audits: [], snapshots: [], contents: [] });
  const audits = await transaction.local_audit_events.findMany({
    where: { action: PACK_CONTENT_BACKFILL_ACTION, target_id: scope.providerId,
      outcome: "success", occurred_at: { gt: scope.sourceHeadFinishedAt } },
    orderBy: { sequence: "asc" }, take: MAX_RECEIPTS + 1,
  });
  if (audits.length > MAX_RECEIPTS) return refuse();
  const parsed = audits.map((row) => packContentBackfillReceiptSchema.safeParse(row.details));
  if (parsed.some((result) => !result.success)) return refuse();
  const [snapshots, contents] = await Promise.all([
    transaction.pack_content_snapshots.findMany({
      where: { id: { in: parsed.flatMap((result) => result.success ? result.data.snapshots.map(({ id }) => id) : []) } },
      include: { pack: { select: { pack_key: true } } },
    }),
    transaction.pack_contents.findMany({
      where: { id: { in: changes.filter(({ entity_type }) => entity_type === "pack_content").map(({ entity_id }) => entity_id) } },
      select: { id: true, pack_id: true, row_version: true },
    }),
  ]);
  return verifyPackContentBackfillReadiness({ scope, changes, audits, snapshots, contents });
}

import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const { verifyPackContentBackfillReadiness, PackContentBackfillReadinessError } = await tsImport("./pack-content-backfill-readiness.mts", import.meta.url);
const { packContentBackfillChangesDigest } = await tsImport("./pack-content-backfill-contract.mts", import.meta.url);
const uuid = (n) => `10000000-0000-5000-8000-${String(n).padStart(12, "0")}`;
const head = new Date("2026-08-30T12:00:00.000Z");
const complete = "2026-08-30T12:06:00.000Z";
function fixture() {
  const scope = { organizationId: uuid(1), providerId: uuid(2), configVersionId: uuid(3), configVersionNumber: 2n,
    sourceHeadRunId: uuid(4), sourceHeadFinishedAt: head, sourceCheckpointHash: "a".repeat(64), sourceGeneration: 3n,
    importLeaseFence: 5n, promotionSequence: 12n };
  const changes = [
    { sequence: 11n, entity_type: "pack_content", entity_id: uuid(6), entity_version: 2n, operation: "upsert", changed_at: new Date("2026-08-30T12:05:00.000Z") },
    { sequence: 12n, entity_type: "pack_content_snapshot", entity_id: uuid(7), entity_version: 1n, operation: "upsert", changed_at: new Date("2026-08-30T12:05:00.000Z") },
  ];
  const receipt = { schemaVersion: "provider_pack_content_backfill_v1", operationId: uuid(8), organizationId: scope.organizationId,
    providerId: scope.providerId, operatorId: uuid(9), configVersionId: scope.configVersionId, configVersionNumber: "2",
    sourceHeadRunId: scope.sourceHeadRunId, sourceHeadFinishedAt: head.toISOString(), sourceCheckpointHash: scope.sourceCheckpointHash,
    sourceGeneration: "3", basePromotionSequence: "10", manifestDigest: "b".repeat(64), importLeaseFence: "5",
    firstPromotionSequence: "11", lastPromotionSequence: "12", promotionChangesDigest: packContentBackfillChangesDigest(changes),
    snapshots: [{ id: uuid(7), packKey: "pack:one", digest: "c".repeat(64) }], completedAt: complete };
  return { scope, changes, audits: [{ correlation_id: uuid(8), target_id: scope.providerId, actor_operator_id: uuid(9),
    outcome: "success", occurred_at: new Date(complete), details: receipt }],
    snapshots: [{ id: uuid(7), pack_id: uuid(5), snapshot_digest: "c".repeat(64), effective_at: new Date("2026-08-30T12:02:00.000Z"),
      collected_at: new Date("2026-08-30T12:02:00.000Z"), created_at: new Date("2026-08-30T12:05:00.000Z"), pack: { pack_key: "pack:one" } }],
    contents: [{ id: uuid(6), pack_id: uuid(5), row_version: 2n }] };
}
test("audited catalog-only changes extend settlement without changing the native source head", () => {
  const input = fixture();
  const proof = verifyPackContentBackfillReadiness(input);
  assert.equal(proof.settledAt.toISOString(), complete);
  assert.match(proof.digest, /^[a-f0-9]{64}$/);
  assert.equal(input.scope.sourceHeadFinishedAt, head);
});
test("a normal source head that covers all changes needs no backfill receipt", () => {
  const input = fixture();
  const proof = verifyPackContentBackfillReadiness({ ...input, changes: [], audits: [] });
  assert.equal(proof.settledAt.toISOString(), head.toISOString());
  assert.equal(proof.digest, null);
});
for (const [name, change] of [
  ["missing completion", (x) => { x.audits = []; }],
  ["changed source cursor", (x) => { x.scope.sourceCheckpointHash = "d".repeat(64); }],
  ["different runtime generation", (x) => { x.scope.sourceGeneration = 4n; }],
  ["foreign provider", (x) => { x.audits[0].details.providerId = uuid(99); }],
  ["unbound operator", (x) => { x.audits[0].actor_operator_id = uuid(99); }],
  ["outside-pack write", (x) => { x.contents[0].pack_id = uuid(99); }],
  ["missing snapshot proof", (x) => { x.snapshots = []; }],
  ["changed snapshot digest", (x) => { x.snapshots[0].snapshot_digest = "d".repeat(64); }],
  ["changed promotion payload", (x) => { x.changes[0].entity_version = 1n; }],
  ["unrelated pack price write", (x) => { x.changes[0].entity_type = "pack"; x.audits[0].details.promotionChangesDigest = packContentBackfillChangesDigest(x.changes); }],
  ["post-completion write", (x) => { x.changes[0].changed_at = new Date("2026-08-30T12:07:00.000Z"); x.audits[0].details.promotionChangesDigest = packContentBackfillChangesDigest(x.changes); }],
  ["unconfirmed ledger tail", (x) => { x.scope.promotionSequence = 13n; }],
]) test(`refuses ${name} in catalog backfill settlement`, () => {
  const input = fixture(); change(input);
  assert.throws(() => verifyPackContentBackfillReadiness(input), PackContentBackfillReadinessError);
});

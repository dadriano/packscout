import { tsImport } from "tsx/esm/api";
const { packContentBackfillDigest } = await tsImport("./pack-content-backfill-contract.mts", import.meta.url);
const { providerMixedCursorFingerprint } = await tsImport("@packscout/database", import.meta.url);
export const uuid = n => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export function backfillManifest() {
  return { schemaVersion: "provider_pack_content_backfill_manifest_v1", operationId: uuid(1),
    organizationId: uuid(2), providerId: uuid(3), operatorId: uuid(4), configVersionId: uuid(5), configVersionNumber: "1",
    sourceHeadRunId: uuid(6), sourceHeadFinishedAt: "2026-08-30T12:00:00.000Z",
    sourceCheckpointHash: packContentBackfillDigest({ opaque: "test-checkpoint" }), sourceGeneration: "2", basePromotionSequence: "10",
    capturedAt: "2026-08-30T12:01:00.000Z", snapshots: [{ schemaVersion: "provider_pack_content_snapshot_v1",
      providerId: uuid(3), packKey: "pack:one", sourceKey: "provider:preview:v1", sourceAdapterVersion: "adapter-1", mapperVersion: "1",
      effectiveAt: "2026-08-30T12:01:00.000Z", effectiveAtBasis: "response_observed_at", collectedAt: "2026-08-30T12:01:00.000Z",
      completeness: "partial", items: [{ collectibleKey: "card:one", collectibleInstanceKey: null, status: "present",
        totalQuantity: null, availableQuantity: null, contentRole: "featured_chase", probability: null,
        statedValueAmount: null, statedValueCurrency: null, evidenceKinds: ["vendor_featured_chase"],
        matchConfidenceBasisPoints: 10000, displayOrder: 0 }] }],
    responseHashes: [{ packKey: "pack:one", sha256: "a".repeat(64) }] };
}

/** Deterministic transaction boundary for lease and read-only preflight fault tests. */
export function backfillLeaseFixture() {
  const manifest = backfillManifest();
  const state = { now: new Date("2026-08-30T12:02:00.000Z"), audits: [], acquireCalls: 0, releaseCalls: 0,
    currentSequence: 10n, acquiredFenceDrift: 0n, acquireError: null,
    lease: { worker_role: "import", lease_owner: null, lease_fence: 5n,
      heartbeat_at: null, lease_expires_at: null, row_version: 1n },
    packs: [{ pack_key: "pack:one", source_updated_at: new Date("2026-08-30T11:00:00.000Z"), content_snapshots: [] }],
    runtime: { operating_state: "idle", central_provider_id: manifest.providerId, provider_key: "clutchpacks",
      source_cursor: { opaque: "test-checkpoint" }, cached_config_version_id: manifest.configVersionId,
      source_cursor_hash: providerMixedCursorFingerprint({ opaque: "test-checkpoint" }),
      cached_config_version_number: 1n, state_generation: 2n },
  };
  const tx = {
    database_identity: { findUnique: async () => ({ database_role: "provider", provider_id: manifest.providerId, provider_key: "clutchpacks" }) },
    provider_runtime: { findUnique: async () => state.runtime },
    provider_runs: { findFirst: async () => ({ id: manifest.sourceHeadRunId, state: "succeeded", reached_source_head: true,
      finished_at: new Date(manifest.sourceHeadFinishedAt), final_cursor: { opaque: "test-checkpoint" },
      final_cursor_hash: providerMixedCursorFingerprint({ opaque: "test-checkpoint" }),
      config_version_id: manifest.configVersionId, config_version_number: 1n }), count: async () => 0 },
    promotion_ledger: { findUnique: async () => ({ last_sequence: state.currentSequence }) },
    control_commands: { count: async () => 0 },
    packs: { findMany: async () => state.packs },
    local_audit_events: {
      findMany: async ({ where, take }) => state.audits.filter(row => row.correlation_id === where.correlation_id && row.action === where.action).slice(0, take),
      create: async ({ data }) => { const row = { ...data, sequence: BigInt(state.audits.length + 1) }; state.audits.push(row); return row; },
    },
    $queryRaw: async query => {
      const sql = typeof query.sql === "string" ? query.sql : query.join("");
      if (sql.includes("provider_worker_states")) return [{ ...state.lease, database_now: state.now }];
      if (sql.includes("provider_runtime")) return [{ singleton_key: true }];
      if (sql.includes("clock_timestamp")) return [{ now: state.now }];
      throw new Error("Unexpected fixture query");
    },
  };
  const database = { $transaction: async run => {
    const audits = [...state.audits];
    try { return await run(tx); } catch (error) { state.audits = audits; throw error; }
  } };
  const leases = {
    acquire: async ({ role, owner, leaseMilliseconds }) => {
      state.acquireCalls++;
      if (state.acquireError) throw state.acquireError;
      const lease = { role, owner, fence: state.lease.lease_fence + 1n + state.acquiredFenceDrift,
        heartbeatAt: state.now, expiresAt: new Date(state.now.getTime() + leaseMilliseconds), rowVersion: 2n };
      state.lease = { worker_role: role, lease_owner: owner, lease_fence: lease.fence, heartbeat_at: lease.heartbeatAt,
        lease_expires_at: lease.expiresAt, row_version: lease.rowVersion };
      return { kind: "acquired", lease };
    },
    release: async () => { state.releaseCalls++; state.lease.lease_owner = null; return true; },
  };
  return { manifest, state, tx, database, leases, revalidateAuthority: async () => {} };
}

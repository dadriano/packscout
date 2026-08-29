import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  BoundedProviderDatabaseGateway,
  CentralPrismaClient,
  ProviderPrismaClient,
} from "@packscout/database";
import { createDistributedImportOperationsRuntime } from
  "./distributed-import-operations-runtime.ts";
import type { ImportOperationsRouterDependencies } from
  "./routes/import-operations.ts";

const organizationId = "20000000-0000-4000-8000-000000000001";
const providerId = "20000000-0000-4000-8000-000000000002";
const revisionId = "20000000-0000-4000-8000-000000000003";
const runId = "20000000-0000-4000-8000-000000000004";
const pageId = "20000000-0000-4000-8000-000000000005";
const requestedAt = new Date("2026-08-29T18:00:00.000Z");

const runRow = {
  id: runId,
  trigger: "manual" as const,
  state: "succeeded" as const,
  requested_by_operator_id: null,
  config_version_id: revisionId,
  config_version_number: 1n,
  worker_fence: 1n,
  attempt_number: 1,
  recovery_of_run_id: null,
  requested_cursor_hash: null,
  final_cursor_hash: null,
  reached_source_head: true,
  page_count: 1,
  catalog_record_count: 10,
  pull_record_count: 20,
  market_event_record_count: 15,
  accepted_count: 30,
  duplicate_count: 0,
  quarantined_count: 15,
  material_change_count: 5,
  failure_code: null,
  failure_class: null,
  requested_at: requestedAt,
  started_at: requestedAt,
  last_progress_at: requestedAt,
  heartbeat_at: requestedAt,
  finished_at: requestedAt,
};

const quarantineRows = Array.from({ length: 15 }, (_, index) => ({
  id: `21000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  provider_run_id: runId,
  provider_run_page_id: pageId,
  record_index: index,
  record_kind: "market_event",
  external_id: `native-${index}`,
  reason_code: "MAPPING_FAILED",
  field_path: "value",
  sanitized_summary: "A market event could not be mapped.",
  evidence_expires_at: new Date("2026-11-29T18:00:00.000Z"),
  retry_count: 0,
  last_retry_at: null,
  resolved_at: null,
  state: "open" as const,
  created_at: new Date(requestedAt.getTime() + index),
  provider_run: { config_version_id: revisionId },
}));

function providerDatabase(): ProviderPrismaClient {
  return {
    provider_runs: {
      async findUnique() {
        return runRow;
      },
    },
    provider_run_pages: {
      async findMany() {
        return [{
          page_number: 1,
          continuation: "head" as const,
          committed_at: requestedAt,
          requested_cursor_hash: null,
          next_cursor_hash: null,
          response_digest: "a".repeat(64),
          catalog_record_count: 10,
          pull_record_count: 20,
          market_event_record_count: 15,
          accepted_count: 30,
          duplicate_count: 0,
          quarantined_count: 15,
          material_change_count: 5,
        }];
      },
    },
    quarantine_records: {
      async findMany(input: { select?: { sanitized_summary?: boolean } }) {
        return input.select?.sanitized_summary
          ? quarantineRows
          : quarantineRows.map((row) => ({
              id: row.id,
              state: row.state,
              record_kind: row.record_kind,
              record_index: row.record_index,
              reason_code: row.reason_code,
            }));
      },
    },
  } as unknown as ProviderPrismaClient;
}

function runtime() {
  const central = {
    async $queryRaw() {
      return [{ provider_id: providerId }];
    },
    providers: {
      async findMany() {
        return [{
          id: providerId,
          provider_key: "clutchpacks",
          display_name: "ClutchPacks",
        }];
      },
    },
  } as unknown as CentralPrismaClient;
  const gateway = {
    async runWithAdminProviderDatabase(
      _target: unknown,
      operation: (database: ProviderPrismaClient) => Promise<unknown>,
    ) {
      return {
        state: "reachable" as const,
        providerId,
        observedAt: requestedAt.toISOString(),
        value: await operation(providerDatabase()),
      };
    },
  } as unknown as Pick<
    BoundedProviderDatabaseGateway,
    "runWithAdminProviderDatabase"
  >;
  const manualImports = {
    async request() {
      throw new Error("not used");
    },
  } as ImportOperationsRouterDependencies["manualImports"];
  return createDistributedImportOperationsRuntime({
    central,
    gateway,
    manualImports,
    now: () => requestedAt,
  });
}

test("provider-backed run detail preserves all related quarantine summaries", async () => {
  const detail = await runtime().reads.getRun({ organizationId, runId });
  assert.ok(detail);
  assert.equal(detail.counters.quarantined, 15);
  assert.equal(detail.relatedQuarantines.length, 15);
  assert.equal(detail.relatedQuarantines[0]?.recordKind, "trade");
  assert.equal(detail.relatedQuarantines[0]?.configurationRevisionId, revisionId);
});

test("provider-backed quarantine list exposes the same bounded safe summaries", async () => {
  const page = await runtime().reads.listQuarantines({
    organizationId,
    providerId,
    limit: 25,
  });
  assert.equal(page.items.length, 15);
  assert.ok(page.items.every((item) => item.recordKind === "trade"));
  assert.ok(page.items.every((item) => item.externalId?.startsWith("native-")));
});

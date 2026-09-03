import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  BoundedProviderDatabaseGateway,
  CentralPrismaClient,
  ProviderPrismaClient,
} from "@packscout/database";
import {
  createDistributedImportOperationsRuntime,
  ProviderReadUnavailableError,
} from "./distributed-import-operations-runtime.ts";

const organizationId = "22000000-0000-4000-8000-000000000001";
const providerId = "22000000-0000-4000-8000-000000000002";
const otherProviderId = "22000000-0000-4000-8000-000000000003";
const runId = "22000000-0000-4000-8000-000000000004";
const otherOrganizationId = "22000000-0000-4000-8000-000000000005";
const revisionId = "22000000-0000-4000-8000-000000000006";
const observedAt = new Date("2026-08-30T01:00:00.000Z");

type Target = { organizationId: string; providerId: string };
type ProviderRead = { where: { organization_id: string; id?: string }; take: number };

function harness(state: "queued" | "running" = "queued", reachable = true) {
  const providerReads: ProviderRead[] = [];
  const targets: Target[] = [];
  const runReads: Array<{ providerId: string; runId: string }> = [];
  let observationReads = 0;
  const central = {
    async $queryRaw() {
      observationReads += 1;
      throw new Error("Fresh runs have no relayed activity or global run-owner index.");
    },
    providers: {
      async findMany(input: ProviderRead) {
        providerReads.push(input);
        assert.equal(input.take, 1);
        assert.ok(input.where.id, "run detail must never scan providers");
        if (input.where.organization_id !== organizationId) return [];
        if (![providerId, otherProviderId].includes(input.where.id)) return [];
        return [{
          id: input.where.id,
          provider_key: input.where.id === providerId ? "courtyard" : "clutchpacks",
          display_name: input.where.id === providerId ? "Courtyard" : "ClutchPacks",
        }];
      },
    },
  } as unknown as CentralPrismaClient;
  const gateway = {
    async runWithAdminProviderDatabase(
      target: Target,
      operation: (database: ProviderPrismaClient) => Promise<unknown>,
    ) {
      targets.push(target);
      if (!reachable) return { state: "unreachable", providerId: target.providerId };
      const database = {
        provider_runs: {
          async findUnique(input: { where: { id: string } }) {
            runReads.push({ providerId: target.providerId, runId: input.where.id });
            if (target.providerId !== providerId || input.where.id !== runId) return null;
            return {
              id: runId,
              trigger: "manual",
              state,
              requested_by_operator_id: null,
              config_version_id: revisionId,
              config_version_number: 1n,
              worker_fence: state === "running" ? 1n : null,
              attempt_number: 1,
              recovery_of_run_id: null,
              requested_cursor_hash: null,
              final_cursor_hash: null,
              reached_source_head: false,
              page_count: 0,
              catalog_record_count: 0,
              pull_record_count: 0,
              market_event_record_count: 0,
              accepted_count: 0,
              duplicate_count: 0,
              quarantined_count: 0,
              material_change_count: 0,
              failure_code: null,
              failure_class: null,
              requested_at: observedAt,
              started_at: state === "running" ? observedAt : null,
              last_progress_at: null,
              heartbeat_at: state === "running" ? observedAt : null,
              finished_at: null,
            };
          },
        },
        provider_run_pages: { async findMany() { return []; } },
        quarantine_records: { async findMany() { return []; } },
      } as unknown as ProviderPrismaClient;
      return {
        state: "reachable",
        providerId: target.providerId,
        observedAt: observedAt.toISOString(),
        value: await operation(database),
      };
    },
  } as unknown as Pick<BoundedProviderDatabaseGateway, "runWithAdminProviderDatabase">;
  const runtime = createDistributedImportOperationsRuntime({
    central,
    gateway,
    manualImports: { async request() { throw new Error("Run detail must not queue work."); } },
    now: () => observedAt,
  });
  return { runtime, providerReads, targets, runReads, observationReads: () => observationReads };
}

for (const state of ["queued", "running"] as const) {
  test(`fresh ${state} run detail is available before any central activity relay`, async () => {
    const subject = harness(state);
    const run = await subject.runtime.reads.getRun({ organizationId, providerId, runId });
    assert.equal(run?.id, runId);
    assert.equal(run?.providerId, providerId);
    assert.equal(run?.state, state);
    assert.deepEqual(subject.providerReads.map((read) => read.where), [{ organization_id: organizationId, id: providerId }]);
    assert.deepEqual(subject.targets, [{ organizationId, providerId }]);
    assert.deepEqual(subject.runReads, [{ providerId, runId }]);
    assert.equal(subject.observationReads(), 0);
  });
}

test("wrong provider cannot discover the run in another authorized provider database", async () => {
  const subject = harness();
  assert.equal(await subject.runtime.reads.getRun({ organizationId, providerId: otherProviderId, runId }), null);
  assert.deepEqual(subject.targets, [{ organizationId, providerId: otherProviderId }]);
  assert.deepEqual(subject.runReads, [{ providerId: otherProviderId, runId }]);
  assert.equal(subject.observationReads(), 0);
});

test("wrong organization is rejected centrally before any provider database access", async () => {
  const subject = harness();
  assert.equal(await subject.runtime.reads.getRun({ organizationId: otherOrganizationId, providerId, runId }), null);
  assert.deepEqual(subject.providerReads.map((read) => read.where), [{ organization_id: otherOrganizationId, id: providerId }]);
  assert.deepEqual(subject.targets, []);
  assert.deepEqual(subject.runReads, []);
  assert.equal(subject.observationReads(), 0);
});

test("malformed or absent qualification cannot degrade into a provider scan", async () => {
  const subject = harness();
  for (const invalid of [
    { organizationId: "not-an-organization", providerId, runId },
    { organizationId, providerId: "", runId },
    { organizationId, providerId: "courtyard", runId },
    { organizationId, providerId, runId: "not-a-run" },
    { organizationId, runId },
  ]) {
    assert.equal(await subject.runtime.reads.getRun(invalid as Parameters<typeof subject.runtime.reads.getRun>[0]), null);
  }
  assert.deepEqual(subject.providerReads, []);
  assert.deepEqual(subject.targets, []);
  assert.equal(subject.observationReads(), 0);
});

test("an unreachable selected provider is unavailable rather than not found or a fallback read", async () => {
  const subject = harness("running", false);
  await assert.rejects(subject.runtime.reads.getRun({ organizationId, providerId, runId }), ProviderReadUnavailableError);
  assert.deepEqual(subject.targets, [{ organizationId, providerId }]);
  assert.deepEqual(subject.runReads, []);
  assert.equal(subject.observationReads(), 0);
});

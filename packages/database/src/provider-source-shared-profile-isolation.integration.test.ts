import assert from "node:assert/strict";
import { test } from "node:test";
import { providerIdentityNamespaceByLaunchProvider } from "@packscout/contracts";
import { ProviderSourceDiagnosticRepository } from "./provider-source-diagnostic-repository.ts";
import {
  ACCEPTANCE_CREATED_AT,
  ACCEPTANCE_NORMALIZED_CONTRACT_VERSION,
  ACCEPTANCE_SOURCE_ADAPTER_VERSION,
  ACCEPTANCE_SOURCE_TYPE_KEY,
  createAcceptanceProviderSource,
  createPinnedSourceRun,
  createProviderSourceAcceptanceFixture,
  type AcceptanceSource,
  type ProviderSourceAcceptanceFixture,
} from "./provider-source-acceptance-test-support.ts";

const sourceDefinitions = [
  {
    platformKey: "courtyard",
    displayName: "Courtyard",
    mapperKey: "courtyard-provider-observation",
    identityNamespaceKey: providerIdentityNamespaceByLaunchProvider.courtyard,
    intervalSeconds: 60,
    hashCharacter: "b",
  },
  {
    platformKey: "collector_crypt",
    displayName: "Collector Crypt",
    mapperKey: "collector-crypt-provider-observation",
    identityNamespaceKey:
      providerIdentityNamespaceByLaunchProvider.collector_crypt,
    intervalSeconds: 120,
    hashCharacter: "c",
  },
  {
    platformKey: "phygitals",
    displayName: "Phygitals",
    mapperKey: "phygitals-provider-observation",
    identityNamespaceKey: providerIdentityNamespaceByLaunchProvider.phygitals,
    intervalSeconds: 180,
    hashCharacter: "d",
  },
  {
    platformKey: "clutchpacks",
    displayName: "ClutchPacks",
    mapperKey: "clutchpacks-provider-observation",
    identityNamespaceKey: providerIdentityNamespaceByLaunchProvider.clutchpacks,
    intervalSeconds: 240,
    hashCharacter: "e",
  },
] as const;

async function siblingSnapshot(
  fixture: ProviderSourceAcceptanceFixture,
  sources: readonly AcceptanceSource[],
) {
  const sourceIds = sources.map(({ sourceInstanceId }) => sourceInstanceId);
  return Promise.all([
    fixture.database.provider_source_schedules.findMany({
      where: { source_instance_id: { in: sourceIds } },
      orderBy: { source_instance_id: "asc" },
    }),
    fixture.database.provider_source_checkpoints.findMany({
      where: { source_instance_id: { in: sourceIds } },
      orderBy: { source_instance_id: "asc" },
    }),
    fixture.database.provider_source_health_states.findMany({
      where: { source_instance_id: { in: sourceIds } },
      orderBy: { source_instance_id: "asc" },
    }),
    fixture.database.import_runs.findMany({
      where: { source_instance_id: { in: sourceIds } },
      orderBy: { source_instance_id: "asc" },
    }),
    fixture.database.source_processor_diagnostic_events.findMany({
      where: { source_instance_id: { in: sourceIds } },
      orderBy: [{ source_instance_id: "asc" }, { occurred_at: "asc" }],
    }),
  ]);
}

test("four sources sharing one connection retain independent processor state and feeds", async () => {
  const fixture = await createProviderSourceAcceptanceFixture(
    "shared-profile-isolation",
  );
  try {
    const sources = await Promise.all(
      sourceDefinitions.map((definition) =>
        createAcceptanceProviderSource(fixture, definition),
      ),
    );
    const diagnostics = new ProviderSourceDiagnosticRepository(
      fixture.database,
    );

    for (const [index, source] of sources.entries()) {
      const occurredAt = new Date(
        ACCEPTANCE_CREATED_AT.getTime() + index * 1_000,
      );
      const run = await createPinnedSourceRun(
        fixture.database,
        fixture,
        source,
        {
          state: "succeeded",
          createdAt: occurredAt,
          requestedCheckpoint: null,
          requestedCheckpointFingerprint: null,
        },
      );
      await fixture.database.provider_source_schedules.update({
        where: { source_instance_id: source.sourceInstanceId },
        data: { last_run_id: run.id, last_outcome: "head_reached" },
      });
      await diagnostics.append({
        organizationId: fixture.organizationId,
        scope: "source",
        correlationKind: "run",
        eventKind: "source_run",
        severity: "info",
        phase: "run",
        safeCode: `${source.platformKey.toUpperCase()}_RUN`,
        occurredAt,
        sourceTypeKey: ACCEPTANCE_SOURCE_TYPE_KEY,
        sourceAdapterVersion: ACCEPTANCE_SOURCE_ADAPTER_VERSION,
        normalizedContractVersion: ACCEPTANCE_NORMALIZED_CONTRACT_VERSION,
        providerId: source.providerId,
        sourceInstanceId: source.sourceInstanceId,
        sourceRevisionId: source.sourceRevisionId,
        connectionProfileId: fixture.connectionProfileId,
        connectionRevisionId: fixture.connectionRevisionId,
        runId: run.id,
        runTrigger: "scheduled",
      });
    }

    const sourceRows =
      await fixture.database.provider_source_instances.findMany({
        where: { organization_id: fixture.organizationId },
      });
    assert.equal(sourceRows.length, 4);
    assert.deepEqual(
      new Set(
        sourceRows.map(({ connection_profile_id }) => connection_profile_id),
      ),
      new Set([fixture.connectionProfileId]),
    );

    const sourceIds = sources.map(({ sourceInstanceId }) => sourceInstanceId);
    const [schedules, checkpoints, runs, health, diagnosticRows] =
      await Promise.all([
        fixture.database.provider_source_schedules.findMany({
          where: { source_instance_id: { in: sourceIds } },
        }),
        fixture.database.provider_source_checkpoints.findMany({
          where: { source_instance_id: { in: sourceIds } },
        }),
        fixture.database.import_runs.findMany({
          where: { source_instance_id: { in: sourceIds } },
        }),
        fixture.database.provider_source_health_states.findMany({
          where: { source_instance_id: { in: sourceIds } },
        }),
        fixture.database.source_processor_diagnostic_events.findMany({
          where: { source_instance_id: { in: sourceIds } },
        }),
      ]);
    for (const rows of [schedules, checkpoints, runs, health, diagnosticRows]) {
      assert.equal(rows.length, 4);
      assert.equal(
        new Set(
          rows.map(
            ({ source_instance_id: sourceInstanceId }) => sourceInstanceId,
          ),
        ).size,
        4,
      );
    }
    assert.deepEqual(
      new Set(
        checkpoints.map(({ checkpoint_generation: generation }) => generation),
      ),
      new Set([1n]),
    );

    const diagnosticId = diagnosticRows[0]!.id;
    for (const data of [
      { duration_ms: -1 },
      { response_bytes: -1 },
      { retry_delay_ms: -1 },
    ]) {
      await assert.rejects(
        fixture.database.source_processor_diagnostic_events.update({
          where: { id: diagnosticId },
          data,
        }),
      );
    }

    for (const source of sources) {
      const feed = await diagnostics.listForSource({
        organizationId: fixture.organizationId,
        sourceInstanceId: source.sourceInstanceId,
        limit: 10,
        asOf: new Date(ACCEPTANCE_CREATED_AT.getTime() + 10_000),
      });
      assert.deepEqual(
        feed.map(({ safeCode }) => safeCode),
        [`${source.platformKey.toUpperCase()}_RUN`],
      );
    }

    const siblings = sources.slice(1);
    const before = await siblingSnapshot(fixture, siblings);
    const isolated = sources[0]!;
    await fixture.database.$transaction([
      fixture.database.provider_source_schedules.update({
        where: { source_instance_id: isolated.sourceInstanceId },
        data: {
          next_due_at: new Date(ACCEPTANCE_CREATED_AT.getTime() + 86_400_000),
          last_outcome: "retryable_failure",
        },
      }),
      fixture.database.provider_source_health_states.update({
        where: { source_instance_id: isolated.sourceInstanceId },
        data: {
          consecutive_failures: 1,
          latest_failure_code: "isolated_failure",
        },
      }),
    ]);
    assert.deepEqual(await siblingSnapshot(fixture, siblings), before);
  } finally {
    await fixture.close();
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { providerIdentityNamespaceByLaunchProvider } from "@packscout/contracts";
import {
  ACCEPTANCE_CREATED_AT,
  createAcceptanceProviderSource,
  createPinnedSourceRun,
  createProviderSourceAcceptanceFixture,
} from "./provider-source-acceptance-test-support.ts";
import { ProviderSourceDiagnosticRepository } from "./provider-source-diagnostic-repository.ts";
import { ProviderSourceOperationsRepository } from "./provider-source-operations-repository.ts";

test("source operations reads source-owned counters and reject cross-tenant referents", async () => {
  const fixture = await createProviderSourceAcceptanceFixture("operations-read");
  try {
    const source = await createAcceptanceProviderSource(fixture, {
      platformKey: "courtyard",
      displayName: "Courtyard",
      mapperKey: "courtyard-mapper",
      identityNamespaceKey: providerIdentityNamespaceByLaunchProvider.courtyard,
      intervalSeconds: 60,
      hashCharacter: "8",
    });
    const run = await createPinnedSourceRun(
      fixture.database,
      fixture,
      source,
      {
        state: "running",
        createdAt: ACCEPTANCE_CREATED_AT,
        requestedCheckpoint: null,
        requestedCheckpointFingerprint: null,
      },
    );
    await fixture.database.import_runs.update({
      where: { id: run.id },
      data: {
        heartbeat_at: new Date(ACCEPTANCE_CREATED_AT.getTime() + 1_000),
        counters_json: {
          pages: 2,
          records: 9,
          catalog: 4,
          pulls: 3,
          trades: 2,
          inserted: 5,
          revised: 1,
          duplicate: 2,
          quarantined: 1,
        },
      },
    });
    await fixture.database.provider_source_health_states.update({
      where: { source_instance_id: source.sourceInstanceId },
      data: {
        last_attempted_at: ACCEPTANCE_CREATED_AT,
        last_head_reached_at: ACCEPTANCE_CREATED_AT,
        updated_at: ACCEPTANCE_CREATED_AT,
      },
    });
    const repository = new ProviderSourceOperationsRepository(fixture.database);
    const overview = await repository.readOverview({
      organizationId: fixture.organizationId,
      providerIds: [source.providerId],
      sourceInstanceIds: [source.sourceInstanceId],
      connectionProfileIds: [fixture.connectionProfileId],
    });
    assert.equal(overview.providers[0]?.displayName, "Courtyard");
    assert.deepEqual(overview.sources[0]?.activeRun?.counters, {
      pages: 2,
      records: 9,
      catalog: 4,
      pulls: 3,
      trades: 2,
      inserted: 5,
      revised: 1,
      duplicate: 2,
      quarantined: 1,
    });
    const detail = await repository.readDetail({
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      sourceInstanceId: source.sourceInstanceId,
    });
    assert.equal(detail?.runs[0]?.id, run.id);
    assert.equal(detail?.runs[0]?.lastProgressAt.toISOString(),
      new Date(ACCEPTANCE_CREATED_AT.getTime() + 1_000).toISOString());
    const crossTenant = await repository.readDetail({
      organizationId: "89000000-0000-4000-8000-000000009999",
      providerId: source.providerId,
      sourceInstanceId: source.sourceInstanceId,
    });
    assert.equal(crossTenant, null);

    const diagnostics = new ProviderSourceDiagnosticRepository(fixture.database);
    const diagnosticBase = {
      organizationId: fixture.organizationId,
      scope: "source" as const,
      correlationKind: "run" as const,
      eventKind: "source_run" as const,
      sourceTypeKey: "dataforrest-events-v1",
      sourceAdapterVersion: "dataforrest-events-adapter-v1",
      normalizedContractVersion: "packscout.provider-observation.v1",
      providerId: source.providerId,
      sourceInstanceId: source.sourceInstanceId,
      sourceRevisionId: source.sourceRevisionId,
      connectionProfileId: fixture.connectionProfileId,
      connectionRevisionId: fixture.connectionRevisionId,
      runId: run.id,
      runTrigger: "scheduled" as const,
    };
    const firstDiagnosticId = await diagnostics.append({
      ...diagnosticBase,
      severity: "info",
      phase: "queue",
      safeCode: "WORK_QUEUED",
      occurredAt: ACCEPTANCE_CREATED_AT,
    });
    await diagnostics.append({
      ...diagnosticBase,
      severity: "warning",
      phase: "retry",
      safeCode: "RETRY_SCHEDULED",
      occurredAt: new Date(ACCEPTANCE_CREATED_AT.getTime() + 1_000),
      retryDelayMs: 1_000,
    });
    const filtered = await diagnostics.readHistoryPage({
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      sourceInstanceId: source.sourceInstanceId,
      runId: run.id,
      severity: "warning",
      limit: 25,
      asOf: ACCEPTANCE_CREATED_AT,
    });
    assert.deepEqual(filtered?.events.map(({ safeCode }) => safeCode), [
      "RETRY_SCHEDULED",
    ]);
    assert.deepEqual(filtered?.availablePhases, ["queue", "retry"]);
    const expired = await diagnostics.readHistoryPage({
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      sourceInstanceId: source.sourceInstanceId,
      limit: 25,
      before: {
        occurredAt: ACCEPTANCE_CREATED_AT,
        id: "89000000-0000-4000-8000-000000009998",
      },
      asOf: ACCEPTANCE_CREATED_AT,
    });
    assert.equal(expired?.state, "expired");
    assert.notEqual(firstDiagnosticId, "");
  } finally {
    await fixture.close();
  }
});

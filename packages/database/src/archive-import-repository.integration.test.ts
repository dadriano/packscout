import assert from "node:assert/strict";
import test from "node:test";
import { PrismaArchiveImportRepository } from "./archive-import-repository.ts";
import { PrismaProviderConfigurationRepository } from "./provider-configuration-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

const ids = {
  organization: "20000000-0000-4000-8000-000000000001",
  provider: "20000000-0000-4000-8000-000000000010",
  httpV1: "20000000-0000-4000-8000-000000000020",
  archiveV2: "20000000-0000-4000-8000-000000000021",
  httpV3: "20000000-0000-4000-8000-000000000022",
  duplicateArchiveRevision: "20000000-0000-4000-8000-000000000023",
  archiveRun: "20000000-0000-4000-8000-000000000030",
  duplicateRun: "20000000-0000-4000-8000-000000000031",
} as const;
const createdAt = new Date("2026-08-14T10:00:00.000Z");
const digest = "a".repeat(64);
const actorKeyFingerprint = "b".repeat(64);
const importerBuildSha = "d".repeat(40);

test("archive provenance is digest-bound, idempotent, and isolated from the live HTTP revision", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await harness.database.organizations.create({
      data: {
        id: ids.organization,
        slug: "archive-provenance",
        name: "Archive Provenance",
        created_at: createdAt,
      },
    });
    const configurations = new PrismaProviderConfigurationRepository(harness.database);
    const created = await configurations.createProvider({
      organizationId: ids.organization,
      providerId: ids.provider,
      revisionId: ids.httpV1,
      platformKey: "collector_crypt",
      displayName: "Collector Crypt",
      adapterKey: "collector-crypt-v2",
      endpoint: "https://provider.example/feed",
      authMode: "none",
      scheduleSeconds: 300,
      staleAfterSeconds: 900,
      encryptedCredential: null,
      actorKey: "operator:archive",
      now: createdAt,
    });
    assert.equal(created.kind, "created");

    const archives = new PrismaArchiveImportRepository(harness.database);
    assert.deepEqual(await archives.ensureArchiveRevision({
      organizationId: ids.organization,
      providerId: ids.provider,
      configurationRevisionId: ids.archiveV2,
      platformKey: "collector_crypt",
      mappingAdapterKey: "collector-crypt-v2",
      actorPseudonymKeyFingerprint: actorKeyFingerprint,
      archiveImporterBuildSha: importerBuildSha,
      archiveSha256: digest,
      actorKey: "operator:archive",
      createdAt,
    }), { created: true });
    assert.deepEqual(await archives.ensureArchiveRevision({
      organizationId: ids.organization,
      providerId: ids.provider,
      configurationRevisionId: ids.archiveV2,
      platformKey: "collector_crypt",
      mappingAdapterKey: "collector-crypt-v2",
      actorPseudonymKeyFingerprint: actorKeyFingerprint,
      archiveImporterBuildSha: importerBuildSha,
      archiveSha256: digest,
      actorKey: "operator:archive",
      createdAt,
    }), { created: false });
    await assert.rejects(
      archives.ensureArchiveRevision({
        organizationId: ids.organization,
        providerId: ids.provider,
        configurationRevisionId: ids.archiveV2,
        platformKey: "collector_crypt",
        mappingAdapterKey: "collector-crypt-v2",
        actorPseudonymKeyFingerprint: "c".repeat(64),
        archiveImporterBuildSha: importerBuildSha,
        archiveSha256: digest,
        actorKey: "operator:archive",
        createdAt,
      }),
      /does not match the explicit scope/i,
    );
    await assert.rejects(
      archives.ensureArchiveRevision({
        organizationId: ids.organization,
        providerId: ids.provider,
        configurationRevisionId: ids.archiveV2,
        platformKey: "collector_crypt",
        mappingAdapterKey: "collector-crypt-v2",
        actorPseudonymKeyFingerprint: actorKeyFingerprint,
        archiveImporterBuildSha: "f".repeat(40),
        archiveSha256: digest,
        actorKey: "operator:archive",
        createdAt,
      }),
      /does not match the explicit scope/i,
    );
    await assert.rejects(
      archives.ensureArchiveRevision({
        organizationId: ids.organization,
        providerId: ids.provider,
        configurationRevisionId: ids.duplicateArchiveRevision,
        platformKey: "collector_crypt",
        mappingAdapterKey: "collector-crypt-v2",
        actorPseudonymKeyFingerprint: actorKeyFingerprint,
        archiveImporterBuildSha: importerBuildSha,
        archiveSha256: digest,
        actorKey: "operator:archive",
        createdAt,
      }),
      /already bound to another revision/i,
    );

    const archiveRevision = await harness.database.provider_config_revisions.findUniqueOrThrow({
      where: { id: ids.archiveV2 },
    });
    assert.equal(archiveRevision.version, 2);
    assert.equal(archiveRevision.source_mode, "archive");
    assert.equal(archiveRevision.adapter_key, "provider-archive-v2");
    assert.equal(archiveRevision.mapping_adapter_key, "collector-crypt-v2");
    assert.equal(
      archiveRevision.actor_pseudonym_key_fingerprint,
      actorKeyFingerprint,
    );
    assert.equal(archiveRevision.archive_importer_build_sha, importerBuildSha);
    assert.equal(archiveRevision.endpoint_url, `archive://sha256/${digest}`);
    assert.equal(archiveRevision.auth_mode, "none");
    assert.equal(archiveRevision.tested_at, null);
    assert.equal(await harness.database.provider_secret_versions.count({
      where: { revision_id: ids.archiveV2 },
    }), 0);
    assert.equal(await harness.database.provider_schedules.count({
      where: { config_revision_id: ids.archiveV2 },
    }), 0);

    const summaryAfterArchive = await configurations.getProvider(
      ids.organization,
      ids.provider,
    );
    assert.equal(summaryAfterArchive?.latestRevision.id, ids.httpV1);
    assert.equal(
      summaryAfterArchive?.latestRevision.endpoint,
      "https://provider.example/feed",
    );
    assert.equal((await configurations.getRevisionForConnectionTest({
      organizationId: ids.organization,
      providerId: ids.provider,
      expectedRevisionId: ids.httpV1,
    })).kind, "found");
    assert.equal(await configurations.getImmutableRevisionForRuntime({
      organizationId: ids.organization,
      providerId: ids.provider,
      revisionId: ids.archiveV2,
    }), null);

    const replaced = await configurations.replaceRevision({
      organizationId: ids.organization,
      providerId: ids.provider,
      revisionId: ids.httpV3,
      expectedRevisionId: ids.httpV1,
      adapterKey: "collector-crypt-v2",
      endpoint: "https://provider.example/feed-v3",
      authMode: "none",
      scheduleSeconds: 300,
      staleAfterSeconds: 900,
      encryptedCredential: null,
      actorKey: "operator:archive",
      now: new Date(createdAt.getTime() + 1_000),
    });
    assert.equal(replaced.kind, "updated");
    assert.equal((await harness.database.provider_config_revisions.findUniqueOrThrow({
      where: { id: ids.httpV3 },
      select: { version: true, source_mode: true },
    })).version, 3);

    const firstRequest = await archives.requestArchiveRun({
      organizationId: ids.organization,
      providerId: ids.provider,
      configurationRevisionId: ids.archiveV2,
      runId: ids.archiveRun,
      archiveSha256: digest,
      requestedByActorKey: "operator:archive",
      requestedAt: createdAt,
      initialCursor: "archive-v2:0:0",
      maximumElapsedMs: 4 * 60 * 60 * 1_000,
    });
    assert.equal(firstRequest.kind, "created");
    const duplicateRequest = await archives.requestArchiveRun({
      organizationId: ids.organization,
      providerId: ids.provider,
      configurationRevisionId: ids.archiveV2,
      runId: ids.duplicateRun,
      archiveSha256: digest,
      requestedByActorKey: "operator:archive",
      requestedAt: createdAt,
      initialCursor: "archive-v2:0:0",
      maximumElapsedMs: 1_000,
    });
    assert.equal(duplicateRequest.kind, "existing");
    if (duplicateRequest.kind === "existing") {
      assert.equal(duplicateRequest.run.id, ids.archiveRun);
    }
    const immutableRunCounters = await harness.database.import_runs.findUniqueOrThrow({
      where: { id: ids.archiveRun },
      select: { counters_json: true },
    });
    assert.equal(
      (immutableRunCounters.counters_json as { archiveMaximumElapsedMs?: number })
        .archiveMaximumElapsedMs,
      4 * 60 * 60 * 1_000,
    );
    const wrongRevisionReplay = await archives.requestArchiveRun({
      organizationId: ids.organization,
      providerId: ids.provider,
      configurationRevisionId: ids.httpV3,
      runId: ids.duplicateRun,
      archiveSha256: digest,
      requestedByActorKey: "operator:archive",
      requestedAt: createdAt,
      initialCursor: "archive-v2:0:0",
      maximumElapsedMs: 4 * 60 * 60 * 1_000,
    });
    assert.equal(wrongRevisionReplay.kind, "revision_conflict");
    assert.deepEqual(await archives.claimNextRun({
      workerId: "normal-worker",
      claimedAt: createdAt,
      leaseExpiresAt: new Date(createdAt.getTime() + 120_000),
    }), { kind: "idle" });
    assert.equal(await harness.database.provider_cursor_checkpoints.count(), 0);

    const recoveryScope = {
      organizationId: ids.organization,
      providerId: ids.provider,
      configurationRevisionId: ids.archiveV2,
      runId: ids.archiveRun,
      platformKey: "collector_crypt",
      mappingAdapterKey: "collector-crypt-v2",
      actorPseudonymKeyFingerprint: actorKeyFingerprint,
      archiveImporterBuildSha: importerBuildSha,
      archiveSha256: digest,
    } as const;
    const countsBeforeInvalidRecovery = {
      revisions: await harness.database.provider_config_revisions.count(),
      runs: await harness.database.import_runs.count(),
      requeues: await harness.database.audit_events.count({
        where: { action: "provider.archive_import.requeue" },
      }),
    };
    assert.deepEqual(
      await archives.preflightArchiveRecovery({
        ...recoveryScope,
        runId: "20000000-0000-4000-8000-000000000099",
      }),
      { kind: "not_found" },
    );
    assert.deepEqual(
      await archives.preflightArchiveRecovery({
        ...recoveryScope,
        archiveSha256: "f".repeat(64),
      }),
      { kind: "scope_conflict" },
    );
    assert.deepEqual(
      await archives.preflightArchiveRecovery({
        ...recoveryScope,
        configurationRevisionId: ids.httpV3,
      }),
      { kind: "scope_conflict" },
    );
    assert.deepEqual(
      await archives.preflightArchiveRecovery(recoveryScope),
      { kind: "state_conflict" },
    );
    assert.deepEqual({
      revisions: await harness.database.provider_config_revisions.count(),
      runs: await harness.database.import_runs.count(),
      requeues: await harness.database.audit_events.count({
        where: { action: "provider.archive_import.requeue" },
      }),
    }, countsBeforeInvalidRecovery);

    await harness.database.import_runs.update({
      where: { id: ids.archiveRun },
      data: {
        state: "failed",
        finished_at: createdAt,
        failure_code: "ARCHIVE_INVALID",
        failure_summary: "fixture failure",
      },
    });
    const firstPreflight = await archives.preflightArchiveRecovery(recoveryScope);
    assert.equal(firstPreflight.kind, "ready");
    if (firstPreflight.kind === "ready") assert.equal(firstPreflight.run.state, "failed");
    assert.deepEqual(await archives.requeueFailedArchiveRun({
      organizationId: ids.organization,
      providerId: ids.provider,
      runId: ids.archiveRun,
      archiveSha256: digest,
      actorKey: "operator:archive",
      requeuedAt: createdAt,
    }), { kind: "requeued" });
    assert.equal((await harness.database.import_runs.findUniqueOrThrow({
      where: { id: ids.archiveRun },
      select: { state: true },
    })).state, "queued");

    const repeatedPreflight = await archives.preflightArchiveRecovery(recoveryScope);
    assert.equal(repeatedPreflight.kind, "ready");
    if (repeatedPreflight.kind === "ready") {
      assert.equal(repeatedPreflight.run.state, "queued");
    }
    assert.deepEqual(await archives.requeueFailedArchiveRun({
      organizationId: ids.organization,
      providerId: ids.provider,
      runId: ids.archiveRun,
      archiveSha256: digest,
      actorKey: "operator:archive",
      requeuedAt: new Date(createdAt.getTime() + 1),
    }), { kind: "requeued" });
    assert.equal(await harness.database.audit_events.count({
      where: {
        action: "provider.archive_import.requeue",
        subject_id: ids.archiveRun,
      },
    }), 1);
    assert.equal(await harness.database.provider_config_revisions.count(), countsBeforeInvalidRecovery.revisions);
    assert.equal(await harness.database.import_runs.count(), countsBeforeInvalidRecovery.runs);
  } finally {
    await harness.close();
  }
});

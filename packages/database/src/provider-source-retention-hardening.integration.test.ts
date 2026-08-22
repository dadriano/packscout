import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderSourceRetentionRepository } from "./provider-source-retention-repository.ts";
import { PipelineSetupRepository } from "./setup-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

const base = new Date("2026-08-21T12:00:00.000Z");

test("retention durably records a sanitized phase failure and resumes the same execution", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const setup = new PipelineSetupRepository(harness.database);
    const organizationId = await setup.createOrganization({
      slug: "source-retention-hardening",
      name: "Source retention hardening",
      createdAt: base,
    });
    const otherOrganizationId = await setup.createOrganization({
      slug: "source-retention-hardening-other",
      name: "Other source retention hardening",
      createdAt: base,
    });
    await harness.database.$executeRawUnsafe(`
      create function packscout_test_fail_diagnostic_retention()
      returns trigger
      language plpgsql
      as $body$
      begin
        raise exception 'injected-secret-must-not-be-persisted';
      end
      $body$
    `);
    await harness.database.$executeRawUnsafe(`
      create trigger packscout_test_fail_diagnostic_retention
      before delete on public.source_processor_diagnostic_events
      for each statement
      execute function packscout_test_fail_diagnostic_retention()
    `);

    const retention = new ProviderSourceRetentionRepository(harness.database);
    await assert.rejects(
      retention.runBatch({ organizationId, batchSize: 10, now: base }),
      /Provider-source retention batch failed\./u,
    );
    const failed = await harness.database.source_retention_executions.findFirstOrThrow({
      where: { organization_id: organizationId },
    });
    assert.equal(failed.state, "failed");
    assert.equal(failed.resume_after_key, "diagnostics");
    assert.equal(failed.failure_code, "RETENTION_PHASE_FAILED");
    assert.equal(
      failed.sanitized_summary,
      "Provider-source retention phase diagnostics failed.",
    );
    assert.equal(failed.sanitized_summary?.includes("injected-secret"), false);
    assert.ok(failed.finished_at);

    await assert.rejects(
      retention.runBatch({
        organizationId: otherOrganizationId,
        batchSize: 10,
        now: new Date(base.getTime() + 1_000),
        resumeExecutionId: failed.id,
      }),
      /not found in tenant scope/u,
    );

    await harness.database.$executeRawUnsafe(`
      drop trigger packscout_test_fail_diagnostic_retention
      on public.source_processor_diagnostic_events
    `);
    await harness.database.$executeRawUnsafe(`
      drop function packscout_test_fail_diagnostic_retention()
    `);

    const resumed = await retention.runBatch({
      organizationId,
      batchSize: 10,
      now: new Date(base.getTime() + 2_000),
      resumeExecutionId: failed.id,
    });
    assert.equal(resumed.executionId, failed.id);
    const succeeded = await harness.database.source_retention_executions.findUniqueOrThrow({
      where: { id: failed.id },
    });
    assert.equal(succeeded.state, "succeeded");
    assert.equal(succeeded.resume_after_key, null);
    assert.equal(succeeded.failure_code, null);
    assert.equal(succeeded.sanitized_summary, null);
    assert.ok(succeeded.finished_at);
  } finally {
    await harness.close();
  }
});

test("retention resumes durable progress left running by an interrupted process", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const setup = new PipelineSetupRepository(harness.database);
    const organizationId = await setup.createOrganization({
      slug: "source-retention-interrupted",
      name: "Source retention interrupted",
      createdAt: base,
    });
    const interrupted = await harness.database.source_retention_executions.create({
      data: {
        organization_id: organizationId,
        batch_size: 7,
        raw_page_cutoff_at: new Date(base.getTime() - 7 * 86_400_000),
        quarantine_cutoff_at: new Date(base.getTime() - 30 * 86_400_000),
        diagnostic_cutoff_at: new Date(base.getTime() - 30 * 86_400_000),
        request_attempt_cutoff_at: new Date(base.getTime() - 30 * 86_400_000),
        resume_after_key: "quarantines",
        pages_expired_count: 2,
        diagnostics_deleted_count: 3,
        started_at: base,
      },
    });

    const retention = new ProviderSourceRetentionRepository(harness.database);
    const resumed = await retention.runBatch({
      organizationId,
      batchSize: 7,
      now: new Date(base.getTime() + 1_000),
      resumeExecutionId: interrupted.id,
    });
    assert.equal(resumed.executionId, interrupted.id);
    assert.equal(resumed.pagesExpired, 2);
    assert.equal(resumed.diagnosticsDeleted, 3);
    assert.equal((await harness.database.source_retention_executions.findUniqueOrThrow({
      where: { id: interrupted.id },
    })).state, "succeeded");
  } finally {
    await harness.close();
  }
});

test("a future caller timestamp cannot accelerate retention cutoffs", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const setup = new PipelineSetupRepository(harness.database);
    const organizationId = await setup.createOrganization({
      slug: "source-retention-database-clock",
      name: "Source retention database clock",
      createdAt: base,
    });
    const before = await harness.database.$queryRaw<Array<{ now: Date }>>`
      select clock_timestamp() as "now"
    `;
    const retention = new ProviderSourceRetentionRepository(harness.database);
    const result = await retention.runBatch({
      organizationId,
      batchSize: 10,
      now: new Date("2999-01-01T00:00:00.000Z"),
    });
    const execution = await harness.database.source_retention_executions.findUniqueOrThrow({
      where: { id: result.executionId },
    });
    const after = await harness.database.$queryRaw<Array<{ now: Date }>>`
      select clock_timestamp() as "now"
    `;
    assert.ok(execution.started_at >= before[0]!.now);
    assert.ok(execution.started_at <= after[0]!.now);
    assert.ok(execution.raw_page_cutoff_at < execution.started_at);
    assert.ok(execution.request_attempt_cutoff_at < execution.started_at);
    assert.notEqual(execution.started_at.getUTCFullYear(), 2999);
    assert.deepEqual(result, {
      executionId: result.executionId,
      pagesExpired: 0,
      quarantinesExpired: 0,
      diagnosticsDeleted: 0,
      attemptsCompacted: 0,
      attemptsDeleted: 0,
    });
  } finally {
    await harness.close();
  }
});

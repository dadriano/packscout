import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type {
  PackscoutPrismaClient,
  PackscoutTransactionClient,
} from "./database.ts";
import { PersistenceError } from "./persistence-error.ts";
import {
  ACCEPTANCE_CHECKPOINT_CODEC_VERSION,
  ACCEPTANCE_NORMALIZED_CONTRACT_VERSION,
  ACCEPTANCE_SOURCE_ADAPTER_VERSION,
  ACCEPTANCE_SOURCE_TYPE_KEY,
  activateAcceptanceRuntime,
  createAcceptanceProviderSource,
  createPinnedSourceRun,
  createProviderSourceAcceptanceFixture,
  type AcceptanceSource,
  type ProviderSourceAcceptanceFixture,
} from "./provider-source-acceptance-test-support.ts";
import { ProviderSourceCheckpointRepository } from "./provider-source-checkpoint-repository.ts";
import { ProviderSourceSupervisorRepository } from "./provider-source-supervisor-repository.ts";

const courtyardDefinition = {
  platformKey: "courtyard",
  displayName: "Courtyard",
  mapperKey: "courtyard-provider-observation",
  identityNamespaceKey: "dataforrest-courtyard-records-v1",
  intervalSeconds: 60,
  hashCharacter: "b",
} as const;

const checkpointA = new TextEncoder().encode("checkpoint-a");
const checkpointB = new TextEncoder().encode("checkpoint-b");
const fingerprintA = "4".repeat(64);
const fingerprintB = "5".repeat(64);

function copyBytes(value: Uint8Array | null): Uint8Array<ArrayBuffer> | null {
  if (value === null) return null;
  const copy = new Uint8Array(new ArrayBuffer(value.byteLength));
  copy.set(value);
  return copy;
}

async function databaseClock(database: PackscoutPrismaClient): Promise<Date> {
  const rows = await database.$queryRaw<Array<{ now: Date }>>`
    select clock_timestamp() as "now"
  `;
  return rows[0]!.now;
}

interface SupervisorProof {
  readonly epochId: string;
  readonly ownerKey: string;
  readonly leaseToken: string;
  readonly leaseExpiresAt: Date;
}

interface CheckpointCommitInput {
  readonly requestedCheckpoint: Uint8Array | null;
  readonly requestedFingerprint: string | null;
  readonly nextCheckpoint: Uint8Array;
  readonly nextFingerprint: string;
  readonly runLeaseToken: string;
  readonly committedAt: Date;
}

async function createOwnedPage(
  transaction: PackscoutTransactionClient,
  fixture: ProviderSourceAcceptanceFixture,
  source: AcceptanceSource,
  supervisor: SupervisorProof,
  input: CheckpointCommitInput,
  runId: string,
): Promise<{
  pageId: string;
  requestAttemptId: string;
}> {
  const requestAttemptId = randomUUID();
  const pageId = randomUUID();
  const requestedCheckpointKey = input.requestedFingerprint ?? "initial";
  await transaction.compact_source_request_attempts.create({
    data: {
      request_attempt_id: requestAttemptId,
      organization_id: fixture.organizationId,
      operation_kind: "page_read",
      terminal_state: "captured",
      outcome_class: "response_captured",
      safe_outcome_hash: "6".repeat(64),
      request_lease_id: randomUUID(),
      claim_owner: supervisor.ownerKey,
      claim_token: input.runLeaseToken,
      supervisor_epoch_id: supervisor.epochId,
      connection_profile_id: fixture.connectionProfileId,
      connection_revision_id: fixture.connectionRevisionId,
      expected_health_generation: 0n,
      provider_id: source.providerId,
      source_instance_id: source.sourceInstanceId,
      source_revision_id: source.sourceRevisionId,
      run_id: runId,
      page_number: 1,
      checkpoint_generation: 1n,
      requested_checkpoint_fingerprint: input.requestedFingerprint,
      requested_checkpoint_key: requestedCheckpointKey,
      started_at: input.committedAt,
      terminal_at: input.committedAt,
    },
  });
  await transaction.import_pages.create({
    data: {
      id: pageId,
      organization_id: fixture.organizationId,
      provider_id: source.providerId,
      run_id: runId,
      page_number: 1,
      payload_json: { protectedEvidenceRef: `page:${pageId}` },
      payload_hash: "7".repeat(64),
      record_counts_json: { records: 0 },
      committed_at: input.committedAt,
      expires_at: new Date(input.committedAt.getTime() + 7 * 86_400_000),
      source_instance_id: source.sourceInstanceId,
      source_revision_id: source.sourceRevisionId,
      source_type_key: ACCEPTANCE_SOURCE_TYPE_KEY,
      source_adapter_version: ACCEPTANCE_SOURCE_ADAPTER_VERSION,
      normalized_contract_version: ACCEPTANCE_NORMALIZED_CONTRACT_VERSION,
      mapper_key: source.mapperKey,
      mapper_version: "1",
      identity_namespace_key: source.identityNamespaceKey,
      connection_profile_id: fixture.connectionProfileId,
      connection_revision_id: fixture.connectionRevisionId,
      connection_health_generation: 0n,
      request_attempt_id: requestAttemptId,
      supervisor_epoch_id: supervisor.epochId,
      checkpoint_codec_version: ACCEPTANCE_CHECKPOINT_CODEC_VERSION,
      checkpoint_generation: 1n,
      requested_checkpoint: copyBytes(input.requestedCheckpoint),
      requested_checkpoint_fingerprint: input.requestedFingerprint,
      requested_checkpoint_key: requestedCheckpointKey,
      next_checkpoint: copyBytes(input.nextCheckpoint),
      next_checkpoint_fingerprint: input.nextFingerprint,
      continuation_kind: "continue",
      minimum_delay_seconds: null,
      protected_raw_response: new TextEncoder().encode("protected-page"),
      protected_raw_response_sha256: "7".repeat(64),
      normalized_commit_hash: "8".repeat(64),
    },
  });
  return { pageId, requestAttemptId };
}

async function commitCheckpoint(
  database: PackscoutPrismaClient,
  fixture: ProviderSourceAcceptanceFixture,
  source: AcceptanceSource,
  supervisor: SupervisorProof,
  input: CheckpointCommitInput,
): Promise<{ runId: string; pageId: string }> {
  const run = await createPinnedSourceRun(database, fixture, source, {
    state: "running",
    trigger: "continuation",
    createdAt: input.committedAt,
    requestedCheckpoint: input.requestedCheckpoint,
    requestedCheckpointFingerprint: input.requestedFingerprint,
    leaseOwner: supervisor.ownerKey,
    leaseToken: input.runLeaseToken,
    leaseExpiresAt: supervisor.leaseExpiresAt,
  });
  const repository = new ProviderSourceCheckpointRepository(database);
  const page = await database.$transaction(async (transaction) => {
    const ownedPage = await createOwnedPage(
      transaction,
      fixture,
      source,
      supervisor,
      input,
      run.id,
    );
    await repository.advanceInTransaction(transaction, {
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      sourceInstanceId: source.sourceInstanceId,
      sourceRevisionId: source.sourceRevisionId,
      sourceAdapterVersion: ACCEPTANCE_SOURCE_ADAPTER_VERSION,
      checkpointCodecVersion: ACCEPTANCE_CHECKPOINT_CODEC_VERSION,
      checkpointGeneration: 1n,
      expectedCheckpointFingerprint: input.requestedFingerprint,
      nextCheckpoint: input.nextCheckpoint,
      nextCheckpointFingerprint: input.nextFingerprint,
      continuation: { kind: "continue" },
      runId: run.id,
      pageId: ownedPage.pageId,
      pageNumber: 1,
      requestAttemptId: ownedPage.requestAttemptId,
      connectionProfileId: fixture.connectionProfileId,
      connectionRevisionId: fixture.connectionRevisionId,
      expectedHealthGeneration: 0n,
      supervisorEpochId: supervisor.epochId,
      supervisorOwnerKey: supervisor.ownerKey,
      supervisorLeaseToken: supervisor.leaseToken,
      runLeaseOwner: supervisor.ownerKey,
      runLeaseToken: input.runLeaseToken,
      committedAt: input.committedAt,
    });
    return ownedPage;
  });
  await database.import_runs.update({
    where: { id: run.id },
    data: { state: "succeeded", finished_at: input.committedAt },
  });
  return { runId: run.id, pageId: page.pageId };
}

test("A to B to A checkpoint cycles remain rejected after the database client restarts", async () => {
  const fixture = await createProviderSourceAcceptanceFixture(
    "checkpoint-cycle-restart",
  );
  try {
    const source = await createAcceptanceProviderSource(
      fixture,
      courtyardDefinition,
    );
    const now = await databaseClock(fixture.database);
    await activateAcceptanceRuntime(fixture.database, fixture, source, now);
    const supervisorOwner = "checkpoint-cycle-worker";
    const supervisorLeaseToken = "74000000-0000-4000-8000-000000000001";
    const supervisorRepository = new ProviderSourceSupervisorRepository(
      fixture.database,
    );
    const epoch = await supervisorRepository.acquire({
      environmentKey: "checkpoint-cycle-restart",
      ownerKey: supervisorOwner,
      leaseToken: supervisorLeaseToken,
      now,
    });
    const supervisor: SupervisorProof = {
      epochId: epoch.epochId,
      ownerKey: supervisorOwner,
      leaseToken: supervisorLeaseToken,
      leaseExpiresAt: epoch.leaseExpiresAt,
    };

    await commitCheckpoint(fixture.database, fixture, source, supervisor, {
      requestedCheckpoint: null,
      requestedFingerprint: null,
      nextCheckpoint: checkpointA,
      nextFingerprint: fingerprintA,
      runLeaseToken: "74000000-0000-4000-8000-000000000002",
      committedAt: await databaseClock(fixture.database),
    });
    await commitCheckpoint(fixture.database, fixture, source, supervisor, {
      requestedCheckpoint: checkpointA,
      requestedFingerprint: fingerprintA,
      nextCheckpoint: checkpointB,
      nextFingerprint: fingerprintB,
      runLeaseToken: "74000000-0000-4000-8000-000000000003",
      committedAt: await databaseClock(fixture.database),
    });

    await fixture.database.$disconnect();
    const reopened = await fixture.createIndependentClient();
    const renewedLeaseExpiresAt = await new ProviderSourceSupervisorRepository(
      reopened,
    ).renew({
      epochId: supervisor.epochId,
      ownerKey: supervisor.ownerKey,
      leaseToken: supervisor.leaseToken,
      now: await databaseClock(reopened),
    });
    const renewedSupervisor: SupervisorProof = {
      ...supervisor,
      leaseExpiresAt: renewedLeaseExpiresAt,
    };
    const repeatedRun = await createPinnedSourceRun(reopened, fixture, source, {
      state: "running",
      trigger: "continuation",
      createdAt: await databaseClock(reopened),
      requestedCheckpoint: checkpointB,
      requestedCheckpointFingerprint: fingerprintB,
      leaseOwner: renewedSupervisor.ownerKey,
      leaseToken: "74000000-0000-4000-8000-000000000004",
      leaseExpiresAt: renewedSupervisor.leaseExpiresAt,
    });
    const repeatedAt = await databaseClock(reopened);
    const repository = new ProviderSourceCheckpointRepository(reopened);
    await assert.rejects(
      reopened.$transaction(async (transaction) => {
        const page = await createOwnedPage(
          transaction,
          fixture,
          source,
          renewedSupervisor,
          {
            requestedCheckpoint: checkpointB,
            requestedFingerprint: fingerprintB,
            nextCheckpoint: checkpointA,
            nextFingerprint: fingerprintA,
            runLeaseToken: "74000000-0000-4000-8000-000000000004",
            committedAt: repeatedAt,
          },
          repeatedRun.id,
        );
        await repository.advanceInTransaction(transaction, {
          organizationId: fixture.organizationId,
          providerId: source.providerId,
          sourceInstanceId: source.sourceInstanceId,
          sourceRevisionId: source.sourceRevisionId,
          sourceAdapterVersion: ACCEPTANCE_SOURCE_ADAPTER_VERSION,
          checkpointCodecVersion: ACCEPTANCE_CHECKPOINT_CODEC_VERSION,
          checkpointGeneration: 1n,
          expectedCheckpointFingerprint: fingerprintB,
          nextCheckpoint: checkpointA,
          nextCheckpointFingerprint: fingerprintA,
          continuation: { kind: "continue" },
          runId: repeatedRun.id,
          pageId: page.pageId,
          pageNumber: 1,
          requestAttemptId: page.requestAttemptId,
          connectionProfileId: fixture.connectionProfileId,
          connectionRevisionId: fixture.connectionRevisionId,
          expectedHealthGeneration: 0n,
          supervisorEpochId: renewedSupervisor.epochId,
          supervisorOwnerKey: renewedSupervisor.ownerKey,
          supervisorLeaseToken: renewedSupervisor.leaseToken,
          runLeaseOwner: renewedSupervisor.ownerKey,
          runLeaseToken: "74000000-0000-4000-8000-000000000004",
          committedAt: repeatedAt,
        });
      }),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "CHECKPOINT_CYCLE_DETECTED",
    );

    const checkpoint =
      await reopened.provider_source_checkpoints.findUniqueOrThrow({
        where: { source_instance_id: source.sourceInstanceId },
      });
    assert.equal(checkpoint.checkpoint_fingerprint, fingerprintB);
    assert.deepEqual(
      (
        await reopened.provider_source_checkpoint_fingerprints.findMany({
          where: { source_instance_id: source.sourceInstanceId },
          orderBy: { committed_at: "asc" },
        })
      ).map(({ checkpoint_fingerprint: fingerprint }) => fingerprint),
      [fingerprintA, fingerprintB],
    );
    assert.equal(
      await reopened.import_pages.count({ where: { run_id: repeatedRun.id } }),
      0,
    );
  } finally {
    await fixture.close();
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderMappingAdapterRegistry } from "./provider-adapter-registry.ts";
import type {
  ProviderMappingAdapter,
  ProviderSourceIdentity,
} from "./provider-adapter.ts";
import type { ProviderActor } from "./provider-configuration-service.ts";
import type { ProviderProjectionPort } from "./provider-import-types.ts";
import {
  QuarantineService,
  QuarantineServiceError,
  type QuarantineOperationalHooks,
  type ProtectedQuarantineEvidence,
  type QuarantineClaimResult,
  type QuarantineProjectionRepository,
  type QuarantineRepository,
  type StoredQuarantineAttempt,
  type StoredQuarantineEntry,
} from "./quarantine-service.ts";

const organizationId = "10000000-0000-4000-8000-000000000001";
const otherOrganizationId = "10000000-0000-4000-8000-000000000002";
const providerId = "10000000-0000-4000-8000-000000000010";
const revisionId = "10000000-0000-4000-8000-000000000020";
const runId = "10000000-0000-4000-8000-000000000030";
const pageId = "10000000-0000-4000-8000-000000000040";
const linkedQuarantineId = "10000000-0000-4000-8000-000000000050";
const unlinkedQuarantineId = "10000000-0000-4000-8000-000000000051";
const invalidQuarantineId = "10000000-0000-4000-8000-000000000052";
const sourceRecordId = "10000000-0000-4000-8000-000000000060";
const platform = "fixture-platform";
const now = new Date("2026-08-06T12:05:00.000Z");
const sourceTimestamp = "2026-08-06T11:59:00.000Z";
const collectedAt = "2026-08-06T12:00:00.000Z";
const rawSecret = "Bearer never-render-this-secret";

const admin: ProviderActor = {
  organizationId,
  operatorId: "admin-1",
  role: "admin",
};
const operator: ProviderActor = {
  organizationId,
  operatorId: "operator-1",
  role: "data_operator",
};

function envelope(externalId: string) {
  return {
    platform,
    external_id: externalId,
    updated_at: sourceTimestamp,
    collected_at: collectedAt,
    data: {
      username: "private-user",
      wallet: "0xprivate-wallet",
      secret: rawSecret,
    },
  };
}

function source(externalId: string, recordIndex = 3): ProviderSourceIdentity {
  return {
    platform,
    recordKind: "catalog",
    recordIndex,
    externalId,
    sourceTimestamp,
    collectedAt,
  };
}

function entry(
  id: string,
  externalId: string | null,
  linkedSourceRecordId: string | null,
): StoredQuarantineEntry {
  return {
    id,
    providerId,
    configurationRevisionId: revisionId,
    platformKey: platform,
    adapterKey: "http-cursor-v1",
    runId,
    pageId,
    sourceRecordId: linkedSourceRecordId,
    recordKind: "catalog",
    recordIndex: 3,
    externalId,
    reasonCode: "ENVELOPE_VALIDATION_FAILED",
    fieldPath: "catalog[3].external_id",
    sanitizedSummary: "Provider record failed validation.",
    state: "open",
    retryCount: 0,
    createdAt: now,
    lastRetryAt: null,
    expiresAt: new Date("2026-11-04T12:05:00.000Z"),
    resolvedAt: null,
    resolutionSummary: null,
  };
}

class MemoryQuarantineRepository implements QuarantineRepository {
  readonly entries = new Map<string, StoredQuarantineEntry>();
  readonly evidence = new Map<string, ProtectedQuarantineEvidence>();
  readonly attempts = new Map<string, StoredQuarantineAttempt[]>();

  listEntries(tenant: string) {
    return Promise.resolve(
      tenant === organizationId ? [...this.entries.values()] : [],
    );
  }

  getEntry(tenant: string, quarantineId: string) {
    return Promise.resolve(
      tenant === organizationId ? this.entries.get(quarantineId) ?? null : null,
    );
  }

  listAttempts(tenant: string, quarantineId: string) {
    return Promise.resolve(
      tenant === organizationId ? this.attempts.get(quarantineId) ?? [] : [],
    );
  }

  countEntries(tenant: string) {
    const counts = { outstanding: 0, retrying: 0, resolved: 0, expired: 0 };
    if (tenant !== organizationId) return Promise.resolve(counts);
    for (const value of this.entries.values()) {
      if (value.state === "open") counts.outstanding += 1;
      else counts[value.state] += 1;
    }
    return Promise.resolve(counts);
  }

  claimRetry(input: {
    organizationId: string;
    quarantineId: string;
    attemptId: string;
    claimedAt: Date;
  }): Promise<QuarantineClaimResult> {
    if (input.organizationId !== organizationId) {
      return Promise.resolve({ kind: "not_found" });
    }
    const current = this.entries.get(input.quarantineId);
    const retained = this.evidence.get(input.quarantineId);
    if (!current) return Promise.resolve({ kind: "not_found" });
    if (current.state === "retrying") {
      return Promise.resolve({ kind: "already_retrying", entry: current });
    }
    if (current.state === "resolved") {
      return Promise.resolve({ kind: "already_resolved", entry: current });
    }
    if (current.state === "expired" || !retained) {
      const expired = { ...current, state: "expired" as const };
      this.entries.set(current.id, expired);
      return Promise.resolve({ kind: "expired", entry: expired });
    }
    const claimed = {
      ...current,
      state: "retrying" as const,
      retryCount: current.retryCount + 1,
      lastRetryAt: input.claimedAt,
    };
    this.entries.set(current.id, claimed);
    this.attempts.set(current.id, [
      ...(this.attempts.get(current.id) ?? []),
      {
        id: input.attemptId,
        state: "running",
        failureCode: null,
        fieldPath: null,
        sanitizedSummary: null,
        canonicalRevisionCount: null,
        startedAt: input.claimedAt,
        finishedAt: null,
      },
    ]);
    return Promise.resolve({
      kind: "claimed",
      attemptId: input.attemptId,
      entry: claimed,
      evidence: retained,
    });
  }

  completeRetry(input: {
    organizationId: string;
    quarantineId: string;
    attemptId: string;
    completedAt: Date;
    canonicalRevisionCount: number;
  }) {
    if (input.organizationId !== organizationId) return Promise.resolve(null);
    const current = this.entries.get(input.quarantineId);
    if (!current) return Promise.resolve(null);
    const resolved = {
      ...current,
      state: "resolved" as const,
      resolvedAt: input.completedAt,
      resolutionSummary: "Quarantine retry resolved the source record.",
    };
    this.entries.set(current.id, resolved);
    this.finishAttempt(input.quarantineId, input.attemptId, {
      state: "succeeded",
      canonicalRevisionCount: input.canonicalRevisionCount,
      finishedAt: input.completedAt,
      sanitizedSummary: "Quarantine retry resolved the source record.",
    });
    return Promise.resolve(resolved);
  }

  failRetry(input: {
    organizationId: string;
    quarantineId: string;
    attemptId: string;
    failedAt: Date;
    failureCode: string;
    fieldPath: string | null;
    sanitizedSummary: string;
  }) {
    if (input.organizationId !== organizationId) return Promise.resolve(null);
    const current = this.entries.get(input.quarantineId);
    if (!current) return Promise.resolve(null);
    const opened = { ...current, state: "open" as const };
    this.entries.set(current.id, opened);
    this.finishAttempt(input.quarantineId, input.attemptId, {
      state: "failed",
      failureCode: input.failureCode,
      fieldPath: input.fieldPath,
      sanitizedSummary: input.sanitizedSummary,
      canonicalRevisionCount: 0,
      finishedAt: input.failedAt,
    });
    return Promise.resolve(opened);
  }

  expireEvidence() {
    return Promise.resolve(0);
  }

  private finishAttempt(
    quarantineId: string,
    attemptId: string,
    update: Partial<StoredQuarantineAttempt>,
  ): void {
    this.attempts.set(
      quarantineId,
      (this.attempts.get(quarantineId) ?? []).map((attempt) =>
        attempt.id === attemptId ? { ...attempt, ...update } : attempt,
      ),
    );
  }
}

class TrackingProjectionRepository implements QuarantineProjectionRepository {
  linkedCalls = 0;
  materializedCalls = 0;

  projectSourceRecord() {
    this.linkedCalls += 1;
    return Promise.resolve({ canonicalRevisionCount: this.linkedCalls === 1 ? 1 : 0 });
  }

  materializeAndProjectSourceRecord() {
    this.materializedCalls += 1;
    return Promise.resolve({
      sourceRecordId,
      canonicalRevisionCount: this.materializedCalls === 1 ? 1 : 0,
    });
  }
}

function harness(
  projectionOverride?: ProviderProjectionPort,
  operational?: QuarantineOperationalHooks,
) {
  const repository = new MemoryQuarantineRepository();
  const projectionRepository = new TrackingProjectionRepository();
  let attempt = 0;
  const mapper: ProviderMappingAdapter = {
    key: "fixture-mapper-v1",
    platformKey: platform,
    mapPage(input) {
      assert.equal(input.configuration.adapterKey, "fixture-mapper-v1");
      const record = input.page.catalog[0]!;
      const recordSource = source(record.external_id, input.recordIndexes.catalog[0]!);
      return {
        outcomes: [{
          status: "mapped",
          source: recordSource,
          candidates: [{
            candidateKind: "catalog_asset",
            source: recordSource,
            externalId: record.external_id,
            name: "Recovered asset",
            relationships: [],
            dataQualityEvidence: [],
          }],
        }],
      };
    },
  };
  const projections: ProviderProjectionPort = projectionOverride ?? {
    project: ({ configuration, source: recordSource }) => {
      assert.equal(configuration.adapterKey, "fixture-mapper-v1");
      return ({
      status: "accepted",
      projections: [{
        platformKey: platform,
        recordKind: "catalog_asset",
        externalId: recordSource.externalId,
        content: { name: "Recovered asset" },
        sourceUpdatedAt: new Date(recordSource.sourceTimestamp),
        sourceCollectedAt: new Date(recordSource.collectedAt),
      }],
      });
    },
  };
  const service = new QuarantineService({
    repository,
    projectionRepository,
    mappings: new ProviderMappingAdapterRegistry([mapper]),
    projections,
    actorKeyer: { keyFor: ({ operatorId }) => `actor:${operatorId}` },
    clock: { now: () => new Date(now) },
    ids: { id: () => `20000000-0000-4000-8000-${String(++attempt).padStart(12, "0")}` },
    operational,
  });
  return { service, repository, projectionRepository };
}

function addEvidence(
  repository: MemoryQuarantineRepository,
  quarantineId: string,
  externalId: string,
  linked: boolean,
  rawRecord: unknown = envelope(externalId),
): void {
  repository.entries.set(
    quarantineId,
    entry(quarantineId, linked ? externalId : null, linked ? sourceRecordId : null),
  );
  repository.evidence.set(quarantineId, {
    rawRecord,
    organizationId,
    sourceRecordId: linked ? sourceRecordId : null,
    source: linked ? source(externalId) : null,
    runId,
    pageId,
    recordKind: "catalog",
    recordIndex: 3,
    expiresAt: new Date("2026-11-04T12:05:00.000Z"),
    configuration: {
      providerId,
      configurationRevisionId: revisionId,
      platform,
      adapterKey: "http-cursor-v1",
    },
  });
}

test("admin and data operator reads are browser-safe and tenant-scoped", async () => {
  const { service, repository } = harness();
  addEvidence(repository, linkedQuarantineId, "asset-safe", true);
  const listed = await service.list(operator, {});
  const detail = await service.detail(admin, linkedQuarantineId);
  assert.equal(listed.length, 1);
  assert.equal(detail.id, linkedQuarantineId);
  const rendered = JSON.stringify({ listed, detail });
  assert.equal(rendered.includes(rawSecret), false);
  assert.equal(rendered.includes("private-user"), false);
  assert.equal(rendered.includes("0xprivate-wallet"), false);

  await assert.rejects(
    service.detail({ ...admin, organizationId: otherOrganizationId }, linkedQuarantineId),
    (error: unknown) =>
      error instanceof QuarantineServiceError &&
      error.code === "QUARANTINE_NOT_FOUND",
  );
  await assert.rejects(
    service.list({ ...admin, role: "viewer" } as unknown as ProviderActor, {}),
    (error: unknown) =>
      error instanceof QuarantineServiceError && error.code === "FORBIDDEN",
  );
  await assert.rejects(
    service.retryOne(admin, "not-a-quarantine-id"),
    (error: unknown) =>
      error instanceof QuarantineServiceError &&
      error.code === "INVALID_QUARANTINE_REQUEST",
  );
});

test("linked retry resolves once and repeated retry is explicitly idempotent", async () => {
  const { service, repository, projectionRepository } = harness();
  addEvidence(repository, linkedQuarantineId, "asset-linked", true);
  const first = await service.retryOne(operator, linkedQuarantineId);
  const repeated = await service.retryOne(admin, linkedQuarantineId);
  assert.equal(first.outcome, "resolved");
  assert.equal(repeated.outcome, "already_resolved");
  assert.equal(projectionRepository.linkedCalls, 1);
  const detail = await service.detail(admin, linkedQuarantineId);
  assert.equal(detail.attempts.length, 1);
  assert.equal(detail.attempts[0]?.state, "succeeded");
  assert.equal(detail.attempts[0]?.canonicalRevisionCount, 1);
});

test("a formerly invalid unlinked envelope materializes and projects exactly once", async () => {
  const { service, repository, projectionRepository } = harness();
  addEvidence(repository, unlinkedQuarantineId, "asset-repaired", false);
  const first = await service.retryOne(admin, unlinkedQuarantineId);
  const repeated = await service.retryOne(admin, unlinkedQuarantineId);
  assert.equal(first.outcome, "resolved");
  assert.equal(repeated.outcome, "already_resolved");
  assert.equal(projectionRepository.materializedCalls, 1);
  assert.equal(projectionRepository.linkedCalls, 0);
});

test("unchanged invalid evidence records a bounded attempt and returns to open", async () => {
  const { service, repository, projectionRepository } = harness();
  addEvidence(repository, invalidQuarantineId, "ignored", false, {
    platform,
    external_id: "",
    updated_at: "not-a-time",
    collected_at: collectedAt,
    data: { secret: rawSecret },
  });
  const outcome = await service.retryOne(operator, invalidQuarantineId);
  assert.equal(outcome.outcome, "failed");
  assert.equal(outcome.entry?.state, "open");
  assert.equal(projectionRepository.materializedCalls, 0);
  const detail = await service.detail(admin, invalidQuarantineId);
  assert.equal(detail.attempts[0]?.failureCode, "ENVELOPE_VALIDATION_FAILED");
  assert.ok((detail.attempts[0]?.sanitizedSummary?.length ?? 0) <= 500);
  assert.equal(JSON.stringify(detail).includes(rawSecret), false);
});

test("an in-flight retry has one owner and a concurrent request gets a stable conflict", async () => {
  let releaseProjection!: () => void;
  let projectionStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    projectionStarted = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseProjection = resolve;
  });
  const projections: ProviderProjectionPort = {
    async project({ source: recordSource }) {
      projectionStarted();
      await release;
      return {
        status: "accepted",
        projections: [{
          platformKey: platform,
          recordKind: "catalog_asset",
          externalId: recordSource.externalId,
          content: { name: "Recovered asset" },
          sourceUpdatedAt: new Date(recordSource.sourceTimestamp),
          sourceCollectedAt: new Date(recordSource.collectedAt),
        }],
      };
    },
  };
  const { service, repository, projectionRepository } = harness(projections);
  addEvidence(repository, linkedQuarantineId, "asset-concurrent", true);
  const first = service.retryOne(admin, linkedQuarantineId);
  await started;
  const concurrent = await service.retryOne(operator, linkedQuarantineId);
  assert.equal(concurrent.outcome, "already_retrying");
  releaseProjection();
  assert.equal((await first).outcome, "resolved");
  assert.equal(projectionRepository.linkedCalls, 1);
  assert.equal((await service.detail(admin, linkedQuarantineId)).attempts.length, 1);
});

test("retry outcomes emit metrics while only a committed transition emits resolution", async () => {
  const calls: string[] = [];
  const operational: QuarantineOperationalHooks = {
    events: {
      async quarantineExpired(input) {
        calls.push(`expired:${input.quarantineId}`);
        return { status: "accepted", alertId: null, failureCode: null };
      },
      async quarantineResolved(input) {
        calls.push(`event:${input.quarantineId}`);
        return { status: "resolved", alertId: null, failureCode: null };
      },
    },
    reporter: {
      retry(input) {
        calls.push(`metric:${input.outcome}`);
      },
    },
  };
  const { service, repository } = harness(undefined, operational);
  addEvidence(repository, linkedQuarantineId, "asset-linked", true);

  assert.equal((await service.retryOne(operator, linkedQuarantineId)).outcome, "resolved");
  assert.equal((await service.retryOne(operator, linkedQuarantineId)).outcome, "already_resolved");
  assert.deepEqual(calls, [
    "metric:RESOLVED",
    `event:${linkedQuarantineId}`,
    "metric:RESOLVED",
  ]);
});

test("operational failures cannot roll back a committed quarantine resolution", async () => {
  const { service, repository } = harness(undefined, {
    events: {
      quarantineExpired: async () => {
        throw new Error("notifications unavailable");
      },
      quarantineResolved: async () => {
        throw new Error("notifications unavailable");
      },
    },
    reporter: {
      retry() {
        throw new Error("metrics unavailable");
      },
    },
  });
  addEvidence(repository, linkedQuarantineId, "asset-linked", true);

  const outcome = await service.retryOne(operator, linkedQuarantineId);
  assert.equal(outcome.outcome, "resolved");
  assert.equal(outcome.entry?.state, "resolved");
});

test("a retry that discovers expired evidence emits the expiry lifecycle event", async () => {
  const calls: string[] = [];
  const { service, repository } = harness(undefined, {
    events: {
      async quarantineExpired(input) {
        calls.push(`event:${input.reasonCode}`);
        return { status: "accepted", alertId: null, failureCode: null };
      },
      async quarantineResolved() {
        return { status: "resolved", alertId: null, failureCode: null };
      },
    },
    reporter: {
      retry(input) {
        calls.push(`metric:${input.outcome}`);
      },
    },
  });
  repository.entries.set(
    linkedQuarantineId,
    entry(linkedQuarantineId, "asset-expired", sourceRecordId),
  );

  const outcome = await service.retryOne(operator, linkedQuarantineId);
  assert.equal(outcome.outcome, "expired");
  assert.deepEqual(calls, [
    "metric:EXPIRED",
    "event:SOURCE_RETENTION_EXPIRED",
  ]);
});

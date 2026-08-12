import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DatabaseLoginAttemptLimiter,
  PrismaAuthAuditSink,
  PrismaAuthRepository,
} from "./auth-repository.ts";
import { PersistenceError } from "./persistence-error.ts";
import { PrismaProviderConfigurationRepository } from "./provider-configuration-repository.ts";
import { PipelineSetupRepository } from "./setup-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";
import { ProtectedEvidenceRepository } from "./protected-evidence.ts";

const organizationId = "00000000-0000-4000-8000-000000000101";
const otherOrganizationId = "00000000-0000-4000-8000-000000000102";
const firstOperatorId = "00000000-0000-4000-8000-000000000103";
const secondOperatorId = "00000000-0000-4000-8000-000000000104";
const firstSessionId = "00000000-0000-4000-8000-000000000105";
const secondSessionId = "00000000-0000-4000-8000-000000000106";
const rotatedSessionId = "00000000-0000-4000-8000-000000000107";
const providerId = "00000000-0000-4000-8000-000000000108";
const revisionId = "00000000-0000-4000-8000-000000000109";
const runId = "00000000-0000-4000-8000-000000000110";
const pageId = "00000000-0000-4000-8000-000000000111";
const now = new Date("2026-08-12T12:00:00.000Z");

function session(input: {
  id: string;
  operatorId: string;
  tokenHash: string;
}) {
  return {
    ...input,
    csrfHash: `csrf:${input.id}`,
    createdAt: now,
    lastSeenAt: now,
    idleExpiresAt: new Date(now.getTime() + 60_000),
    absoluteExpiresAt: new Date(now.getTime() + 120_000),
  };
}

test("identity mutations preserve tenant scope, session invalidation, and the final administrator under contention", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const setup = new PipelineSetupRepository(harness.database);
    await setup.createOrganization({
      id: organizationId,
      slug: "identity-main",
      name: "Identity Main",
    });
    await setup.createOrganization({
      id: otherOrganizationId,
      slug: "identity-other",
      name: "Identity Other",
    });
    const repository = new PrismaAuthRepository(harness.database);

    assert.equal(
      (
        await repository.provisionOperator({
          id: firstOperatorId,
          organizationId,
          emailNormalized: "first@example.test",
          displayName: "First Admin",
          passwordHash: "argon2id:first",
          role: "admin",
          state: "active",
          now,
        })
      ).kind,
      "created",
    );
    assert.equal(
      (
        await repository.provisionOperator({
          id: secondOperatorId,
          organizationId,
          emailNormalized: "second@example.test",
          displayName: "Second Admin",
          passwordHash: "argon2id:second",
          role: "admin",
          state: "active",
          now,
        })
      ).kind,
      "created",
    );
    assert.equal(
      (
        await repository.provisionOperator({
          id: "00000000-0000-4000-8000-000000000112",
          organizationId,
          emailNormalized: "first@example.test",
          displayName: "Duplicate",
          passwordHash: "argon2id:duplicate",
          role: "data_operator",
          state: "active",
          now,
        })
      ).kind,
      "email_conflict",
    );
    await assert.rejects(
      repository.provisionOperator({
        id: firstOperatorId,
        organizationId,
        emailNormalized: "id-collision@example.test",
        displayName: "ID Collision",
        passwordHash: "argon2id:id-collision",
        role: "data_operator",
        state: "active",
        now,
      }),
      /Unique constraint failed/,
    );

    assert.deepEqual(await repository.findOperatorForLogin("first@example.test"), {
      id: firstOperatorId,
      organizationId,
      organizationName: "Identity Main",
      emailNormalized: "first@example.test",
      displayName: "First Admin",
      passwordHash: "argon2id:first",
      state: "active",
      role: "admin",
    });
    await repository.rotateSession({
      previousTokenHash: null,
      session: session({
        id: firstSessionId,
        operatorId: firstOperatorId,
        tokenHash: "token:first",
      }),
    });
    await repository.rotateSession({
      previousTokenHash: "token:first",
      session: session({
        id: rotatedSessionId,
        operatorId: firstOperatorId,
        tokenHash: "token:first-rotated",
      }),
    });
    await repository.rotateSession({
      previousTokenHash: null,
      session: session({
        id: secondSessionId,
        operatorId: secondOperatorId,
        tokenHash: "token:second",
      }),
    });
    assert.equal(
      await repository.findAuthoritativeSession("token:first", now),
      null,
    );
    assert.equal(
      (await repository.findAuthoritativeSession("token:first-rotated", now))
        ?.operatorId,
      firstOperatorId,
    );
    assert.equal(
      (
        await repository.updateOperator({
          organizationId: otherOrganizationId,
          operatorId: firstOperatorId,
          state: "disabled",
          now,
        })
      ).kind,
      "not_found",
    );

    const outcomes = await Promise.all([
      repository.updateOperator({
        organizationId,
        operatorId: firstOperatorId,
        role: "data_operator",
        now: new Date(now.getTime() + 1_000),
      }),
      repository.updateOperator({
        organizationId,
        operatorId: secondOperatorId,
        role: "data_operator",
        now: new Date(now.getTime() + 1_000),
      }),
    ]);
    assert.deepEqual(
      outcomes.map(({ kind }) => kind).sort(),
      ["last_active_admin", "updated"],
    );
    assert.equal(
      await harness.database.operator_memberships.count({
        where: {
          organization_id: organizationId,
          role: "admin",
          operators: { state: "active" },
        },
      }),
      1,
    );
    const demotedOperatorId =
      outcomes[0]?.kind === "updated" ? firstOperatorId : secondOperatorId;
    const survivingOperatorId =
      demotedOperatorId === firstOperatorId ? secondOperatorId : firstOperatorId;
    const demotedToken =
      demotedOperatorId === firstOperatorId ? "token:first-rotated" : "token:second";
    const survivingToken =
      survivingOperatorId === firstOperatorId ? "token:first-rotated" : "token:second";
    assert.equal(await repository.findAuthoritativeSession(demotedToken, now), null);
    assert.equal(
      (await repository.findAuthoritativeSession(survivingToken, now))?.operatorId,
      survivingOperatorId,
    );
    assert.equal(
      (
        await repository.updateOperator({
          organizationId,
          operatorId: survivingOperatorId,
          state: "disabled",
          now: new Date(now.getTime() + 2_000),
        })
      ).kind,
      "last_active_admin",
    );

    const listed = await repository.listOperators(organizationId, {
      limit: 1,
      search: "admin",
    });
    assert.equal(listed.items.length, 1);
    assert.ok(listed.nextCursor);

    const audit = new PrismaAuthAuditSink(harness.database);
    await audit.append({
      organizationId: null,
      actorId: null,
      action: "auth.login",
      subjectId: null,
      outcome: "failure",
      occurredAt: now,
      metadata: {},
    });
    await assert.rejects(
      audit.append({
        organizationId,
        actorId: firstOperatorId,
        action: "auth.login",
        subjectId: null,
        outcome: "failure",
        occurredAt: now,
        metadata: { password: "must-not-persist" },
      }),
      (error: unknown) =>
        error instanceof PersistenceError && error.code === "UNSAFE_AUDIT_METADATA",
    );
    assert.deepEqual(
      await harness.database.audit_events.findFirst({
        where: { organization_id: null },
        select: { organization_id: true, actor_key: true },
      }),
      { organization_id: null, actor_key: "anonymous" },
    );
    assert.doesNotMatch(
      JSON.stringify(await harness.database.audit_events.findMany()),
      /must-not-persist|argon2id:|token:|csrf:/,
    );
  } finally {
    await harness.close();
  }
});

test("provider conflicts map only the organization platform identity", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const setup = new PipelineSetupRepository(harness.database);
    await setup.createOrganization({
      id: organizationId,
      slug: "provider-conflict-main",
      name: "Provider Conflict Main",
    });
    const repository = new PrismaProviderConfigurationRepository(harness.database);
    const base = {
      organizationId,
      displayName: "Provider",
      adapterKey: "http-cursor-v1",
      endpoint: "https://provider.example/feed",
      authMode: "none" as const,
      scheduleSeconds: 300,
      staleAfterSeconds: 900,
      encryptedCredential: null,
      actorKey: "actor:admin",
      now,
    };
    assert.equal(
      (
        await repository.createProvider({
          ...base,
          providerId,
          revisionId,
          platformKey: "first-platform",
        })
      ).kind,
      "created",
    );
    assert.equal(
      (
        await repository.createProvider({
          ...base,
          providerId: "00000000-0000-4000-8000-000000000113",
          revisionId: "00000000-0000-4000-8000-000000000114",
          platformKey: "first-platform",
        })
      ).kind,
      "platform_conflict",
    );
    await assert.rejects(
      repository.createProvider({
        ...base,
        providerId,
        revisionId: "00000000-0000-4000-8000-000000000115",
        platformKey: "different-platform",
      }),
      /Unique constraint failed/,
    );
    await assert.rejects(
      repository.createProvider({
        ...base,
        providerId: "00000000-0000-4000-8000-000000000116",
        revisionId,
        platformKey: "revision-id-collision",
      }),
      /Unique constraint failed/,
    );
    assert.equal(
      await harness.database.provider_sources.count({
        where: { platform_key: "revision-id-collision" },
      }),
      0,
    );
  } finally {
    await harness.close();
  }
});

test("durable login throttling serializes concurrent failures", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const clients = await Promise.all([
      harness.createIndependentClient(),
      harness.createIndependentClient(),
      harness.createIndependentClient(),
    ]);
    const limiters = [harness.database, ...clients].map(
      (client) =>
        new DatabaseLoginAttemptLimiter(client, {
          windowMs: 60_000,
          blockMs: 120_000,
          maximumFailures: 4,
        }),
    );
    const results = await Promise.all(
      limiters.map((limiter) => limiter.recordFailure(["email:fixture"], now)),
    );
    assert.equal(
      results.filter((result) => result?.getTime() === now.getTime() + 120_000)
        .length,
      1,
    );
    assert.deepEqual(
      await harness.database.auth_rate_limits.findUnique({
        where: { bucket_key: "email:fixture" },
        select: { attempt_count: true, blocked_until: true },
      }),
      {
        attempt_count: 4,
        blocked_until: new Date(now.getTime() + 120_000),
      },
    );
    assert.equal(
      (await limiters[0]!.retryAt(["email:fixture", "email:fixture"], now))
        ?.getTime(),
      now.getTime() + 120_000,
    );
    await limiters[0]!.clear(["email:fixture"]);
    assert.equal(await limiters[0]!.retryAt(["email:fixture"], now), null);
  } finally {
    await harness.close();
  }
});

test("protected raw evidence reads remain tenant-scoped and atomically audited", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const setup = new PipelineSetupRepository(harness.database);
    await setup.createOrganization({
      id: organizationId,
      slug: "evidence-main",
      name: "Evidence Main",
    });
    await setup.createOrganization({
      id: otherOrganizationId,
      slug: "evidence-other",
      name: "Evidence Other",
    });
    await setup.createProviderSource({
      id: providerId,
      organizationId,
      platformKey: "evidence",
      displayName: "Evidence",
      createdAt: now,
    });
    await setup.createConfigRevision({
      id: revisionId,
      organizationId,
      providerId,
      version: 1,
      adapterKey: "http-cursor-v1",
      endpointUrl: "https://provider.example/feed",
      authMode: "none",
      createdByActorKey: "actor:setup",
      createdAt: now,
    });
    await setup.createImportRun({
      id: runId,
      organizationId,
      providerId,
      configRevisionId: revisionId,
      trigger: "manual",
      requestedByActorKey: "actor:import",
      state: "succeeded",
      createdAt: now,
    });
    await harness.database.import_pages.create({
      data: {
        id: pageId,
        organization_id: organizationId,
        provider_id: providerId,
        run_id: runId,
        page_number: 1,
        has_more: false,
        payload_json: { catalog: [], pulls: [], sales: [] },
        payload_hash: "payload-hash",
        record_counts_json: { catalog: 0, pulls: 0, sales: 0 },
        committed_at: now,
        expires_at: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1_000),
      },
    });
    const repository = new ProtectedEvidenceRepository(harness.database);
    assert.equal(
      await repository.getRawPage(
        {
          organizationId: otherOrganizationId,
          actorKey: "actor:other",
          purpose: "provider_debug",
        },
        pageId,
        now,
      ),
      null,
    );
    assert.equal(await harness.database.audit_events.count(), 0);

    const page = await repository.getRawPage(
      {
        organizationId,
        actorKey: "actor:reviewer",
        purpose: "quarantine_review",
      },
      pageId,
      now,
    );
    assert.equal(page?.pageId, pageId);
    assert.deepEqual(page?.payload, { catalog: [], pulls: [], sales: [] });
    assert.deepEqual(
      await harness.database.audit_events.findFirst({
        select: {
          organization_id: true,
          actor_key: true,
          action: true,
          subject_id: true,
          metadata_json: true,
        },
      }),
      {
        organization_id: organizationId,
        actor_key: "actor:reviewer",
        action: "raw_evidence.read",
        subject_id: pageId,
        metadata_json: { purpose: "quarantine_review" },
      },
    );
  } finally {
    await harness.close();
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FIRST_ADMIN_BOOTSTRAP_ACTOR_KEY,
  PrismaFirstAdminBootstrapRepository,
} from "./first-admin-bootstrap-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

const expectedOrganization = Object.freeze({
  id: "00000000-0000-4000-8000-000000000001",
  slug: "packscout-local",
  name: "PackScout Local Development",
});
const expectedProviderRoots = Object.freeze([
  Object.freeze({
    id: "00000000-0000-4000-8000-000000000011",
    platformKey: "beezie",
    displayName: "Beezie (local development)",
    state: "draft" as const,
  }),
  Object.freeze({
    id: "00000000-0000-4000-8000-000000000013",
    platformKey: "gamestop",
    displayName: "GameStop (local development)",
    state: "draft" as const,
  }),
  Object.freeze({
    id: "9c2ef352-161a-4e5f-9d7d-6ff46755a104",
    platformKey: "clutchpacks",
    displayName: "ClutchPacks",
    state: "active" as const,
  }),
  Object.freeze({
    id: "9c2ef352-161a-4e5f-9d7d-6ff46755a102",
    platformKey: "collector_crypt",
    displayName: "Collector Crypt",
    state: "active" as const,
  }),
  Object.freeze({
    id: "9c2ef352-161a-4e5f-9d7d-6ff46755a101",
    platformKey: "courtyard",
    displayName: "Courtyard",
    state: "active" as const,
  }),
  Object.freeze({
    id: "9c2ef352-161a-4e5f-9d7d-6ff46755a103",
    platformKey: "phygitals",
    displayName: "Phygitals",
    state: "active" as const,
  }),
]);
const now = new Date("2026-08-26T12:00:00.000Z");

async function seedExpectedOrganization(
  client: Awaited<ReturnType<typeof createMigratedTestDatabase>>["client"],
): Promise<void> {
  await client.organizations.create({ data: expectedOrganization });
  await client.provider_sources.createMany({
    data: expectedProviderRoots.map((provider) => ({
      id: provider.id,
      organization_id: expectedOrganization.id,
      platform_key: provider.platformKey,
      display_name: provider.displayName,
      state: provider.state,
    })),
  });
}

function bootstrapInput(
  operatorId = "00000000-0000-4000-8000-000000000002",
) {
  return {
    expectedOrganization,
    expectedProviderRoots,
    operatorId,
    emailNormalized: "admin@packscout.test",
    displayName: "Primary Admin",
    passwordHash: "$argon2id$test-only-hash",
    now,
  } as const;
}

test("first-admin bootstrap atomically creates one active admin membership and safe audit", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await seedExpectedOrganization(harness.client);
    const repository = new PrismaFirstAdminBootstrapRepository(
      harness.database,
    );

    assert.deepEqual(await repository.bootstrap(bootstrapInput()), {
      kind: "created",
      organizationId: expectedOrganization.id,
      operatorId: bootstrapInput().operatorId,
    });
    const membership = await harness.client.operator_memberships.findUniqueOrThrow({
      where: {
        organization_id_operator_id: {
          organization_id: expectedOrganization.id,
          operator_id: bootstrapInput().operatorId,
        },
      },
      include: { operators: true },
    });
    assert.equal(membership.role, "admin");
    assert.equal(membership.operators.state, "active");
    assert.equal(
      membership.operators.password_hash,
      bootstrapInput().passwordHash,
    );

    const audit = await harness.client.audit_events.findFirstOrThrow();
    assert.equal(audit.actor_key, FIRST_ADMIN_BOOTSTRAP_ACTOR_KEY);
    assert.equal(audit.action, "operator.provision");
    assert.equal(audit.subject_type, "operator");
    assert.equal(audit.subject_id, bootstrapInput().operatorId);
    assert.equal(audit.outcome, "success");
    assert.deepEqual(audit.metadata_json, {
      reason: "first_admin",
      role: "admin",
    });
    assert.doesNotMatch(
      JSON.stringify(audit),
      /admin@packscout\.test|argon2id|test-only-hash/u,
    );

    assert.deepEqual(
      await repository.bootstrap({
        ...bootstrapInput("00000000-0000-4000-8000-000000000003"),
        emailNormalized: "second@packscout.test",
      }),
      { kind: "operator_already_present" },
    );
    assert.equal(await harness.client.operators.count(), 1);
    assert.equal(await harness.client.operator_memberships.count(), 1);
    assert.equal(await harness.client.audit_events.count(), 1);
  } finally {
    await harness.close();
  }
});

test("first-admin bootstrap refuses a database that is not the exact normal development seed", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await seedExpectedOrganization(harness.client);
    await harness.client.organizations.create({
      data: {
        id: "00000000-0000-4000-8000-000000000099",
        slug: "unexpected",
        name: "Unexpected",
      },
    });
    const repository = new PrismaFirstAdminBootstrapRepository(
      harness.database,
    );

    assert.deepEqual(await repository.bootstrap(bootstrapInput()), {
      kind: "development_seed_not_exact",
    });
    assert.equal(await harness.client.operators.count(), 0);
    assert.equal(await harness.client.operator_memberships.count(), 0);
    assert.equal(await harness.client.audit_events.count(), 0);
  } finally {
    await harness.close();
  }
});

test("first-admin bootstrap rejects altered provider roots and any material history", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await seedExpectedOrganization(harness.client);
    const repository = new PrismaFirstAdminBootstrapRepository(
      harness.database,
    );
    await harness.client.provider_sources.update({
      where: { id: expectedProviderRoots[0].id },
      data: { display_name: "Altered" },
    });
    assert.deepEqual(await repository.bootstrap(bootstrapInput()), {
      kind: "development_seed_not_exact",
    });
    await harness.client.provider_sources.update({
      where: { id: expectedProviderRoots[0].id },
      data: { display_name: expectedProviderRoots[0].displayName },
    });
    await harness.client.audit_events.create({
      data: {
        organization_id: expectedOrganization.id,
        actor_key: "historical-actor",
        action: "historical.action",
        subject_type: "organization",
        subject_id: expectedOrganization.id,
        outcome: "success",
        metadata_json: {},
        occurred_at: now,
      },
    });
    assert.deepEqual(await repository.bootstrap(bootstrapInput()), {
      kind: "development_seed_not_exact",
    });
    assert.equal(await harness.client.operators.count(), 0);
    assert.equal(await harness.client.operator_memberships.count(), 0);
    assert.equal(await harness.client.audit_events.count(), 1);
  } finally {
    await harness.close();
  }
});

test("concurrent first-admin bootstrap attempts serialize to exactly one account", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await seedExpectedOrganization(harness.client);
    const independent = await harness.createIndependentClient();
    const attempts = await Promise.all([
      new PrismaFirstAdminBootstrapRepository(harness.database).bootstrap(
        bootstrapInput("00000000-0000-4000-8000-000000000010"),
      ),
      new PrismaFirstAdminBootstrapRepository(independent).bootstrap({
        ...bootstrapInput("00000000-0000-4000-8000-000000000011"),
        emailNormalized: "other@packscout.test",
      }),
    ]);

    assert.deepEqual(
      attempts.map(({ kind }) => kind).sort(),
      ["created", "operator_already_present"],
    );
    assert.equal(await harness.client.operators.count(), 1);
    assert.equal(await harness.client.operator_memberships.count(), 1);
    assert.equal(await harness.client.audit_events.count(), 1);
  } finally {
    await harness.close();
  }
});

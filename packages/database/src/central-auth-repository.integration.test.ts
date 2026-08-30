import assert from "node:assert/strict";
import test from "node:test";
import { CentralAuthRepository } from "./central-auth-repository.ts";
import { createMigratedCentralTestDatabase } from "./test-support.ts";

const organizationId = "30000000-0000-4000-8000-000000000001";
const operatorId = "30000000-0000-4000-8000-000000000002";
const sessionId = "30000000-0000-4000-8000-000000000003";
const now = new Date("2026-08-29T12:00:00.000Z");

test("central auth owns login, session, and row-versioned operator updates", async () => {
  const harness = await createMigratedCentralTestDatabase();
  try {
    await harness.database.organizations.create({
      data: {
        id: organizationId,
        slug: "central-auth-test",
        name: "Central Auth Test",
        created_at: now,
      },
    });
    await harness.database.operators.create({
      data: {
        id: operatorId,
        email_normalized: "admin@example.com",
        display_name: "Initial Admin",
        password_hash: "stored-password-hash",
        state: "active",
        created_at: now,
        updated_at: now,
      },
    });
    await harness.database.operator_memberships.create({
      data: {
        organization_id: organizationId,
        operator_id: operatorId,
        role: "admin",
        created_at: now,
        updated_at: now,
      },
    });
    const repository = new CentralAuthRepository(harness.database);

    assert.deepEqual(
      await repository.findOperatorForLogin("admin@example.com"),
      {
        id: operatorId,
        organizationId,
        organizationName: "Central Auth Test",
        emailNormalized: "admin@example.com",
        displayName: "Initial Admin",
        passwordHash: "stored-password-hash",
        state: "active",
        role: "admin",
      },
    );

    await repository.rotateSession({
      previousTokenHash: null,
      session: {
        id: sessionId,
        operatorId,
        tokenHash: "session-token-hash",
        csrfHash: "csrf-token-hash",
        createdAt: now,
        lastSeenAt: now,
        idleExpiresAt: new Date(now.getTime() + 60_000),
        absoluteExpiresAt: new Date(now.getTime() + 120_000),
      },
    });
    const session = await repository.findAuthoritativeSession(
      "session-token-hash",
      new Date(now.getTime() + 1_000),
    );
    assert.equal(session?.operatorId, operatorId);
    assert.equal(session?.organizationId, organizationId);

    const updated = await repository.updateOperator({
      organizationId,
      operatorId,
      displayName: "Updated Admin",
      now,
    });
    assert.equal(updated.kind, "updated");
    if (updated.kind === "updated") {
      assert.equal(updated.operator.displayName, "Updated Admin");
      assert.ok(new Date(updated.operator.updatedAt) > now);
    }
    const persisted = await harness.database.operators.findUniqueOrThrow({
      where: { id: operatorId },
      select: { row_version: true, updated_at: true },
    });
    assert.equal(persisted.row_version, 2n);
    assert.ok(persisted.updated_at > now);

    assert.deepEqual(
      await repository.updateOperator({
        organizationId,
        operatorId,
        role: "data_operator",
        now,
      }),
      { kind: "last_active_admin" },
    );
  } finally {
    await harness.close();
  }
});

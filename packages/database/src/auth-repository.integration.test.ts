import assert from "node:assert/strict";
import { test } from "node:test";
import { PrismaAuthRepository } from "./auth-repository.ts";
import type { PackscoutPrismaClient } from "./database.ts";
import { PrismaEmailLinkTokenRepository } from "./email-link-token-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

/**
 * The invited-account lifecycle at the data edge: an account created by
 * invitation holds no credential at all, only the guarded activation
 * transition can leave `pending`, and ordinary updates refuse to touch it —
 * which is what keeps a password reset or an administrator's edit from
 * turning an unredeemed invitation into a usable account.
 */

const now = new Date("2026-08-24T12:00:00.000Z");
const organizationId = "00000000-0000-4000-8000-0000000000c1";
const invitedId = "00000000-0000-4000-8000-0000000000c2";
const adminId = "00000000-0000-4000-8000-0000000000c3";

async function seed(client: PackscoutPrismaClient) {
  await client.organizations.create({
    data: { id: organizationId, slug: "packscout", name: "PackScout" },
  });
  const repository = new PrismaAuthRepository(client);
  // An administrator who already works, so the last-active-admin guard never
  // masks what these assertions are about.
  await repository.provisionOperator({
    id: adminId,
    organizationId,
    emailNormalized: "admin@packscout.test",
    displayName: "Primary Admin",
    passwordHash: "argon2id$stored$admin",
    role: "admin",
    state: "active",
    now,
  });
  return repository;
}

test("an invited account is created without a credential and can be activated exactly once", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const repository = await seed(harness.client);
    const created = await repository.provisionOperator({
      id: invitedId,
      organizationId,
      emailNormalized: "invited@packscout.test",
      displayName: "Invited Operator",
      passwordHash: null,
      role: "data_operator",
      state: "pending",
      now,
    });
    assert.equal(created.kind, "created");
    assert.equal(
      created.kind === "created" ? created.operator.state : null,
      "pending",
    );
    const stored = await harness.client.operators.findUniqueOrThrow({
      where: { id: invitedId },
      select: { password_hash: true, state: true },
    });
    assert.equal(stored.password_hash, null);
    assert.equal(stored.state, "pending");

    // Login reads carry the absent credential honestly rather than a
    // placeholder that could be mistaken for a real hash.
    const loginRecord = await repository.findOperatorForLogin(
      "invited@packscout.test",
    );
    assert.equal(loginRecord?.passwordHash, null);
    assert.equal(loginRecord?.state, "pending");

    const activated = await repository.activateInvitedOperator({
      organizationId,
      operatorId: invitedId,
      passwordHash: "argon2id$stored$chosen",
      now,
    });
    assert.equal(activated.kind, "activated");
    assert.equal(
      activated.kind === "activated" ? activated.operator.state : null,
      "active",
    );

    // A second redemption of the same invitation finds nothing pending.
    const again = await repository.activateInvitedOperator({
      organizationId,
      operatorId: invitedId,
      passwordHash: "argon2id$stored$second",
      now,
    });
    assert.equal(again.kind, "not_pending");
    const afterwards = await harness.client.operators.findUniqueOrThrow({
      where: { id: invitedId },
      select: { password_hash: true },
    });
    assert.equal(afterwards.password_hash, "argon2id$stored$chosen");
  } finally {
    await harness.close();
  }
});

test("ordinary updates refuse an invited or cancelled account, and cancellation is terminal", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const repository = await seed(harness.client);
    await repository.provisionOperator({
      id: invitedId,
      organizationId,
      emailNormalized: "invited@packscout.test",
      displayName: "Invited Operator",
      passwordHash: null,
      role: "data_operator",
      state: "pending",
      now,
    });

    // The same repository call a password reset and an administrator's
    // credential rotation both take.
    for (const change of [
      { passwordHash: "argon2id$stored$forced" },
      { state: "active" as const },
      { role: "admin" as const },
      { displayName: "Renamed" },
    ]) {
      const refused = await repository.updateOperator({
        organizationId,
        operatorId: invitedId,
        now,
        ...change,
      });
      assert.equal(refused.kind, "not_activated");
    }
    const untouched = await harness.client.operators.findUniqueOrThrow({
      where: { id: invitedId },
      select: { password_hash: true, state: true, display_name: true },
    });
    assert.deepEqual(untouched, {
      password_hash: null,
      state: "pending",
      display_name: "Invited Operator",
    });

    const cancelled = await repository.cancelInvitedOperator({
      organizationId,
      operatorId: invitedId,
      now,
    });
    assert.equal(cancelled.kind, "cancelled");
    assert.equal(
      cancelled.kind === "cancelled" ? cancelled.operator.state : null,
      "cancelled",
    );

    // Cancelling twice, and cancelling an account that already works, are
    // both refused — cancellation is only ever a withdrawal of an invitation.
    assert.equal(
      (
        await repository.cancelInvitedOperator({
          organizationId,
          operatorId: invitedId,
          now,
        })
      ).kind,
      "not_pending",
    );
    assert.equal(
      (
        await repository.cancelInvitedOperator({
          organizationId,
          operatorId: adminId,
          now,
        })
      ).kind,
      "not_pending",
    );
    // And a cancelled account can never be activated back into usability.
    assert.equal(
      (
        await repository.activateInvitedOperator({
          organizationId,
          operatorId: invitedId,
          passwordHash: "argon2id$stored$revived",
          now,
        })
      ).kind,
      "not_pending",
    );
  } finally {
    await harness.close();
  }
});

test("the database refuses an active account without a credential", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await seed(harness.client);
    await assert.rejects(
      harness.client.operators.create({
        data: {
          id: "00000000-0000-4000-8000-0000000000c9",
          email_normalized: "credential-less@packscout.test",
          display_name: "Impossible",
          password_hash: null,
          state: "active",
          created_at: now,
          updated_at: now,
        },
      }),
      /operators_active_requires_credential/,
    );
  } finally {
    await harness.close();
  }
});

test("outstanding invitations are readable for many accounts in one query", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const tokens = new PrismaEmailLinkTokenRepository(harness.client);
    const first = "00000000-0000-4000-8000-0000000000d1";
    const second = "00000000-0000-4000-8000-0000000000d2";
    const settled = "00000000-0000-4000-8000-0000000000d3";
    let counter = 0;
    const issue = async (subjectId: string, issuedAt: Date) => {
      counter += 1;
      return tokens.issue({
        id: `00000000-0000-4000-8000-8${String(counter).padStart(11, "0")}`,
        purpose: "operator_invitation",
        subjectId,
        addressNormalized: `invited-${counter}@packscout.test`,
        selector: String(counter).padStart(22, "A"),
        verifierHash: String(counter).padStart(43, "A"),
        issuedAt,
        expiresAt: new Date(issuedAt.getTime() + 7 * 24 * 60 * 60_000),
      });
    };
    await issue(first, now);
    // A reissue supersedes the earlier link, so only the newest is reported.
    await issue(first, new Date(now.getTime() + 60_000));
    await issue(second, now);
    await issue(settled, now);
    await tokens.supersedeOutstanding({
      purpose: "operator_invitation",
      subjectId: settled,
      now,
    });

    const outstanding = await tokens.findOutstandingForSubjects({
      purpose: "operator_invitation",
      subjectIds: [first, second, settled],
    });
    assert.deepEqual([...outstanding.keys()].sort(), [first, second].sort());
    assert.equal(
      outstanding.get(first)?.issuedAt.toISOString(),
      new Date(now.getTime() + 60_000).toISOString(),
    );
    // Never token material: only identity, address, and timestamps.
    assert.deepEqual(Object.keys(outstanding.get(second)!).sort(), [
      "addressNormalized",
      "expiresAt",
      "issuedAt",
      "tokenId",
    ]);
    assert.equal(
      (
        await tokens.findOutstandingForSubjects({
          purpose: "operator_invitation",
          subjectIds: [],
        })
      ).size,
      0,
    );
  } finally {
    await harness.close();
  }
});

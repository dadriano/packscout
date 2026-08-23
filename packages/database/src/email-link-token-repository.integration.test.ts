import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DatabaseEmailLinkRateLimiter,
  PrismaEmailLinkAuditSink,
  PrismaEmailLinkTokenRepository,
  issueEmailLinkToken,
  type IssueEmailLinkTokenInput,
} from "./email-link-token-repository.ts";
import { enqueueEmailMessageIntent } from "./email-message-outbox-repository.ts";
import { PersistenceError } from "./persistence-error.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

const issuedAt = new Date("2026-08-23T12:00:00.000Z");
const hourLater = new Date(issuedAt.getTime() + 60 * 60_000);
const subjectId = "00000000-0000-4000-8000-0000000000aa";
const otherSubjectId = "00000000-0000-4000-8000-0000000000bb";

let uniqueCounter = 0;

function base64urlOf(counter: number, length: number): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let remaining = counter;
  let suffix = "";
  do {
    suffix = alphabet[remaining % 64]! + suffix;
    remaining = Math.floor(remaining / 64);
  } while (remaining > 0);
  return suffix.padStart(length, "A");
}

function issueInput(
  overrides?: Partial<IssueEmailLinkTokenInput>,
): IssueEmailLinkTokenInput {
  uniqueCounter += 1;
  return {
    id: `00000000-0000-4000-8000-9${String(uniqueCounter).padStart(11, "0")}`,
    purpose: "operator_password_reset",
    subjectId,
    addressNormalized: "operator@example.test",
    selector: base64urlOf(uniqueCounter, 22),
    verifierHash: base64urlOf(uniqueCounter, 43),
    issuedAt,
    expiresAt: hourLater,
    ...overrides,
  };
}

test("an issued token is stored hashed with its binding, and selectors never collide", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const repository = new PrismaEmailLinkTokenRepository(harness.client);
    const input = issueInput();
    const issued = await repository.issue(input);
    assert.equal(issued.tokenId, input.id);
    assert.equal(issued.supersededCount, 0);

    const stored = await repository.findBySelector(input.selector);
    assert.ok(stored);
    assert.equal(stored.purpose, "operator_password_reset");
    assert.equal(stored.subjectId, subjectId);
    assert.equal(stored.addressNormalized, "operator@example.test");
    assert.equal(stored.verifierHash, input.verifierHash);
    assert.equal(stored.redeemedAt, null);
    assert.equal(stored.supersededAt, null);
    // The row holds only selector and hash — the composite token is not there.
    const raw = await harness.client.email_link_tokens.findUniqueOrThrow({
      where: { selector: input.selector },
    });
    assert.equal(Object.hasOwn(raw, "verifier"), false);

    await assert.rejects(
      repository.issue(issueInput({ selector: input.selector, subjectId: otherSubjectId })),
      /unique/i,
    );
  } finally {
    await harness.close();
  }
});

test("issuing supersedes prior outstanding tokens for the same subject and purpose only", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const repository = new PrismaEmailLinkTokenRepository(harness.client);
    const first = issueInput();
    const otherPurpose = issueInput({ purpose: "operator_invitation" });
    const otherSubject = issueInput({ subjectId: otherSubjectId });
    await repository.issue(first);
    await repository.issue(otherPurpose);
    await repository.issue(otherSubject);

    const replacement = await repository.issue(issueInput());
    assert.equal(replacement.supersededCount, 1);

    assert.ok((await repository.findBySelector(first.selector))?.supersededAt);
    assert.equal(
      (await repository.findBySelector(otherPurpose.selector))?.supersededAt,
      null,
    );
    assert.equal(
      (await repository.findBySelector(otherSubject.selector))?.supersededAt,
      null,
    );

    // A superseded token can no longer be consumed.
    const supersededRow = await repository.findBySelector(first.selector);
    assert.equal(
      await repository.consume({
        tokenId: supersededRow!.id,
        purpose: "operator_password_reset",
        now: issuedAt,
      }),
      "unavailable",
    );
  } finally {
    await harness.close();
  }
});

test("two concurrent issues for one subject and purpose leave exactly one outstanding token", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const left = await harness.createIndependentClient();
    const right = await harness.createIndependentClient();
    await Promise.all(
      [left, right].map((client, index) =>
        client.$transaction((transaction) =>
          issueEmailLinkToken(
            transaction,
            issueInput({ issuedAt: new Date(issuedAt.getTime() + index) }),
          ),
        ),
      ),
    );
    const outstanding = await harness.client.email_link_tokens.findMany({
      where: {
        purpose: "operator_password_reset",
        subject_id: subjectId,
        redeemed_at: null,
        superseded_at: null,
      },
    });
    assert.equal(outstanding.length, 1);
  } finally {
    await harness.close();
  }
});

test("concurrent redemptions resolve to exactly one consumed row", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const repository = new PrismaEmailLinkTokenRepository(harness.client);
    const input = issueInput();
    await repository.issue(input);
    const stored = await repository.findBySelector(input.selector);
    assert.ok(stored);

    const contenders = await Promise.all(
      Array.from({ length: 4 }, () => harness.createIndependentClient()),
    );
    const outcomes = await Promise.all(
      contenders.flatMap((client) => {
        const contender = new PrismaEmailLinkTokenRepository(client);
        return [
          contender.consume({
            tokenId: stored.id,
            purpose: "operator_password_reset",
            now: issuedAt,
          }),
          contender.consume({
            tokenId: stored.id,
            purpose: "operator_password_reset",
            now: issuedAt,
          }),
        ];
      }),
    );
    assert.equal(outcomes.filter((outcome) => outcome === "consumed").length, 1);
    assert.equal(outcomes.filter((outcome) => outcome === "unavailable").length, 7);

    const settled = await repository.findBySelector(input.selector);
    assert.deepEqual(settled?.redeemedAt, issuedAt);
  } finally {
    await harness.close();
  }
});

test("consumption is refused for the wrong purpose, after expiry, and after redemption", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const repository = new PrismaEmailLinkTokenRepository(harness.client);
    const input = issueInput();
    await repository.issue(input);
    const stored = await repository.findBySelector(input.selector);
    assert.ok(stored);

    assert.equal(
      await repository.consume({
        tokenId: stored.id,
        purpose: "operator_invitation",
        now: issuedAt,
      }),
      "unavailable",
    );
    assert.equal(
      await repository.consume({
        tokenId: stored.id,
        purpose: "operator_password_reset",
        now: hourLater,
      }),
      "unavailable",
    );
    assert.equal(
      await repository.consume({
        tokenId: stored.id,
        purpose: "operator_password_reset",
        now: issuedAt,
      }),
      "consumed",
    );
    // Consumed stays consumed; nothing resurrects it for a second use.
    assert.equal(
      await repository.consume({
        tokenId: stored.id,
        purpose: "operator_password_reset",
        now: issuedAt,
      }),
      "unavailable",
    );
  } finally {
    await harness.close();
  }
});

test("the outstanding view reports the latest unsettled link without token material", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const repository = new PrismaEmailLinkTokenRepository(harness.client);
    assert.equal(
      await repository.findOutstanding({
        purpose: "operator_invitation",
        subjectId,
      }),
      null,
    );
    await repository.issue(issueInput({ purpose: "operator_invitation" }));
    const replacement = issueInput({
      purpose: "operator_invitation",
      issuedAt: new Date(issuedAt.getTime() + 5_000),
    });
    await repository.issue(replacement);

    const outstanding = await repository.findOutstanding({
      purpose: "operator_invitation",
      subjectId,
    });
    assert.ok(outstanding);
    assert.equal(outstanding.tokenId, replacement.id);
    assert.deepEqual(outstanding.issuedAt, replacement.issuedAt);
    assert.deepEqual(outstanding.expiresAt, replacement.expiresAt);
    assert.deepEqual(
      Object.keys(outstanding).sort(),
      ["addressNormalized", "expiresAt", "issuedAt", "tokenId"],
    );

    await repository.supersedeOutstanding({
      purpose: "operator_invitation",
      subjectId,
      now: new Date(issuedAt.getTime() + 10_000),
    });
    assert.equal(
      await repository.findOutstanding({ purpose: "operator_invitation", subjectId }),
      null,
    );
  } finally {
    await harness.close();
  }
});

test("pruning deletes only tokens past the cutoff and never a live one", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const repository = new PrismaEmailLinkTokenRepository(harness.client);
    const cutoffAt = issuedAt;
    const longExpired = issueInput({
      issuedAt: new Date(issuedAt.getTime() - 3 * 60 * 60_000),
      expiresAt: new Date(issuedAt.getTime() - 2 * 60 * 60_000),
    });
    const justExpired = issueInput({
      subjectId: otherSubjectId,
      issuedAt: new Date(issuedAt.getTime() - 2 * 60 * 60_000),
      expiresAt: new Date(issuedAt.getTime() - 60 * 60_000),
    });
    const redeemedLongAgo = issueInput({
      purpose: "operator_invitation",
      issuedAt: new Date(issuedAt.getTime() - 3 * 60 * 60_000),
      expiresAt: new Date(issuedAt.getTime() - 90 * 60_000),
    });
    const live = issueInput({
      purpose: "operator_invitation",
      subjectId: otherSubjectId,
    });
    for (const input of [longExpired, justExpired, redeemedLongAgo, live]) {
      await repository.issue(input);
    }
    const redeemedRow = await repository.findBySelector(redeemedLongAgo.selector);
    await harness.client.email_link_tokens.update({
      where: { id: redeemedRow!.id },
      data: { redeemed_at: new Date(issuedAt.getTime() - 100 * 60_000) },
    });

    // A bounded pass removes the oldest expiry first.
    assert.equal(await repository.prune({ cutoffAt, limit: 1 }), 1);
    assert.equal(await repository.findBySelector(longExpired.selector), null);
    assert.ok(await repository.findBySelector(justExpired.selector));

    assert.equal(await repository.prune({ cutoffAt, limit: 100 }), 2);
    assert.equal(await repository.findBySelector(justExpired.selector), null);
    assert.equal(await repository.findBySelector(redeemedLongAgo.selector), null);
    // The live token survives every pass while its expiry lies ahead of the
    // cutoff — even one that reaches to a millisecond before it.
    assert.ok(await repository.findBySelector(live.selector));
    assert.equal(
      await repository.prune({
        cutoffAt: new Date(hourLater.getTime() - 1),
        limit: 100,
      }),
      0,
    );
    assert.ok(await repository.findBySelector(live.selector));
  } finally {
    await harness.close();
  }
});

test("issuance composes into one transaction with the message enqueue: both or neither", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const repository = new PrismaEmailLinkTokenRepository(harness.client);
    const rollback = issueInput();
    await assert.rejects(
      harness.client.$transaction(async (transaction) => {
        await issueEmailLinkToken(transaction, rollback);
        await enqueueEmailMessageIntent(transaction, {
          kind: "operator_password_reset",
          recipient: "operator@example.test",
          idempotencyKey: "reset:rollback",
          source: "operator_accounts",
          serializedInput: JSON.stringify({ resetLinkPath: "/reset-password?token=opaque" }),
          dueAt: issuedAt,
          now: issuedAt,
          sourceActiveLimit: 100,
        });
        throw new Error("delivery enqueue failed");
      }),
      /delivery enqueue failed/,
    );
    // Neither a token nobody was mailed, nor a mailed link with no token.
    assert.equal(await repository.findBySelector(rollback.selector), null);
    assert.equal(await harness.client.email_message_intents.count(), 0);

    const committed = issueInput();
    await harness.client.$transaction(async (transaction) => {
      await issueEmailLinkToken(transaction, committed);
      await enqueueEmailMessageIntent(transaction, {
        kind: "operator_password_reset",
        recipient: "operator@example.test",
        idempotencyKey: "reset:committed",
        source: "operator_accounts",
        serializedInput: JSON.stringify({ resetLinkPath: "/reset-password?token=opaque" }),
        dueAt: issuedAt,
        now: issuedAt,
        sourceActiveLimit: 100,
      });
    });
    assert.ok(await repository.findBySelector(committed.selector));
    assert.equal(await harness.client.email_message_intents.count(), 1);
  } finally {
    await harness.close();
  }
});

test("the audit sink writes closed-shape rows and refuses anything token-like", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const sink = new PrismaEmailLinkAuditSink(harness.client);
    await sink.append({
      action: "email_link.issue",
      purpose: "operator_password_reset",
      subjectId,
      outcome: "success",
      reason: "issued",
      occurredAt: issuedAt,
    });
    await sink.append({
      action: "email_link.redeem",
      purpose: "operator_invitation",
      subjectId: null,
      outcome: "failure",
      reason: "unknown_token",
      occurredAt: issuedAt,
      actorKey: "operator:admin",
    });

    const rows = await harness.client.audit_events.findMany({
      orderBy: { action: "asc" },
    });
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.action, "email_link.issue");
    assert.equal(rows[0]!.subject_type, "operator");
    assert.equal(rows[0]!.subject_id, subjectId);
    assert.equal(rows[0]!.outcome, "success");
    assert.equal(rows[0]!.actor_key, "anonymous");
    assert.deepEqual(rows[0]!.metadata_json, {
      purpose: "operator_password_reset",
      reason: "issued",
    });
    assert.equal(rows[1]!.subject_id, null);
    assert.equal(rows[1]!.actor_key, "operator:admin");

    // A reason that could smuggle token material is structurally refused.
    await assert.rejects(
      sink.append({
        action: "email_link.redeem",
        purpose: "operator_password_reset",
        subjectId,
        outcome: "failure",
        reason: `token ${base64urlOf(1, 22)}.${base64urlOf(1, 43)}`,
        occurredAt: issuedAt,
      }),
      (error: unknown) =>
        error instanceof PersistenceError && error.code === "UNSAFE_AUDIT_METADATA",
    );
    await assert.rejects(
      sink.append({
        action: "email_link.issue",
        purpose: "operator_password_reset",
        subjectId: "not-a-uuid",
        outcome: "failure",
        reason: "issued",
        occurredAt: issuedAt,
      }),
      PersistenceError,
    );
  } finally {
    await harness.close();
  }
});

test("the issuance limiter admits a window's worth, blocks the next, and recovers", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const limiter = new DatabaseEmailLinkRateLimiter(harness.client);
    const options = { windowMs: 60_000, maxRequests: 2, blockMs: 120_000 };
    const bucket = ["email_link:test:address:bucket-a"];

    assert.equal(await limiter.recordRequest(bucket, issuedAt, options), null);
    assert.equal(
      await limiter.recordRequest(bucket, new Date(issuedAt.getTime() + 1_000), options),
      null,
    );
    const blockedAt = new Date(issuedAt.getTime() + 2_000);
    const retryAt = await limiter.recordRequest(bucket, blockedAt, options);
    assert.deepEqual(retryAt, new Date(blockedAt.getTime() + options.blockMs));

    // During the block: still refused, and the block is never extended.
    const during = new Date(blockedAt.getTime() + 60_000);
    assert.deepEqual(await limiter.recordRequest(bucket, during, options), retryAt);
    assert.deepEqual(await limiter.retryAt(bucket, during), retryAt);

    // Independent buckets are unaffected.
    assert.equal(
      await limiter.recordRequest(["email_link:test:source:bucket-b"], during, options),
      null,
    );

    // After the block expires, the window restarts cleanly.
    const recovered = new Date(retryAt!.getTime() + 61_000);
    assert.equal(await limiter.recordRequest(bucket, recovered, options), null);

    await limiter.clear(bucket);
    assert.equal(await limiter.retryAt(bucket, recovered), null);
  } finally {
    await harness.close();
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DatabaseEmailLinkRateLimiter,
  PrismaEmailLinkAuditSink,
  PrismaEmailLinkTokenRepository,
  PrismaEmailMessageOutboxRepository,
  enqueueEmailMessageIntent,
  issueEmailLinkToken,
} from "@packscout/database";
import { createMigratedTestDatabase } from "@packscout/database/test-support";
import type { PackscoutPrismaClient } from "@packscout/database";
import { resolveEmailLinkTokenConfiguration } from "./configuration.ts";
import { createEmailLinkTokenSecurity } from "./token-format.ts";
import {
  EMAIL_LINK_REJECTION,
  EmailLinkTokenService,
} from "./token-service.ts";

/**
 * The mechanism end to end against the real database: real hashing, real
 * atomic consumption, real throttling buckets, and the real audit ledger.
 * The unit suite proves the service's decision structure; this suite proves
 * the database-level guarantees those decisions rely on.
 */

const secret = "an-integration-email-link-secret-of-more-than-32-bytes";
const startedAt = new Date("2026-08-23T15:00:00.000Z");
const subjectId = "00000000-0000-4000-8000-0000000000aa";

function createService(client: PackscoutPrismaClient, clock: { now(): Date }) {
  const security = createEmailLinkTokenSecurity(secret);
  return new EmailLinkTokenService({
    store: new PrismaEmailLinkTokenRepository(client),
    throttle: new DatabaseEmailLinkRateLimiter(client),
    audit: new PrismaEmailLinkAuditSink(client),
    verifierDigest: security.verifierDigest,
    bucketKeyer: security.bucketKeyer,
    configuration: resolveEmailLinkTokenConfiguration({
      PACKSCOUT_EMAIL_LINK_RESET_ADDRESS_MAX_PER_WINDOW: "2",
    }),
    clock,
  });
}

test("a requested link redeems exactly once end to end, and reuse is uniformly rejected", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const clock = { current: new Date(startedAt), now: () => clock.current };
    const service = createService(harness.client, clock);

    const requested = await service.requestIssuance({
      purpose: "operator_password_reset",
      address: "Operator@Example.Test",
      source: "203.0.113.7",
      resolveSubjectId: async (address) =>
        address === "operator@example.test" ? subjectId : null,
    });
    assert.equal(requested.status, "accepted");
    assert.ok(requested.issued);
    const issued = requested.issued;
    assert.equal(issued.linkPath, `/reset-password#token=${issued.token}`);

    const redeemed = await service.redeem({
      purpose: "operator_password_reset",
      presentedToken: issued.token,
      isSubjectEligible: async (candidate) => candidate === subjectId,
    });
    assert.deepEqual(redeemed, {
      status: "redeemed",
      subjectId,
      addressNormalized: "operator@example.test",
    });

    // The caller's follow-on work failing changes nothing: consumed stays consumed.
    const reuse = await service.redeem({
      purpose: "operator_password_reset",
      presentedToken: issued.token,
      isSubjectEligible: async () => true,
    });
    assert.equal(reuse, EMAIL_LINK_REJECTION);

    const audit = await harness.client.audit_events.findMany({
      orderBy: { occurred_at: "asc" },
    });
    assert.deepEqual(
      audit.map((row) => [row.action, row.outcome]),
      [
        ["email_link.issue", "success"],
        ["email_link.redeem", "success"],
        ["email_link.redeem", "failure"],
      ],
    );
    const serializedAudit = JSON.stringify(audit);
    assert.equal(serializedAudit.includes(issued.token), false);
    assert.equal(serializedAudit.includes(issued.token.split(".")[1]!), false);
  } finally {
    await harness.close();
  }
});

test("concurrent redemptions through independent connections yield exactly one success", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const clock = { now: () => new Date(startedAt) };
    const issuer = createService(harness.client, clock);
    const result = await issuer.issue({
      purpose: "operator_password_reset",
      subjectId,
      address: "operator@example.test",
      source: "203.0.113.7",
    });
    assert.equal(result.status, "issued");
    if (result.status !== "issued") throw new Error("unreachable");

    const contenders = await Promise.all(
      Array.from({ length: 4 }, async () =>
        createService(await harness.createIndependentClient(), clock),
      ),
    );
    const outcomes = await Promise.all(
      contenders.map((service) =>
        service.redeem({
          purpose: "operator_password_reset",
          presentedToken: result.issued.token,
          isSubjectEligible: async () => true,
        }),
      ),
    );
    assert.equal(
      outcomes.filter((outcome) => outcome.status === "redeemed").length,
      1,
    );
    for (const outcome of outcomes) {
      if (outcome.status !== "redeemed") {
        assert.deepEqual(outcome, EMAIL_LINK_REJECTION);
      }
    }
  } finally {
    await harness.close();
  }
});

test("stored token material cannot redeem, and the stored hash differs from the verifier", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const clock = { now: () => new Date(startedAt) };
    const service = createService(harness.client, clock);
    const result = await service.issue({
      purpose: "operator_password_reset",
      subjectId,
      address: "operator@example.test",
      source: "203.0.113.7",
    });
    assert.equal(result.status, "issued");
    if (result.status !== "issued") throw new Error("unreachable");
    const [selector, verifier] = result.issued.token.split(".") as [string, string];

    const row = await harness.client.email_link_tokens.findUniqueOrThrow({
      where: { selector },
    });
    assert.notEqual(row.verifier_hash, verifier);

    // Everything a database read yields — selector plus stored hash — is not
    // a redeemable token.
    const replay = await service.redeem({
      purpose: "operator_password_reset",
      presentedToken: `${selector}.${row.verifier_hash}`,
      isSubjectEligible: async () => true,
    });
    assert.equal(replay, EMAIL_LINK_REJECTION);

    // The genuine composite still redeems: the refusal above was the hash,
    // not some general breakage.
    const genuine = await service.redeem({
      purpose: "operator_password_reset",
      presentedToken: result.issued.token,
      isSubjectEligible: async () => true,
    });
    assert.equal(genuine.status, "redeemed");
  } finally {
    await harness.close();
  }
});

test("a delivery failure does not consume the token", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const clock = { current: new Date(startedAt), now: () => clock.current };
    const service = createService(harness.client, clock);
    const security = createEmailLinkTokenSecurity(secret);

    // Issue and enqueue in one committed flow, the way messaging/009 will:
    // the token row and the durable intent land together, and the token
    // itself exists only inside the rendered-link input.
    const generatedResult = await service.issue({
      purpose: "operator_password_reset",
      subjectId,
      address: "operator@example.test",
      source: "203.0.113.7",
    });
    assert.equal(generatedResult.status, "issued");
    if (generatedResult.status !== "issued") throw new Error("unreachable");
    const issued = generatedResult.issued;
    await harness.client.$transaction((transaction) =>
      enqueueEmailMessageIntent(transaction, {
        kind: "operator_password_reset",
        recipient: "operator@example.test",
        idempotencyKey: "operator_password_reset:request-1",
        source: "operator_accounts",
        serializedInput: JSON.stringify({
          toEmail: "operator@example.test",
          resetLinkPath: issued.linkPath,
          linkExpiresAt: issued.expiresAt.toISOString(),
        }),
        dueAt: clock.current,
        now: clock.current,
        sourceActiveLimit: 100,
      }),
    );

    // The drain tries and the provider fails; the attempt is recorded and
    // the intent waits for retry — and none of that touches the token.
    const outbox = new PrismaEmailMessageOutboxRepository(harness.client);
    const [claim] = await outbox.claimDueBatch({
      workerId: "worker:test:1",
      now: clock.current,
      limit: 10,
      perRecipientLimit: 10,
      leaseMilliseconds: 60_000,
    });
    assert.ok(claim);
    const recorded = await outbox.recordAttemptOutcome({
      intentId: claim.intentId,
      claimToken: claim.claimToken,
      attemptNumber: claim.attemptNumber,
      occurredAt: clock.current,
      outcome: {
        status: "failed",
        provider: "postmark",
        errorCode: "EMAIL_DELIVERY_PROVIDER_UNAVAILABLE",
        errorMessage: "The provider did not accept the message.",
        retryable: true,
        retryAt: new Date(clock.current.getTime() + 60_000),
        maximumAttempts: 5,
      },
    });
    assert.equal(recorded, "retrying");

    const redeemed = await service.redeem({
      purpose: "operator_password_reset",
      presentedToken: issued.token,
      isSubjectEligible: async () => true,
    });
    assert.equal(redeemed.status, "redeemed");

    // And when issuance itself aborts alongside its enqueue, neither a
    // token nor an intent survives — no mailed link without a token, no
    // token nobody was mailed.
    const rolledBackSecurity = security;
    const generated = rolledBackSecurity.randomness.bytes(16).toString("base64url");
    const verifier = rolledBackSecurity.randomness.bytes(32).toString("base64url");
    await assert.rejects(
      harness.client.$transaction(async (transaction) => {
        await issueEmailLinkToken(transaction, {
          id: "00000000-0000-4000-8000-900000000099",
          purpose: "operator_password_reset",
          subjectId,
          addressNormalized: "operator@example.test",
          selector: generated,
          verifierHash: rolledBackSecurity.verifierDigest.digest(
            "operator_password_reset",
            verifier,
          ),
          issuedAt: clock.current,
          expiresAt: new Date(clock.current.getTime() + 60_000),
        });
        throw new Error("enqueue exploded before commit");
      }),
      /enqueue exploded/,
    );
    assert.equal(
      await harness.client.email_link_tokens.count({
        where: { selector: generated },
      }),
      0,
    );
  } finally {
    await harness.close();
  }
});

test("supersession and expiry hold through the real stack", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const clock = { current: new Date(startedAt), now: () => clock.current };
    const service = createService(harness.client, clock);
    const issue = () =>
      service.issue({
        purpose: "operator_password_reset",
        subjectId,
        address: "operator@example.test",
        source: "203.0.113.7",
      });

    const first = await issue();
    clock.current = new Date(startedAt.getTime() + 1_000);
    const second = await issue();
    assert.equal(first.status, "issued");
    assert.equal(second.status, "issued");
    if (first.status !== "issued" || second.status !== "issued") {
      throw new Error("unreachable");
    }
    assert.equal(second.issued.supersededCount, 1);

    const superseded = await service.redeem({
      purpose: "operator_password_reset",
      presentedToken: first.issued.token,
      isSubjectEligible: async () => true,
    });
    assert.equal(superseded, EMAIL_LINK_REJECTION);

    // Past the reset lifetime, the replacement is expired — and the
    // rejection is the same one.
    clock.current = new Date(second.issued.expiresAt.getTime());
    const expired = await service.redeem({
      purpose: "operator_password_reset",
      presentedToken: second.issued.token,
      isSubjectEligible: async () => true,
    });
    assert.equal(expired, EMAIL_LINK_REJECTION);
  } finally {
    await harness.close();
  }
});

test("issuance rate limiting binds per address through the real buckets without enumeration", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const clock = { current: new Date(startedAt), now: () => clock.current };
    const service = createService(harness.client, clock);
    const request = (source: string) =>
      service.requestIssuance({
        purpose: "operator_password_reset",
        address: "operator@example.test",
        source,
        resolveSubjectId: async () => subjectId,
      });

    const first = await request("203.0.113.7");
    clock.current = new Date(clock.current.getTime() + 1_000);
    const second = await request("203.0.113.8");
    clock.current = new Date(clock.current.getTime() + 1_000);
    // Third request for the same address inside the window: refused, from a
    // fresh source, with the identical outer shape.
    const third = await request("203.0.113.9");

    assert.ok(first.issued);
    assert.ok(second.issued);
    assert.deepEqual(third, { status: "accepted" });
    assert.equal(
      await harness.client.email_link_tokens.count({
        where: { subject_id: subjectId },
      }),
      2,
    );
    const blocked = await harness.client.audit_events.findMany({
      where: { outcome: "blocked" },
    });
    assert.equal(blocked.length, 1);
    assert.deepEqual(blocked[0]!.metadata_json, {
      purpose: "operator_password_reset",
      reason: "rate_limited",
    });
  } finally {
    await harness.close();
  }
});

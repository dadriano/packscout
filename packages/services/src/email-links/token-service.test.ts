import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { EmailLinkPurpose } from "@packscout/contracts";
import {
  renderOperatorInvitationMessage,
  renderOperatorPasswordResetMessage,
} from "../message-catalogue/catalogue.ts";
import {
  DEFAULT_INVITATION_LIFETIME_MS,
  DEFAULT_RESET_LIFETIME_MS,
  resolveEmailLinkTokenConfiguration,
} from "./configuration.ts";
import {
  createEmailLinkVerifierDigest,
  type EmailLinkBucketKeyer,
  type EmailLinkRandomness,
  type EmailLinkVerifierDigest,
} from "./token-format.ts";
import {
  EMAIL_LINK_REJECTION,
  EmailLinkTokenService,
  createEmailLinkTokenPruner,
  type EmailLinkAuditEventRecord,
  type EmailLinkAuditWriteFailure,
  type EmailLinkStoredToken,
  type EmailLinkThrottleOptions,
} from "./token-service.ts";

const secret = "a-unit-test-email-link-secret-longer-than-32-bytes";
const startedAt = new Date("2026-08-23T10:00:00.000Z");
const subjectId = "00000000-0000-4000-8000-0000000000aa";
const otherSubjectId = "00000000-0000-4000-8000-0000000000bb";

interface StoredRow extends EmailLinkStoredToken {
  readonly selector: string;
}

class FakeStore {
  readonly rows = new Map<string, StoredRow>();
  issueCalls = 0;
  consumeCalls = 0;
  private sequence = 0;

  async issue(input: {
    id: string;
    purpose: EmailLinkPurpose;
    subjectId: string;
    addressNormalized: string;
    selector: string;
    verifierHash: string;
    issuedAt: Date;
    expiresAt: Date;
  }): Promise<{ tokenId: string; supersededCount: number }> {
    this.issueCalls += 1;
    let supersededCount = 0;
    for (const [selector, row] of this.rows) {
      if (
        row.purpose === input.purpose &&
        row.subjectId === input.subjectId &&
        row.redeemedAt === null &&
        row.supersededAt === null
      ) {
        this.rows.set(selector, { ...row, supersededAt: input.issuedAt });
        supersededCount += 1;
      }
    }
    this.rows.set(input.selector, {
      id: input.id || `00000000-0000-4000-8000-9${String(++this.sequence).padStart(11, "0")}`,
      purpose: input.purpose,
      selector: input.selector,
      verifierHash: input.verifierHash,
      subjectId: input.subjectId,
      addressNormalized: input.addressNormalized,
      expiresAt: input.expiresAt,
      redeemedAt: null,
      supersededAt: null,
    });
    return { tokenId: input.id, supersededCount };
  }

  async findBySelector(selector: string): Promise<EmailLinkStoredToken | null> {
    return this.rows.get(selector) ?? null;
  }

  async consume(input: {
    tokenId: string;
    purpose: EmailLinkPurpose;
    now: Date;
  }): Promise<"consumed" | "unavailable"> {
    this.consumeCalls += 1;
    for (const [selector, row] of this.rows) {
      if (row.id !== input.tokenId) continue;
      if (
        row.purpose === input.purpose &&
        row.redeemedAt === null &&
        row.supersededAt === null &&
        row.expiresAt.getTime() > input.now.getTime()
      ) {
        this.rows.set(selector, { ...row, redeemedAt: input.now });
        return "consumed";
      }
      return "unavailable";
    }
    return "unavailable";
  }
}

class CountingThrottle {
  readonly calls: Array<{
    bucketKeys: readonly string[];
    options: EmailLinkThrottleOptions;
  }> = [];
  blockAt: Date | null = null;

  async recordRequest(
    bucketKeys: readonly string[],
    _now: Date,
    options: EmailLinkThrottleOptions,
  ): Promise<Date | null> {
    this.calls.push({ bucketKeys, options });
    return this.blockAt;
  }
}

class RecordingAudit {
  readonly events: EmailLinkAuditEventRecord[] = [];
  /** Which records this sink refuses, standing in for an unavailable ledger. */
  failsOn: ((event: EmailLinkAuditEventRecord) => boolean) | null = null;
  async append(event: EmailLinkAuditEventRecord): Promise<void> {
    if (this.failsOn?.(event)) throw new Error("the audit ledger is unavailable");
    this.events.push(event);
  }
}

class CountingDigest implements EmailLinkVerifierDigest {
  digestCalls = 0;
  matchesCalls = 0;
  constructor(private readonly inner: EmailLinkVerifierDigest) {}
  digest(purpose: EmailLinkPurpose, verifier: string): string {
    this.digestCalls += 1;
    return this.inner.digest(purpose, verifier);
  }
  matches(purpose: EmailLinkPurpose, verifier: string, stored: string): boolean {
    this.matchesCalls += 1;
    return this.inner.matches(purpose, verifier, stored);
  }
  reset(): void {
    this.digestCalls = 0;
    this.matchesCalls = 0;
  }
}

function deterministicRandomness(): EmailLinkRandomness & {
  bytesCalls: number;
  reset(): void;
} {
  let counter = 0;
  let calls = 0;
  return {
    get bytesCalls() {
      return calls;
    },
    reset() {
      calls = 0;
    },
    uuid: () => {
      counter += 1;
      return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
    },
    bytes: (length: number) => {
      calls += 1;
      counter += 1;
      const buffer = Buffer.alloc(length);
      buffer.writeUInt32BE(counter, length - 4);
      return buffer;
    },
  };
}

const bucketKeyer: EmailLinkBucketKeyer = {
  addressKey: (purpose, address) => `email_link:${purpose}:address:${Buffer.from(address).toString("base64url")}`,
  sourceKey: (purpose, source) => `email_link:${purpose}:source:${Buffer.from(source).toString("base64url")}`,
};

function createHarness(overrides?: {
  blockAt?: Date | null;
  auditFailsOn?: (event: EmailLinkAuditEventRecord) => boolean;
}) {
  const store = new FakeStore();
  const throttle = new CountingThrottle();
  throttle.blockAt = overrides?.blockAt ?? null;
  const audit = new RecordingAudit();
  audit.failsOn = overrides?.auditFailsOn ?? null;
  const auditFailures: EmailLinkAuditWriteFailure[] = [];
  const digest = new CountingDigest(createEmailLinkVerifierDigest(secret));
  const randomness = deterministicRandomness();
  const clock = { current: new Date(startedAt), now: () => clock.current };
  const service = new EmailLinkTokenService({
    store,
    throttle,
    audit,
    verifierDigest: digest,
    bucketKeyer,
    configuration: resolveEmailLinkTokenConfiguration({}),
    clock,
    randomness,
    reportAuditFailure: (failure) => auditFailures.push(failure),
  });
  // Construction draws the dummy digest; measurements start clean.
  digest.reset();
  randomness.reset();
  return {
    store,
    throttle,
    audit,
    auditFailures,
    digest,
    randomness,
    clock,
    service,
  };
}

function issueCommand(overrides?: Partial<{ purpose: EmailLinkPurpose; address: string; source: string; subjectId: string }>) {
  return {
    purpose: overrides?.purpose ?? ("operator_password_reset" as const),
    subjectId: overrides?.subjectId ?? subjectId,
    address: overrides?.address ?? "Operator@Example.Test",
    source: overrides?.source ?? "203.0.113.7",
  };
}

async function issuedToken(harness: ReturnType<typeof createHarness>, overrides?: Parameters<typeof issueCommand>[0]) {
  const result = await harness.service.issue(issueCommand(overrides));
  assert.equal(result.status, "issued");
  if (result.status !== "issued") throw new Error("unreachable");
  return result.issued;
}

test("issuing returns the only usable token inside a link path the catalogue accepts", async () => {
  const harness = createHarness();
  const issued = await issuedToken(harness);

  assert.match(issued.token, /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.linkPath, `/reset-password#token=${issued.token}`);
  assert.equal(
    issued.expiresAt.getTime(),
    startedAt.getTime() + DEFAULT_RESET_LIFETIME_MS,
  );
  assert.equal(issued.subjectId, subjectId);

  // The stored row carries the hash, never the verifier or the composite.
  const [row] = [...harness.store.rows.values()];
  assert.ok(row);
  assert.equal(issued.token.includes(row.verifierHash), false);
  assert.equal(row.verifierHash.includes(issued.token.split(".")[1]!), false);
  assert.equal(row.addressNormalized, "operator@example.test");

  // messaging/003 accepts the path as-is and anchors it to the admin origin.
  const rendered = renderOperatorPasswordResetMessage(
    {
      toEmail: "operator@example.test",
      resetLinkPath: issued.linkPath,
      linkExpiresAt: issued.expiresAt.toISOString(),
    },
    { productOrigin: null, adminOrigin: "https://admin.example.test" },
  );
  assert.equal(rendered.status, "rendered");

  const invitation = await issuedToken(harness, {
    purpose: "operator_invitation",
    subjectId: otherSubjectId,
  });
  assert.equal(
    invitation.expiresAt.getTime(),
    startedAt.getTime() + DEFAULT_INVITATION_LIFETIME_MS,
  );
  const renderedInvitation = renderOperatorInvitationMessage(
    {
      toEmail: "operator@example.test",
      invitedByDisplayName: "Dana Admin",
      invitationLinkPath: invitation.linkPath,
      linkExpiresAt: invitation.expiresAt.toISOString(),
    },
    { productOrigin: null, adminOrigin: "https://admin.example.test" },
  );
  assert.equal(renderedInvitation.status, "rendered");
});

test("a token redeems exactly once for its own purpose and subject", async () => {
  const harness = createHarness();
  const issued = await issuedToken(harness);

  const redeemed = await harness.service.redeem({
    purpose: "operator_password_reset",
    presentedToken: issued.token,
    isSubjectEligible: async () => true,
  });
  assert.deepEqual(redeemed, {
    status: "redeemed",
    subjectId,
    addressNormalized: "operator@example.test",
  });

  // Reuse — including after the caller's follow-on work failed — is refused.
  const reused = await harness.service.redeem({
    purpose: "operator_password_reset",
    presentedToken: issued.token,
    isSubjectEligible: async () => true,
  });
  assert.equal(reused, EMAIL_LINK_REJECTION);
});

test("every failure mode returns the identical frozen rejection value", async () => {
  const harness = createHarness();
  const eligible = async () => true;
  const issuedExpired = await issuedToken(harness);
  harness.clock.current = new Date(
    startedAt.getTime() + DEFAULT_RESET_LIFETIME_MS + 1,
  );
  const expired = await harness.service.redeem({
    purpose: "operator_password_reset",
    presentedToken: issuedExpired.token,
    isSubjectEligible: eligible,
  });

  harness.clock.current = new Date(startedAt);
  const superseded = await issuedToken(harness);
  const replacement = await issuedToken(harness);
  const supersededOutcome = await harness.service.redeem({
    purpose: "operator_password_reset",
    presentedToken: superseded.token,
    isSubjectEligible: eligible,
  });

  const wrongPurpose = await harness.service.redeem({
    purpose: "operator_invitation",
    presentedToken: replacement.token,
    isSubjectEligible: eligible,
  });

  const wrongVerifier = await harness.service.redeem({
    purpose: "operator_password_reset",
    presentedToken: `${replacement.token.split(".")[0]!}.${"A".repeat(43)}`,
    isSubjectEligible: eligible,
  });

  const unknown = await harness.service.redeem({
    purpose: "operator_password_reset",
    presentedToken: `${"z".repeat(22)}.${"A".repeat(43)}`,
    isSubjectEligible: eligible,
  });

  const malformed = await harness.service.redeem({
    purpose: "operator_password_reset",
    presentedToken: "not-a-token",
    isSubjectEligible: eligible,
  });

  const ineligible = await harness.service.redeem({
    purpose: "operator_password_reset",
    presentedToken: replacement.token,
    isSubjectEligible: async () => false,
  });

  const used = await harness.service.redeem({
    purpose: "operator_password_reset",
    presentedToken: replacement.token,
    isSubjectEligible: eligible,
  });
  assert.equal(used.status, "redeemed");
  const reuse = await harness.service.redeem({
    purpose: "operator_password_reset",
    presentedToken: replacement.token,
    isSubjectEligible: eligible,
  });

  for (const rejection of [
    expired,
    supersededOutcome,
    wrongPurpose,
    wrongVerifier,
    unknown,
    malformed,
    ineligible,
    reuse,
  ]) {
    // One frozen value, not merely one shape: nothing distinguishes the modes.
    assert.equal(rejection, EMAIL_LINK_REJECTION);
  }
  assert.ok(Object.isFrozen(EMAIL_LINK_REJECTION));
  assert.deepEqual(Object.keys(EMAIL_LINK_REJECTION).sort(), [
    "errorCode",
    "status",
  ]);

  // The audit trail still saw the true outcomes, without any token material.
  const reasons = harness.audit.events
    .filter((event) => event.action === "email_link.redeem")
    .map((event) => event.reason);
  assert.deepEqual(reasons, [
    "expired",
    "superseded",
    "purpose_mismatch",
    "verifier_mismatch",
    "unknown_token",
    "malformed_token",
    "subject_ineligible",
    "redeemed",
    "already_used",
  ]);
});

test("unknown and malformed presentations still perform one verifier comparison", async () => {
  const harness = createHarness();
  const issued = await issuedToken(harness);
  harness.digest.reset();

  await harness.service.redeem({
    purpose: "operator_password_reset",
    presentedToken: issued.token,
    isSubjectEligible: async () => true,
  });
  const knownComparisons = harness.digest.matchesCalls;
  harness.digest.reset();

  await harness.service.redeem({
    purpose: "operator_password_reset",
    presentedToken: `${"z".repeat(22)}.${"A".repeat(43)}`,
    isSubjectEligible: async () => true,
  });
  assert.equal(harness.digest.matchesCalls, knownComparisons);
  assert.equal(harness.digest.matchesCalls, 1);
  harness.digest.reset();

  await harness.service.redeem({
    purpose: "operator_password_reset",
    presentedToken: "garbage",
    isSubjectEligible: async () => true,
  });
  assert.equal(harness.digest.matchesCalls, 1);
});

test("issuing supersedes prior outstanding tokens for the same subject and purpose only", async () => {
  const harness = createHarness();
  const first = await issuedToken(harness);
  const otherPurpose = await issuedToken(harness, {
    purpose: "operator_invitation",
  });
  const otherSubject = await issuedToken(harness, { subjectId: otherSubjectId });
  const second = await issuedToken(harness);

  assert.equal(second.supersededCount, 1);
  const rows = [...harness.store.rows.values()];
  const firstRow = rows.find((row) => first.token.startsWith(row.selector));
  assert.ok(firstRow?.supersededAt);
  for (const untouched of [otherPurpose, otherSubject]) {
    const row = rows.find((candidate) => untouched.token.startsWith(candidate.selector));
    assert.equal(row?.supersededAt, null);
  }

  const supersededRedemption = await harness.service.redeem({
    purpose: "operator_password_reset",
    presentedToken: first.token,
    isSubjectEligible: async () => true,
  });
  assert.equal(supersededRedemption, EMAIL_LINK_REJECTION);
  const replacementRedemption = await harness.service.redeem({
    purpose: "operator_password_reset",
    presentedToken: second.token,
    isSubjectEligible: async () => true,
  });
  assert.equal(replacementRedemption.status, "redeemed");
});

test("eligibility is rechecked at redemption and never consumes the token", async () => {
  const harness = createHarness();
  const issued = await issuedToken(harness);
  let eligibilityChecks = 0;

  const refused = await harness.service.redeem({
    purpose: "operator_password_reset",
    presentedToken: issued.token,
    isSubjectEligible: async (candidate) => {
      eligibilityChecks += 1;
      assert.equal(candidate, subjectId);
      return false;
    },
  });
  assert.equal(refused, EMAIL_LINK_REJECTION);
  assert.equal(eligibilityChecks, 1);
  assert.equal(harness.store.consumeCalls, 0);

  // Re-enabled later: the same link still works because refusal spent nothing.
  const redeemed = await harness.service.redeem({
    purpose: "operator_password_reset",
    presentedToken: issued.token,
    isSubjectEligible: async () => true,
  });
  assert.equal(redeemed.status, "redeemed");
});

test("concurrent redemptions of one token yield exactly one success", async () => {
  const harness = createHarness();
  const issued = await issuedToken(harness);
  const outcomes = await Promise.all(
    Array.from({ length: 8 }, () =>
      harness.service.redeem({
        purpose: "operator_password_reset",
        presentedToken: issued.token,
        isSubjectEligible: async () => true,
      }),
    ),
  );
  const successes = outcomes.filter((outcome) => outcome.status === "redeemed");
  assert.equal(successes.length, 1);
  for (const outcome of outcomes) {
    if (outcome.status !== "redeemed") {
      assert.equal(outcome, EMAIL_LINK_REJECTION);
    }
  }
});

test("requests for unknown and known addresses do the same work and return the same shape", async () => {
  const harness = createHarness();
  const resolveCalls: string[] = [];
  const request = (address: string, resolved: string | null) =>
    harness.service.requestIssuance({
      purpose: "operator_password_reset",
      address,
      source: "203.0.113.7",
      resolveSubjectId: async (normalized) => {
        resolveCalls.push(normalized);
        return resolved;
      },
    });

  const known = await request("Operator@Example.Test", subjectId);
  const knownWork = {
    bytes: harness.randomness.bytesCalls,
    digests: harness.digest.digestCalls,
    throttleCalls: harness.throttle.calls.length,
  };
  harness.randomness.reset();
  harness.digest.reset();
  harness.throttle.calls.length = 0;

  const unknown = await request("stranger@example.test", null);
  const unknownWork = {
    bytes: harness.randomness.bytesCalls,
    digests: harness.digest.digestCalls,
    throttleCalls: harness.throttle.calls.length,
  };

  // Identical sequence of work: resolve once, throttle twice, generate and
  // digest one token — whether or not anything was persisted.
  assert.deepEqual(unknownWork, knownWork);
  assert.deepEqual(resolveCalls, [
    "operator@example.test",
    "stranger@example.test",
  ]);

  assert.equal(known.status, "accepted");
  assert.ok(known.issued);
  assert.equal(unknown.status, "accepted");
  assert.equal("issued" in unknown, false);
  // The requester-visible projection is identical.
  assert.deepEqual({ status: unknown.status }, { status: known.status });

  const audited = harness.audit.events.map((event) => [event.reason, event.subjectId]);
  assert.deepEqual(audited, [
    ["issued", subjectId],
    ["subject_unknown", null],
  ]);
});

test("a rate-limited request is refused without revealing anything and without issuing", async () => {
  const retryAt = new Date(startedAt.getTime() + 900_000);
  const harness = createHarness({ blockAt: retryAt });

  const limited = await harness.service.requestIssuance({
    purpose: "operator_password_reset",
    address: "operator@example.test",
    source: "203.0.113.7",
    resolveSubjectId: async () => subjectId,
  });
  assert.deepEqual(limited, { status: "accepted" });
  assert.equal(harness.store.issueCalls, 0);
  // Token material was still generated and digested on the limited path.
  assert.equal(harness.randomness.bytesCalls, 2);
  assert.equal(harness.digest.digestCalls, 1);

  const direct = await harness.service.issue(issueCommand());
  assert.deepEqual(direct, { status: "rate_limited", retryAt });
  assert.equal(harness.store.issueCalls, 0);

  const outcomes = harness.audit.events.map((event) => [event.outcome, event.reason]);
  assert.deepEqual(outcomes, [
    ["blocked", "rate_limited"],
    ["blocked", "rate_limited"],
  ]);
});

test("both throttle scopes are recorded on every request with purpose-specific limits", async () => {
  const harness = createHarness();
  await issuedToken(harness);
  assert.equal(harness.throttle.calls.length, 2);
  const [addressCall, sourceCall] = harness.throttle.calls;
  assert.match(addressCall!.bucketKeys[0]!, /^email_link:operator_password_reset:address:/);
  assert.match(sourceCall!.bucketKeys[0]!, /^email_link:operator_password_reset:source:/);
  assert.equal(addressCall!.options.maxRequests, 5);
  assert.equal(sourceCall!.options.maxRequests, 30);
});

test("no token material reaches the console, the audit trail, or a thrown error", async (t: TestContext) => {
  const captured: string[] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    t.mock.method(console, level, (...parts: unknown[]) => {
      captured.push(parts.map(String).join(" "));
    });
  }

  const harness = createHarness();
  const issued = await issuedToken(harness);
  await harness.service.redeem({
    purpose: "operator_password_reset",
    presentedToken: issued.token,
    isSubjectEligible: async () => true,
  });
  await harness.service.redeem({
    purpose: "operator_invitation",
    presentedToken: issued.token,
    isSubjectEligible: async () => true,
  });
  await harness.service.requestIssuance({
    purpose: "operator_password_reset",
    address: "nobody@example.test",
    source: "203.0.113.9",
    resolveSubjectId: async () => null,
  });
  let thrown: unknown;
  try {
    await harness.service.issue({ ...issueCommand(), address: "not an address" });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof RangeError);

  const [selector, verifier] = issued.token.split(".") as [string, string];
  const surfaces = [
    ...captured,
    JSON.stringify(harness.audit.events),
    String(thrown),
    JSON.stringify(EMAIL_LINK_REJECTION),
  ];
  assert.equal(captured.length, 0);
  for (const surface of surfaces) {
    assert.equal(surface.includes(issued.token), false);
    assert.equal(surface.includes(selector), false);
    assert.equal(surface.includes(verifier), false);
  }
  // Audit rows carry exactly subject, purpose, outcome, reason, and time.
  for (const event of harness.audit.events) {
    assert.deepEqual(
      Object.keys(event).sort(),
      ["action", "occurredAt", "outcome", "purpose", "reason", "subjectId"],
    );
  }
});

test("the retention pruner registers token pruning without touching live rows itself", async () => {
  const pruneRequests: Array<{ cutoffAt: Date; limit: number }> = [];
  const pruner = createEmailLinkTokenPruner({
    repository: {
      prune: async (request) => {
        pruneRequests.push(request);
        return 3;
      },
    },
  });
  assert.equal(pruner.kind, "email_link_tokens");
  assert.equal(pruner.retentionMs, 30 * 24 * 60 * 60_000);
  assert.equal(await pruner.prune({ cutoffAt: startedAt, limit: 100 }), 3);
  assert.deepEqual(pruneRequests, [{ cutoffAt: startedAt, limit: 100 }]);
  assert.throws(
    () => createEmailLinkTokenPruner({ repository: { prune: async () => 0 }, retentionMs: 0 }),
    RangeError,
  );
});

test("a consumed token is still redeemed when the success audit write fails", async () => {
  // The guarded UPDATE has committed and cannot be undone: this token can
  // never be presented again. Rejecting because the record could not be
  // written would spend the link and leave the person holding it with
  // nothing — no password set, no activation — and a second click on the
  // same link is the frozen rejection.
  const harness = createHarness({
    auditFailsOn: (event) =>
      event.action === "email_link.redeem" && event.outcome === "success",
  });
  const issued = await issuedToken(harness);

  const redeemed = await harness.service.redeem({
    purpose: "operator_password_reset",
    presentedToken: issued.token,
    isSubjectEligible: async () => true,
  });

  assert.equal(redeemed.status, "redeemed");
  if (redeemed.status !== "redeemed") throw new Error("unreachable");
  assert.equal(redeemed.subjectId, subjectId);
  assert.equal(harness.store.consumeCalls, 1);

  // The gap is its own reported failure, and carries no token material.
  assert.deepEqual(harness.auditFailures, [
    {
      action: "email_link.redeem",
      purpose: "operator_password_reset",
      reason: "redeemed",
      afterCommit: true,
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(harness.auditFailures),
    new RegExp(issued.token.slice(0, 22)),
  );

  // Single use still holds: the token really was consumed.
  assert.deepEqual(
    await harness.service.redeem({
      purpose: "operator_password_reset",
      presentedToken: issued.token,
      isSubjectEligible: async () => true,
    }),
    EMAIL_LINK_REJECTION,
  );
});

test("an administrator-triggered issuance is audited only after its commit lands", async () => {
  const harness = createHarness();
  const auditedWhenCommitting: EmailLinkAuditEventRecord[] = [];

  const result = await harness.service.issue({
    ...issueCommand(),
    commit: async (issued) => {
      auditedWhenCommitting.push(...harness.audit.events);
      assert.equal(issued.linkPath.startsWith("/reset-password#token="), true);
    },
  });

  assert.equal(result.status, "issued");
  // Nothing was in the trail while the transaction was still open.
  assert.deepEqual(auditedWhenCommitting, []);
  assert.deepEqual(
    harness.audit.events.map((event) => [event.outcome, event.reason]),
    [["success", "issued"]],
  );
});

test("an issuance whose transaction refuses is never recorded as a successful issue", async () => {
  // Auditing success before the commit puts a successful issuance in the
  // security trail for a link that does not exist and was never mailed.
  const harness = createHarness();
  const refusal = new Error("the issuance transaction refused");

  await assert.rejects(
    harness.service.issue({
      ...issueCommand(),
      commit: async () => {
        throw refusal;
      },
    }),
    (error: unknown) => error === refusal,
  );

  assert.deepEqual(
    harness.audit.events.map((event) => [
      event.action,
      event.outcome,
      event.reason,
    ]),
    [["email_link.issue", "failure", "issue_uncommitted"]],
  );
});

test("a request whose issuance transaction refuses records no successful issuance", async () => {
  const harness = createHarness();
  const refusal = new Error("the issuance transaction refused");

  await assert.rejects(
    harness.service.requestIssuance({
      purpose: "operator_password_reset",
      address: "Operator@Example.Test",
      source: "203.0.113.7",
      resolveSubjectId: async () => subjectId,
      commit: async () => {
        throw refusal;
      },
    }),
    (error: unknown) => error === refusal,
  );

  assert.deepEqual(
    harness.audit.events.map((event) => [
      event.action,
      event.outcome,
      event.reason,
    ]),
    [["email_link.issue", "failure", "issue_uncommitted"]],
  );
});

test("the request path audits a successful issuance only once its commit has landed", async () => {
  const harness = createHarness();
  const auditedWhenCommitting: EmailLinkAuditEventRecord[] = [];

  const result = await harness.service.requestIssuance({
    purpose: "operator_password_reset",
    address: "Operator@Example.Test",
    source: "203.0.113.7",
    resolveSubjectId: async () => subjectId,
    commit: async () => {
      auditedWhenCommitting.push(...harness.audit.events);
    },
  });

  assert.equal(result.status, "accepted");
  assert.ok(result.issued);
  assert.deepEqual(auditedWhenCommitting, []);
  assert.deepEqual(
    harness.audit.events.map((event) => [event.outcome, event.reason]),
    [["success", "issued"]],
  );
});

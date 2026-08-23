import assert from "node:assert/strict";
import { test } from "node:test";
import {
  boundedProductUserSubjectLabel,
  decideProductUserAccessRequestSchema,
  describeProductUserAccessActions,
  describeProductUserAccessOutcome,
  describeProductUserAccessProvenance,
  describeProductUserAccessState,
  describeProductUserEstimatedEv,
  describeProductUserIdentity,
  formatProductUserAwaitingCount,
  listProductUserAccessQueueRequestSchema,
  listProductUsersRequestSchema,
  productUserDetailRequestSchema,
  PRODUCT_USER_DIRECTORY_MAX_PAGE_SIZE,
  PRODUCT_USER_MAX_SEARCH_LENGTH,
  PRODUCT_USER_MAX_SUBJECT_LENGTH,
} from "./product-users.ts";

const subject = "https://auth.example.test/|did:example:1234567890abcdefghij";

test("listing requests default to the bounded page size and reject over-large ones", () => {
  const defaulted = listProductUsersRequestSchema.parse({});
  assert.deepEqual(defaulted, { limit: PRODUCT_USER_DIRECTORY_MAX_PAGE_SIZE });

  assert.equal(
    listProductUsersRequestSchema.parse({ limit: 5 }).limit,
    5,
  );
  for (const limit of [0, -1, 21, 500, 1.5]) {
    assert.equal(
      listProductUsersRequestSchema.safeParse({ limit }).success,
      false,
    );
  }
});

test("listing requests bound search, cursor, and unknown fields", () => {
  assert.equal(
    listProductUsersRequestSchema.parse({ search: "  ada@example.test  " })
      .search,
    "ada@example.test",
  );
  assert.equal(
    listProductUsersRequestSchema.safeParse({ search: "" }).success,
    false,
  );
  assert.equal(
    listProductUsersRequestSchema.safeParse({
      search: "a".repeat(PRODUCT_USER_MAX_SEARCH_LENGTH + 1),
    }).success,
    false,
  );
  assert.equal(
    listProductUsersRequestSchema.safeParse({ cursor: "" }).success,
    false,
  );
  assert.equal(
    listProductUsersRequestSchema.safeParse({ page: 2 }).success,
    false,
  );
});

test("row identity prefers email, then wallet, then a bounded subject key", () => {
  assert.deepEqual(
    describeProductUserIdentity({
      subject,
      email: "ada@example.test",
      walletAddress: "0xAbC",
    }),
    { kind: "email", label: "ada@example.test", secondary: "0xAbC" },
  );
  assert.deepEqual(
    describeProductUserIdentity({
      subject,
      email: null,
      walletAddress: "0xAbC",
    }),
    { kind: "wallet", label: "0xAbC", secondary: null },
  );

  // A record with neither attribute still renders an identifiable row.
  const fallback = describeProductUserIdentity({
    subject,
    email: null,
    walletAddress: null,
  });
  assert.equal(fallback.kind, "subject");
  assert.equal(fallback.label, boundedProductUserSubjectLabel(subject));
  // The issuer prefix is dropped in favour of the distinguishing part.
  assert.equal(fallback.label, "did:example:1234567890abcdefghij");
});

test("subject labels keep the distinguishing part within a bounded width", () => {
  const long = `${subject}${"0123456789".repeat(4)}`;
  const label = boundedProductUserSubjectLabel(long);
  assert.ok(label.length <= 45, label);
  assert.ok(label.startsWith("did:example:1234"));
  assert.ok(label.endsWith("0123456789"));
  assert.ok(label.includes("…"));
});

test("detail requests demand one bounded subject and nothing else", () => {
  assert.equal(
    productUserDetailRequestSchema.parse({ subject: `  ${subject}  ` }).subject,
    subject,
  );
  for (const request of [
    {},
    { subject: "" },
    { subject: "   " },
    { subject: "a".repeat(PRODUCT_USER_MAX_SUBJECT_LENGTH + 1) },
    { subject, savedRepackId: "40000000-0000-5000-8000-000000000001" },
  ]) {
    assert.equal(productUserDetailRequestSchema.safeParse(request).success, false);
  }
});

test("estimated value reads as money, return, and confidence", () => {
  assert.equal(
    describeProductUserEstimatedEv({
      evDollarsMinorUnits: 125_000,
      grossReturnBasisPoints: 10_738,
      confidenceBand: "high",
    }),
    "+$1,250.00 EV · 107% of price · high confidence",
  );
  // A pack estimated to lose money says so rather than hiding the sign.
  assert.equal(
    describeProductUserEstimatedEv({
      evDollarsMinorUnits: -305,
      grossReturnBasisPoints: 9_700,
      confidenceBand: "low",
    }),
    "-$3.05 EV · 97% of price · low confidence",
  );
});

test("short subject keys are shown in full and empty keys stay labelled", () => {
  assert.equal(boundedProductUserSubjectLabel("did:example:42"), "did:example:42");
  assert.equal(boundedProductUserSubjectLabel("opaque-key"), "opaque-key");
  assert.equal(boundedProductUserSubjectLabel(""), "Unrecorded identity");
});

test("queue requests default to the awaiting-review state and the bounded page", () => {
  assert.deepEqual(listProductUserAccessQueueRequestSchema.parse({}), {
    accessState: "awaiting_review",
    limit: PRODUCT_USER_DIRECTORY_MAX_PAGE_SIZE,
  });
  assert.equal(
    listProductUserAccessQueueRequestSchema.parse({ accessState: "declined" })
      .accessState,
    "declined",
  );
  for (const request of [
    { accessState: "suspended" },
    { accessState: "" },
    { limit: 0 },
    { limit: 21 },
    { cursor: "" },
    { search: "ada@example.test" },
  ]) {
    assert.equal(
      listProductUserAccessQueueRequestSchema.safeParse(request).success,
      false,
    );
  }
});

test("decision requests demand one bounded subject and can name nothing else", () => {
  assert.deepEqual(
    decideProductUserAccessRequestSchema.parse({ subject: `  ${subject}  ` }),
    { subject },
  );
  for (const request of [
    {},
    { subject: "" },
    { subject: "a".repeat(PRODUCT_USER_MAX_SUBJECT_LENGTH + 1) },
    // The acting operator is always the session; a request cannot name one.
    { subject, operatorId: "00000000-0000-4000-8000-000000000009" },
    { subject, action: "approve" },
  ]) {
    assert.equal(
      decideProductUserAccessRequestSchema.safeParse(request).success,
      false,
    );
  }
});

test("access states, provenance, and awaiting counts read as operator copy", () => {
  assert.equal(describeProductUserAccessState("awaiting_review"), "Awaiting review");
  assert.equal(describeProductUserAccessState("approved"), "Approved");
  assert.equal(describeProductUserAccessState("declined"), "Declined");

  const decidedAt = "2026-08-19T12:00:00.000Z";
  assert.equal(
    describeProductUserAccessProvenance({
      state: "awaiting_review",
      decidedBy: "default",
      decidedAt,
    }),
    "Awaiting a first decision",
  );
  assert.equal(
    describeProductUserAccessProvenance({
      state: "approved",
      decidedBy: "allowlist",
      decidedAt,
    }),
    "Admitted automatically by the allowlist",
  );
  assert.equal(
    describeProductUserAccessProvenance({
      state: "approved",
      decidedBy: "operator",
      decidedAt,
    }),
    "Approved by an operator",
  );
  assert.equal(
    describeProductUserAccessProvenance({
      state: "declined",
      decidedBy: "operator",
      decidedAt,
    }),
    "Declined by an operator",
  );
  assert.equal(
    describeProductUserAccessProvenance({
      state: "awaiting_review",
      decidedBy: "operator",
      decidedAt,
    }),
    "Returned to review by an operator",
  );

  assert.equal(formatProductUserAwaitingCount({ count: 3, truncated: false }), "3");
  assert.equal(formatProductUserAwaitingCount({ count: 500, truncated: true }), "500+");
});

test("each access state offers reversible decisions and never a deletion", () => {
  assert.deepEqual(
    describeProductUserAccessActions("awaiting_review").map(
      ({ action, actionLabel }) => ({ action, actionLabel }),
    ),
    [
      { action: "approve", actionLabel: "Approve" },
      { action: "decline", actionLabel: "Decline" },
    ],
  );
  assert.deepEqual(
    describeProductUserAccessActions("approved").map(({ action }) => action),
    ["revoke"],
  );
  assert.deepEqual(
    describeProductUserAccessActions("declined").map(
      ({ action, actionLabel }) => ({ action, actionLabel }),
    ),
    [
      { action: "approve", actionLabel: "Approve" },
      { action: "revoke", actionLabel: "Return to review" },
    ],
  );
  for (const state of ["awaiting_review", "approved", "declined"] as const) {
    for (const described of describeProductUserAccessActions(state)) {
      assert.ok(described.title.length > 0);
      assert.ok(described.description.length > 0);
      // No control ever offers a deletion; the copy only rules one out.
      assert.doesNotMatch(described.actionLabel, /delete|purge|remove/i);
      assert.doesNotMatch(described.confirmLabel, /delete|purge|remove/i);
    }
  }
});

test("decision outcomes restate the authoritative decision, honestly composed", () => {
  const decidedAt = "2026-08-19T12:00:00.000Z";
  const admittedNow = describeProductUserAccessOutcome({
    action: "approve",
    changed: true,
    access: { state: "approved", decidedBy: "operator", decidedAt },
    effectiveAccess: { admitted: true, reason: "approved" },
  });
  assert.match(admittedNow, /Access approved/);
  assert.match(admittedNow, /in the beta now/);

  // Approving a suspended account is a real approval that admits nobody yet.
  const stillSuspended = describeProductUserAccessOutcome({
    action: "approve",
    changed: true,
    access: { state: "approved", decidedBy: "operator", decidedAt },
    effectiveAccess: { admitted: false, reason: "suspended" },
  });
  assert.match(stillSuspended, /suspended/);
  assert.doesNotMatch(stillSuspended, /in the beta now/);

  // A repeat states the stored decision rather than claiming a change.
  assert.equal(
    describeProductUserAccessOutcome({
      action: "approve",
      changed: false,
      access: { state: "approved", decidedBy: "allowlist", decidedAt },
      effectiveAccess: { admitted: true, reason: "approved" },
    }),
    "That person's access was already approved.",
  );
  assert.match(
    describeProductUserAccessOutcome({
      action: "decline",
      changed: true,
      access: { state: "declined", decidedBy: "operator", decidedAt },
      effectiveAccess: { admitted: false, reason: "declined" },
    }),
    /saved items are kept/,
  );
  assert.match(
    describeProductUserAccessOutcome({
      action: "revoke",
      changed: true,
      access: { state: "awaiting_review", decidedBy: "operator", decidedAt },
      effectiveAccess: { admitted: false, reason: "awaiting_review" },
    }),
    /back in the review queue/,
  );
});

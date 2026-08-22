import assert from "node:assert/strict";
import { test } from "node:test";
import {
  boundedProductUserSubjectLabel,
  describeProductUserEstimatedEv,
  describeProductUserIdentity,
  describeProductUserRepackAvailability,
  listProductUsersRequestSchema,
  productUserDetailRequestSchema,
  PRODUCT_USER_DIRECTORY_MAX_PAGE_SIZE,
  PRODUCT_USER_MAX_SEARCH_LENGTH,
  PRODUCT_USER_MAX_SUBJECT_LENGTH,
  productUserRepackAvailabilities,
} from "./product-users.ts";

const subject = "https://auth.example.test/|did:example:1234567890abcdefghij";

test("listing requests default to the bounded page size and reject over-large ones", () => {
  const defaulted = listProductUsersRequestSchema.parse({});
  assert.deepEqual(defaulted, { limit: PRODUCT_USER_DIRECTORY_MAX_PAGE_SIZE });

  assert.equal(listProductUsersRequestSchema.parse({ limit: 5 }).limit, 5);
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
    assert.equal(
      productUserDetailRequestSchema.safeParse(request).success,
      false,
    );
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

test("saved repacks preserve and label the four public availability states", () => {
  assert.deepEqual(
    productUserRepackAvailabilities.map((availability) =>
      describeProductUserRepackAvailability(availability),
    ),
    ["Available now", "Unavailable", "Availability unknown", "Sold out"],
  );
});

test("short subject keys are shown in full and empty keys stay labelled", () => {
  assert.equal(
    boundedProductUserSubjectLabel("did:example:42"),
    "did:example:42",
  );
  assert.equal(boundedProductUserSubjectLabel("opaque-key"), "opaque-key");
  assert.equal(boundedProductUserSubjectLabel(""), "Unrecorded identity");
});

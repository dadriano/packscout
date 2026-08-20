import assert from "node:assert/strict";
import { test } from "node:test";
import {
  boundedProductUserSubjectLabel,
  describeProductUserIdentity,
  listProductUsersRequestSchema,
  PRODUCT_USER_DIRECTORY_MAX_PAGE_SIZE,
  PRODUCT_USER_MAX_SEARCH_LENGTH,
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

test("short subject keys are shown in full and empty keys stay labelled", () => {
  assert.equal(boundedProductUserSubjectLabel("did:example:42"), "did:example:42");
  assert.equal(boundedProductUserSubjectLabel("opaque-key"), "opaque-key");
  assert.equal(boundedProductUserSubjectLabel(""), "Unrecorded identity");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BETA_ALLOWLIST_PAGE_SIZE,
  createBetaAllowlistEntryRequestSchema,
  listBetaAllowlistRequestSchema,
  removeBetaAllowlistEntryRequestSchema,
  updateBetaAllowlistEntryRequestSchema,
} from "./beta-allowlist.ts";

test("the allowlist listing request stays bounded and strict", () => {
  const parsed = listBetaAllowlistRequestSchema.parse({
    search: "  ada@example.test  ",
    limit: "5",
  });
  assert.deepEqual(parsed, { search: "ada@example.test", limit: 5 });

  assert.equal(listBetaAllowlistRequestSchema.parse({}).limit, BETA_ALLOWLIST_PAGE_SIZE);

  for (const invalid of [
    { limit: 0 },
    { limit: BETA_ALLOWLIST_PAGE_SIZE + 1 },
    { limit: 1.5 },
    { search: "" },
    { search: "a".repeat(321) },
    { cursor: "" },
    { cursor: "c".repeat(4_097) },
    // Unknown fields could smuggle an identifier into an unexpected place.
    { limit: 5, page: 2 },
  ]) {
    assert.equal(
      listBetaAllowlistRequestSchema.safeParse(invalid).success,
      false,
      JSON.stringify(invalid),
    );
  }
});

test("creating an entry requires at least one identifier and no unknown fields", () => {
  assert.deepEqual(
    createBetaAllowlistEntryRequestSchema.parse({
      email: "  Ada@Example.test  ",
      label: " VIP invite ",
    }),
    // Trimmed, but deliberately not normalized: the product backend owns
    // case-folding and duplicate detection, so there is one authority.
    { email: "Ada@Example.test", label: "VIP invite" },
  );
  assert.deepEqual(
    createBetaAllowlistEntryRequestSchema.parse({
      walletAddress: "0xWalletAddress0001",
    }),
    { walletAddress: "0xWalletAddress0001" },
  );

  for (const invalid of [
    {},
    { label: "an entry with no identifier at all" },
    { email: "" },
    { walletAddress: "" },
    { email: `${"a".repeat(320)}@example.test` },
    { walletAddress: "w".repeat(129) },
    { email: "ada@example.test", label: "l".repeat(121) },
    // The acting operator comes from the session, never from the browser.
    { email: "ada@example.test", operatorId: "attacker-chosen" },
  ]) {
    assert.equal(
      createBetaAllowlistEntryRequestSchema.safeParse(invalid).success,
      false,
      JSON.stringify(invalid),
    );
  }
});

test("updating an entry distinguishes keep, change, and clear", () => {
  const parsed = updateBetaAllowlistEntryRequestSchema.parse({
    entryId: "entry-1",
    email: "ada@example.test",
    walletAddress: null,
  });
  // An omitted label keeps its stored value; the explicit null clears the
  // wallet address; both survive parsing distinguishably.
  assert.deepEqual(parsed, {
    entryId: "entry-1",
    email: "ada@example.test",
    walletAddress: null,
  });
  assert.equal("label" in parsed, false);

  for (const invalid of [
    { entryId: "entry-1" },
    { entryId: "", email: "ada@example.test" },
    { entryId: "e".repeat(129), email: "ada@example.test" },
    { email: "ada@example.test" },
    { entryId: "entry-1", email: "" },
    { entryId: "entry-1", operatorId: "attacker-chosen" },
  ]) {
    assert.equal(
      updateBetaAllowlistEntryRequestSchema.safeParse(invalid).success,
      false,
      JSON.stringify(invalid),
    );
  }
});

test("removal names exactly one entry", () => {
  assert.deepEqual(
    removeBetaAllowlistEntryRequestSchema.parse({ entryId: " entry-1 " }),
    { entryId: "entry-1" },
  );
  for (const invalid of [
    {},
    { entryId: "" },
    { entryId: "entry-1", cascade: true },
  ]) {
    assert.equal(
      removeBetaAllowlistEntryRequestSchema.safeParse(invalid).success,
      false,
      JSON.stringify(invalid),
    );
  }
});

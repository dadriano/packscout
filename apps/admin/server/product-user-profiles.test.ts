import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProductUserDirectoryRow, ProductUserProfile } from "@packscout/contracts";
import type { ProductUserDirectoryReader } from "./product-user-directory.ts";
import { withProductUserProfiles } from "./product-user-profiles.ts";

const alice: ProductUserDirectoryRow = {
  subject: "privy.io|did:privy:alice",
  authMethod: "privy.io",
  email: null,
  walletAddress: null,
  firstSeenAt: "2026-08-01T09:00:00.000Z",
  lastSeenAt: "2026-08-19T12:00:00.000Z",
  standing: "active",
  access: { state: "awaiting_review", decidedBy: "default", decidedAt: "2026-08-01T09:00:00.000Z" },
  savedRepackCount: 2,
  savedCollectibleCount: 5,
};
const bob: ProductUserDirectoryRow = {
  ...alice,
  subject: "privy.io|did:privy:bob",
  email: "canonical-bob@example.test",
};
const aliceProfile: ProductUserProfile = { name: "Alice Lee", email: "alice@example.test" };

function directory(overrides: Partial<ProductUserDirectoryReader> = {}): ProductUserDirectoryReader {
  return {
    listProductUsers: async () => ({ items: [alice, bob], nextCursor: "next-directory", searchTruncated: true }),
    listProductUserAccessQueue: async () => ({ items: [bob, alice], nextCursor: "next-queue", queueTruncated: true }),
    getProductUserDetail: async () => ({ user: alice, catalogAvailable: false, savedRepacks: [], savedCollectibles: [] }),
    getProductUserRecord: async () => alice,
    setProductUserStanding: async () => ({ user: alice, changed: false }),
    countAwaitingReview: async () => ({ count: 500, truncated: true }),
    decideProductUserAccess: async () => ({ outcome: "nothing_to_decide" }),
    ...overrides,
  };
}

test("directory and queue display profiles preserve page order, metadata and canonical records", async () => {
  const calls: string[] = [];
  const original = directory();
  const enriched = withProductUserProfiles(original, {
    readProfile: async (subject) => {
      calls.push(subject);
      return subject === alice.subject ? aliceProfile : { name: "Bob", email: "profile-bob@example.test" };
    },
  });
  const page = await enriched.listProductUsers({ limit: 20, search: "existing-search" });
  assert.deepEqual(page, {
    items: [
      { ...alice, profile: aliceProfile },
      { ...bob, profile: { name: "Bob", email: "profile-bob@example.test" } },
    ],
    nextCursor: "next-directory",
    searchTruncated: true,
  });
  const queue = await enriched.listProductUserAccessQueue({ accessState: "awaiting_review", limit: 20 });
  assert.deepEqual(queue.items.map((row) => row.subject), [bob.subject, alice.subject]);
  assert.equal(queue.nextCursor, "next-queue");
  assert.equal(queue.queueTruncated, true);
  assert.equal(queue.items[0].email, "canonical-bob@example.test");
  assert.deepEqual(calls, [alice.subject, bob.subject, bob.subject, alice.subject]);
  assert.equal(alice.email, null);
  assert.equal(alice.profile, undefined);
  assert.equal(bob.profile, undefined);
});

test("detail enrichment changes only the separate profile and preserves saved collections", async () => {
  const original = directory();
  const detail = await original.getProductUserDetail({ subject: alice.subject });
  const enriched = withProductUserProfiles(directory({ getProductUserDetail: async () => detail }), {
    readProfile: async (subject) => {
      assert.equal(subject, alice.subject);
      return aliceProfile;
    },
  });
  const result = await enriched.getProductUserDetail({ subject: alice.subject });
  assert.deepEqual(result.user, { ...alice, profile: aliceProfile });
  assert.equal(result.user.email, null);
  assert.strictEqual(result.user.access, alice.access);
  assert.strictEqual(result.savedRepacks, detail.savedRepacks);
  assert.strictEqual(result.savedCollectibles, detail.savedCollectibles);
  assert.equal(result.catalogAvailable, false);
});

test("a provider failure leaves a usable queue without hiding authoritative identity", async () => {
  const enriched = withProductUserProfiles(directory(), {
    readProfile: async (subject) => {
      if (subject === bob.subject) throw new Error("private upstream error");
      return aliceProfile;
    },
  });
  const page = await enriched.listProductUsers({ limit: 20 });
  assert.deepEqual(page.items, [{ ...alice, profile: aliceProfile }, { ...bob, profile: null }]);
  assert.equal(page.items[1].email, "canonical-bob@example.test");
});

test("notification record reads, counts and mutations never perform a profile lookup", async () => {
  let profileCalls = 0;
  const calls: Array<{ method: string; input?: unknown }> = [];
  const standing = { user: alice, changed: false };
  const outcome = { outcome: "nothing_to_decide" } as const;
  const count = { count: 500, truncated: true };
  const enriched = withProductUserProfiles(directory({
    getProductUserRecord: async (input) => { calls.push({ method: "record", input }); return alice; },
    setProductUserStanding: async (input) => { calls.push({ method: "standing", input }); return standing; },
    decideProductUserAccess: async (input) => { calls.push({ method: "decision", input }); return outcome; },
    countAwaitingReview: async () => { calls.push({ method: "count" }); return count; },
  }), {
    readProfile: async () => { profileCalls += 1; return aliceProfile; },
  });
  const recordInput = { subject: alice.subject };
  const standingInput = { subject: alice.subject, standing: "suspended" } as const;
  const decisionInput = { subject: alice.subject, action: "approve", operatorId: "operator-one" } as const;
  assert.strictEqual(await enriched.getProductUserRecord(recordInput), alice);
  assert.strictEqual(await enriched.setProductUserStanding(standingInput), standing);
  assert.strictEqual(await enriched.decideProductUserAccess(decisionInput), outcome);
  assert.strictEqual(await enriched.countAwaitingReview(), count);
  assert.equal(profileCalls, 0);
  assert.deepEqual(calls, [
    { method: "record", input: recordInput },
    { method: "standing", input: standingInput },
    { method: "decision", input: decisionInput },
    { method: "count" },
  ]);
});

test("display reads forward exact requests and do not resolve profiles when the directory refuses", async () => {
  const refusal = new Error("directory unavailable");
  const listInput = { search: "canonical@example.test", limit: 10, cursor: "directory-cursor" };
  const queueInput = { accessState: "declined", limit: 5, cursor: "queue-cursor" } as const;
  const detailInput = { subject: alice.subject };
  let profileCalls = 0;
  const enriched = withProductUserProfiles(directory({
    listProductUsers: async (input) => { assert.strictEqual(input, listInput); throw refusal; },
    listProductUserAccessQueue: async (input) => { assert.strictEqual(input, queueInput); throw refusal; },
    getProductUserDetail: async (input) => { assert.strictEqual(input, detailInput); throw refusal; },
  }), {
    readProfile: async () => { profileCalls += 1; return aliceProfile; },
  });
  await assert.rejects(enriched.listProductUsers(listInput), (error) => error === refusal);
  await assert.rejects(enriched.listProductUserAccessQueue(queueInput), (error) => error === refusal);
  await assert.rejects(enriched.getProductUserDetail(detailInput), (error) => error === refusal);
  assert.equal(profileCalls, 0);
});

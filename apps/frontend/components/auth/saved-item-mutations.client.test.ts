import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SAVED_CATALOG_ITEM_LIMIT, savedCatalogErrorCodes } from "@packscout/contracts";
import { createSavedItemMutations, savedItemKey, SAVED_ITEM_MESSAGE_LIMIT } from "./saved-item-mutations.client";
import { presentSaveControl, presentSavedItemMutationMessage } from "./saved-item-presentation";

const pack = "11111111-1111-5111-8111-111111111111";
const collectible = "22222222-2222-5222-8222-222222222222";
const ids = (savedRepackIds: string[] = [], savedCollectibleIds: string[] = []) => ({ savedRepackIds, savedCollectibleIds });
const uuid = (index: number) => `30000000-0000-5000-8000-${String(index).padStart(12, "0")}`;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const unused = async () => { throw new Error("Unexpected operation"); };

test("saving announces server truth only after reconciling the bounded ID set", async () => {
  const read = deferred<ReturnType<typeof ids>>();
  const calls: unknown[] = [];
  const flow = createSavedItemMutations({
    setSavedRepack: async (input) => { calls.push(input); return { saved: true, prunedUnavailable: true }; },
    setSavedCollectible: unused,
    getSavedItemIds: () => read.promise,
  });
  flow.activate();
  const completion = flow.run("repack", pack, true);
  await Promise.resolve();
  assert.deepEqual(calls, [{ publicRepackId: pack, saved: true }]);
  assert.equal(flow.getSnapshot().pending[savedItemKey("repack", pack)], true);
  assert.deepEqual(flow.getSnapshot().messages, {});
  const savedRepacks = [pack, ...Array.from({ length: 249 }, (_, index) => uuid(index))].sort();
  const savedCollectibles = Array.from({ length: 250 }, (_, index) => uuid(index));
  read.resolve(ids(savedRepacks, savedCollectibles));
  await completion;
  assert.deepEqual(flow.getSnapshot().pending, {});
  assert.match(flow.getSnapshot().messages[savedItemKey("repack", pack)]!.copy, /older unavailable save was removed/);
  assert.equal(savedRepacks.length, SAVED_CATALOG_ITEM_LIMIT);
  assert.equal(savedCollectibles.length, SAVED_CATALOG_ITEM_LIMIT);
});

test("same-turn duplicate clicks issue one stable-ID mutation before React can re-render", async () => {
  const write = deferred<{ saved: boolean; prunedUnavailable: boolean }>();
  let calls = 0;
  const flow = createSavedItemMutations({ setSavedRepack: async () => { calls += 1; return write.promise; }, setSavedCollectible: unused, getSavedItemIds: async () => ids([pack]) });
  flow.activate();
  const first = flow.run("repack", pack, true);
  await flow.run("repack", pack, true);
  assert.equal(calls, 1);
  write.resolve({ saved: true, prunedUnavailable: false });
  await first;
});

test("idempotent removal and unavailable-resource removal need only the stable ID and false", async () => {
  const calls: unknown[] = [];
  const flow = createSavedItemMutations({
    setSavedRepack: unused,
    setSavedCollectible: async (input) => { calls.push(input); return { saved: false, prunedUnavailable: false }; },
    getSavedItemIds: async () => ids(),
  });
  flow.activate();
  await flow.run("collectible", collectible, false);
  await flow.run("collectible", collectible, false);
  assert.deepEqual(calls, Array(2).fill({ publicCollectibleId: collectible, saved: false }));
  assert.match(flow.getSnapshot().messages[savedItemKey("collectible", collectible)]!.copy, /removed/);
});

test("a mutation response is authoritative even when it differs from the requested value", async () => {
  const flow = createSavedItemMutations({ setSavedRepack: async () => ({ saved: false, prunedUnavailable: false }), setSavedCollectible: unused, getSavedItemIds: async () => ids() });
  flow.activate();
  await flow.run("repack", pack, true);
  assert.match(flow.getSnapshot().messages[savedItemKey("repack", pack)]!.copy, /removed/);
});

test("every declared thrown or returned refusal has stable copy without raw error text", async () => {
  for (const code of savedCatalogErrorCodes) {
    for (const thrown of [true, false]) {
      const flow = createSavedItemMutations({
        setSavedRepack: async () => {
          const error = { code, error: "private credential internal topology" };
          if (thrown) throw { data: error };
          return error;
        },
        setSavedCollectible: unused, getSavedItemIds: unused,
      });
      flow.activate();
      await flow.run("repack", pack, true);
      assert.deepEqual(flow.getSnapshot().messages[savedItemKey("repack", pack)], presentSavedItemMutationMessage({ kind: "repack", saved: false, outcome: "error", errorCode: code }));
      assert.equal(JSON.stringify(flow.getSnapshot()).includes("credential"), false);
      assert.deepEqual(flow.getSnapshot().pending, {});
    }
  }
});

test("unknown refusal codes cannot escape fixed public copy through object properties", () => {
  for (const errorCode of ["toString", "constructor", "__proto__", "private operational failure"]) {
    assert.deepEqual(presentSavedItemMutationMessage({ kind: "repack", saved: false, outcome: "error", errorCode }), {
      copy: "We couldn't update this repack. Try again.", tone: "error",
    });
  }
});

test("malformed results, out-of-bound saved sets, failed reconciliation and membership conflicts never claim success", async () => {
  for (const raw of [{ saved: true }, { saved: true, prunedUnavailable: false, rawPayload: "private" }]) {
    const flow = createSavedItemMutations({ setSavedRepack: async () => raw, setSavedCollectible: unused, getSavedItemIds: unused });
    flow.activate(); await flow.run("repack", pack, true);
    assert.equal(flow.getSnapshot().messages[savedItemKey("repack", pack)]!.tone, "error");
  }
  for (const read of [async () => ids(), async () => ids(Array(251).fill(pack)), async () => ids([], Array(251).fill(collectible)), unused]) {
    const flow = createSavedItemMutations({ setSavedRepack: async () => ({ saved: true, prunedUnavailable: true }), setSavedCollectible: unused, getSavedItemIds: read });
    flow.activate(); await flow.run("repack", pack, true);
    assert.match(flow.getSnapshot().messages[savedItemKey("repack", pack)]!.copy, /Refresh the page/);
    assert.deepEqual(flow.getSnapshot().pending, {});
  }
});

test("sign-out cancels stale completion before it can read another session's saved IDs", async () => {
  const write = deferred<{ saved: boolean; prunedUnavailable: boolean }>();
  let reads = 0;
  const flow = createSavedItemMutations({ setSavedRepack: () => write.promise, setSavedCollectible: unused, getSavedItemIds: async () => { reads += 1; return ids([pack]); } });
  flow.activate();
  const pending = flow.run("repack", pack, true);
  flow.dispose();
  flow.activate();
  write.resolve({ saved: true, prunedUnavailable: true });
  await pending;
  assert.equal(reads, 0);
  assert.deepEqual(flow.getSnapshot().messages, {});
  assert.deepEqual(flow.getSnapshot().pending, {});
});

test("a stale reconciliation cannot clear a new session's pending action or message", async () => {
  const oldRead = deferred<ReturnType<typeof ids>>();
  const newWrite = deferred<{ saved: boolean; prunedUnavailable: boolean }>();
  let writes = 0;
  const flow = createSavedItemMutations({
    setSavedRepack: async () => ++writes === 1 ? { saved: true, prunedUnavailable: false } : newWrite.promise,
    setSavedCollectible: unused,
    getSavedItemIds: () => writes === 1 ? oldRead.promise : Promise.resolve(ids()),
  });
  flow.activate();
  const old = flow.run("repack", pack, true);
  await Promise.resolve();
  flow.dispose(); flow.activate();
  const current = flow.run("repack", pack, false);
  oldRead.resolve(ids([pack])); await old;
  assert.equal(flow.getSnapshot().pending[savedItemKey("repack", pack)], false);
  assert.deepEqual(flow.getSnapshot().messages, {});
  newWrite.resolve({ saved: false, prunedUnavailable: false }); await current;
  assert.match(flow.getSnapshot().messages[savedItemKey("repack", pack)]!.copy, /removed/);
});

test("switching verified identities remounts the saved coordinator even when both are signed in", () => {
  const source = readFileSync(new URL("./InitializedPackScoutAuthProvider.client.tsx", import.meta.url), "utf8");
  assert.match(source, /<AuthenticatedSavedItemsProvider\s+key=\{authenticated \? user\?\.id : "signed-out"\}/);
});

test("signed-out requests are inert; invalid IDs never reach transport or grow message keys", async () => {
  const flow = createSavedItemMutations({ setSavedRepack: unused, setSavedCollectible: unused, getSavedItemIds: unused });
  await flow.run("repack", pack, true);
  assert.deepEqual(flow.getSnapshot().messages, {});
  flow.activate();
  await flow.run("repack", "not an id", true);
  await flow.run("collectible", "x".repeat(10_000), true);
  assert.deepEqual(Object.keys(flow.getSnapshot().messages).sort(), ["collectible:invalid", "repack:invalid"]);
  assert.match(flow.getSnapshot().messages["collectible:invalid"]!.copy, /cannot be saved/);
});

test("retained messages are bounded and suspension evidence clears on a completed write", async () => {
  let suspended = true;
  const flow = createSavedItemMutations({
    setSavedRepack: async () => { if (suspended) throw { data: { code: "ACCOUNT_SUSPENDED" } }; return { saved: false, prunedUnavailable: false }; },
    setSavedCollectible: unused, getSavedItemIds: async () => ids(),
  });
  flow.activate(); await flow.run("repack", pack, false);
  assert.equal(flow.getSnapshot().refusedAsSuspended, true);
  suspended = false;
  for (let index = 0; index < SAVED_ITEM_MESSAGE_LIMIT + 5; index += 1) await flow.run("repack", uuid(index), false);
  assert.equal(flow.getSnapshot().refusedAsSuspended, false);
  assert.equal(Object.keys(flow.getSnapshot().messages).length, SAVED_ITEM_MESSAGE_LIMIT);
  assert.equal(flow.getSnapshot().messages[savedItemKey("repack", pack)], undefined);
});

test("known suspension never silently consumes a save or removal click", async () => {
  const calls: unknown[] = [];
  const refuse = async (input: unknown) => {
    calls.push(input);
    throw { data: { code: "ACCOUNT_SUSPENDED", message: "private suspension reason" } };
  };
  const flow = createSavedItemMutations({ setSavedRepack: refuse, setSavedCollectible: refuse, getSavedItemIds: unused });
  flow.activate();
  await flow.run("repack", pack, true);
  assert.equal(flow.getSnapshot().refusedAsSuspended, true);
  // The later clicks occur after the client already knows about the suspension.
  await flow.run("repack", pack, true);
  await flow.run("collectible", collectible, false);
  assert.deepEqual(calls, [{ publicRepackId: pack, saved: true }, { publicRepackId: pack, saved: true }, { publicCollectibleId: collectible, saved: false }]);
  for (const [kind, id, saved] of [["repack", pack, false], ["collectible", collectible, true]] as const) {
    const message = flow.getSnapshot().messages[savedItemKey(kind, id)];
    assert.deepEqual(message, presentSavedItemMutationMessage({ kind, saved, outcome: "error", errorCode: "ACCOUNT_SUSPENDED" }));
    const control = presentSaveControl({ authStatus: "signed_in", kind, saved, loading: false, pending: false, message });
    assert.equal(control.statusCopy, message?.copy);
    assert.equal(control.pressed, saved);
    assert.equal(control.tone, "error");
  }
  assert.deepEqual(flow.getSnapshot().pending, {});
  assert.equal(JSON.stringify(flow.getSnapshot()).includes("private suspension reason"), false);
});

test("in-flight coordination is bounded and disposed sessions retain no item state", async () => {
  const write = deferred<{ saved: boolean; prunedUnavailable: boolean }>();
  let writes = 0;
  const flow = createSavedItemMutations({
    setSavedRepack: () => { writes += 1; return write.promise; },
    setSavedCollectible: unused, getSavedItemIds: unused,
  });
  flow.activate();
  const pending = Array.from({ length: 2 * SAVED_CATALOG_ITEM_LIMIT + 1 }, (_, index) => flow.run("repack", uuid(index), false));
  assert.equal(writes, 2 * SAVED_CATALOG_ITEM_LIMIT);
  assert.equal(Object.keys(flow.getSnapshot().pending).length, 2 * SAVED_CATALOG_ITEM_LIMIT);
  flow.dispose();
  write.resolve({ saved: false, prunedUnavailable: false });
  await Promise.all(pending);
  assert.deepEqual(flow.getSnapshot(), { pending: {}, messages: {}, refusedAsSuspended: false });
});

test("pending copy follows requested action while the pressed state remains server truth", () => {
  for (const pendingSaved of [true, false]) {
    for (const saved of [true, false]) {
      const presented = presentSaveControl({ authStatus: "signed_in", kind: "repack", saved, pending: true, pendingSaved, loading: false });
      assert.equal(presented.label, pendingSaved ? "Saving…" : "Removing…");
      assert.equal(presented.pressed, saved);
    }
  }
  const source = readFileSync(new URL("./AuthenticatedSavedItemsProvider.client.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /withOptimisticUpdate/);
  assert.match(source, /savedCatalogItemIdsSchema.safeParse/);
  assert.match(source, /convex.query\(api.savedItems.getSavedItemIds, \{\}\)/);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { LOG_DISPLAY_PREFERENCES_KEY } from "./display-preferences.ts";
import {
  HIDDEN_SERVICES_KEY,
  MAX_HIDDEN_SERVICES,
  PANEL_PREFERENCE_KEYS,
  parseHiddenServices,
  readHiddenServices,
  resetPanelPreferences,
  writeHiddenServices,
} from "./panel-preferences.ts";
import {
  MAX_RECENT_SEARCHES,
  parseRecentSearches,
  readRecentSearches,
  recentSearchesWith,
  RECENT_SEARCHES_KEY,
  rememberRecentSearch,
  type RecentSearch,
} from "./recent-searches.ts";
import { createFilterTerm } from "./filter.ts";

function memoryStore(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

test("hidden services round-trip and stay unique", () => {
  const store = memoryStore();
  writeHiddenServices(store, ["worker", "frontend", "worker"]);
  assert.deepEqual(readHiddenServices(store), ["worker", "frontend"]);
});

test("a malformed hidden-services entry is dropped rather than repaired", () => {
  assert.deepEqual(parseHiddenServices("not json"), []);
  assert.deepEqual(parseHiddenServices('{"worker":true}'), []);
  assert.deepEqual(parseHiddenServices('["worker", 7, "", "admin"]'), ["worker", "admin"]);
  assert.deepEqual(readHiddenServices(undefined), []);
});

test("hidden services are bounded", () => {
  const store = memoryStore();
  const many = Array.from({ length: MAX_HIDDEN_SERVICES + 10 }, (_, index) => `svc-${index}`);
  writeHiddenServices(store, many);
  assert.equal(readHiddenServices(store).length, MAX_HIDDEN_SERVICES);
});

test("a remembered search keeps its flags, not just its text", () => {
  const store = memoryStore();
  rememberRecentSearch(store, createFilterTerm("run \\d+", { regex: true, caseSensitive: true }));
  assert.deepEqual(readRecentSearches(store), [
    { text: "run \\d+", negated: false, regex: true, caseSensitive: true },
  ]);
});

test("re-running a search promotes it instead of stacking copies", () => {
  const first: RecentSearch = { text: "a", negated: false, regex: false, caseSensitive: false };
  const second: RecentSearch = { text: "b", negated: false, regex: false, caseSensitive: false };
  const list = recentSearchesWith(recentSearchesWith([], first), second);
  assert.deepEqual(recentSearchesWith(list, first), [first, second]);
});

test("the same text with different flags is a different search", () => {
  const literal: RecentSearch = { text: "a", negated: false, regex: false, caseSensitive: false };
  const pattern: RecentSearch = { text: "a", negated: false, regex: true, caseSensitive: false };
  assert.equal(recentSearchesWith([literal], pattern).length, 2);
});

test("the recent list is bounded", () => {
  let list: RecentSearch[] = [];
  for (let index = 0; index < MAX_RECENT_SEARCHES + 5; index += 1) {
    list = recentSearchesWith(list, {
      text: `s${index}`,
      negated: false,
      regex: false,
      caseSensitive: false,
    });
  }
  assert.equal(list.length, MAX_RECENT_SEARCHES);
  assert.equal(list[0]?.text, `s${MAX_RECENT_SEARCHES + 4}`, "newest first");
});

test("a malformed recent-searches entry is dropped", () => {
  assert.deepEqual(parseRecentSearches("nope"), []);
  assert.deepEqual(parseRecentSearches('[{"text":"a"}]'), []);
  assert.deepEqual(parseRecentSearches('[{"text":"","negated":false,"regex":false,"caseSensitive":false}]'), []);
});

test("an empty search is never remembered", () => {
  const store = memoryStore();
  rememberRecentSearch(store, createFilterTerm(""));
  assert.deepEqual(readRecentSearches(store), []);
});

test("the reset clears every key the panel declares, and only those", () => {
  const store = memoryStore({
    [LOG_DISPLAY_PREFERENCES_KEY]: "{}",
    [HIDDEN_SERVICES_KEY]: '["worker"]',
    [RECENT_SEARCHES_KEY]: "[]",
    "someone.elses.key": "keep me",
  });
  resetPanelPreferences(store);
  assert.deepEqual([...store.values.keys()], ["someone.elses.key"]);
  for (const key of PANEL_PREFERENCE_KEYS) {
    assert.equal(store.getItem(key), null, `${key} must be cleared`);
  }
});

test("a store that throws does not break the view", () => {
  const hostile = {
    getItem() {
      throw new Error("storage is disabled");
    },
    setItem() {
      throw new Error("storage is disabled");
    },
    removeItem() {
      throw new Error("storage is disabled");
    },
  };
  assert.deepEqual(readHiddenServices(hostile), []);
  assert.deepEqual(readRecentSearches(hostile), []);
  assert.doesNotThrow(() => writeHiddenServices(hostile, ["worker"]));
  assert.doesNotThrow(() => resetPanelPreferences(hostile));
});

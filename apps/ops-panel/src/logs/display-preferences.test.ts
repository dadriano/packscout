import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_LOG_DISPLAY_PREFERENCES,
  LOG_DISPLAY_PREFERENCES_KEY,
  parseLogDisplayPreferences,
  readLogDisplayPreferences,
  writeLogDisplayPreferences,
} from "./display-preferences.ts";
import { serviceBadgeHue, SERVICE_HUE_STOPS } from "./service-badge.ts";

function memoryStore(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

test("preferences round-trip through a store", () => {
  const store = memoryStore();
  writeLogDisplayPreferences(store, {
    wrap: true,
    timestamps: "absolute",
    textSize: "large",
    ansi: false,
  });
  assert.deepEqual(readLogDisplayPreferences(store), {
    wrap: true,
    timestamps: "absolute",
    textSize: "large",
    ansi: false,
  });
  assert.ok(store.values.has(LOG_DISPLAY_PREFERENCES_KEY));
});

test("a missing or unreadable entry falls back to the defaults", () => {
  assert.deepEqual(
    readLogDisplayPreferences(memoryStore()),
    DEFAULT_LOG_DISPLAY_PREFERENCES,
  );
  assert.deepEqual(
    parseLogDisplayPreferences("not json"),
    DEFAULT_LOG_DISPLAY_PREFERENCES,
  );
  assert.deepEqual(
    parseLogDisplayPreferences("[]"),
    DEFAULT_LOG_DISPLAY_PREFERENCES,
  );
  assert.deepEqual(
    readLogDisplayPreferences(undefined),
    DEFAULT_LOG_DISPLAY_PREFERENCES,
  );
});

test("a stored value outside the vocabulary is replaced, field by field", () => {
  const parsed = parseLogDisplayPreferences(
    JSON.stringify({ wrap: "yes", timestamps: "epoch", textSize: "large" }),
  );
  assert.equal(parsed.wrap, DEFAULT_LOG_DISPLAY_PREFERENCES.wrap);
  assert.equal(parsed.timestamps, DEFAULT_LOG_DISPLAY_PREFERENCES.timestamps);
  assert.equal(parsed.textSize, "large", "the valid field survives");
});

test("a store that throws does not break the view", () => {
  const hostile = {
    getItem() {
      throw new Error("storage is disabled");
    },
    setItem() {
      throw new Error("storage is disabled");
    },
  };
  assert.deepEqual(
    readLogDisplayPreferences(hostile),
    DEFAULT_LOG_DISPLAY_PREFERENCES,
  );
  assert.doesNotThrow(() =>
    writeLogDisplayPreferences(hostile, DEFAULT_LOG_DISPLAY_PREFERENCES),
  );
});

test("a service badge colour is stable, in range, and needs no known list", () => {
  const step = 360 / SERVICE_HUE_STOPS;
  for (const service of ["frontend", "admin", "worker", "ops-panel", "brand-new"]) {
    const hue = serviceBadgeHue(service);
    assert.equal(hue, serviceBadgeHue(service), "the same name is the same hue");
    assert.ok(hue >= 0 && hue < 360);
    assert.equal(hue % step, 0, "hues land on a visible stop");
  }
  assert.notEqual(serviceBadgeHue("frontend"), serviceBadgeHue("admin"));
});

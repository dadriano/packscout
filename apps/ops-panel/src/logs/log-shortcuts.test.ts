import assert from "node:assert/strict";
import { test } from "node:test";
import { logShortcutBindings, neighbourService } from "./log-shortcuts.ts";
import { createShortcutRegistry } from "./shortcuts.ts";

const SERVICES = ["admin", "frontend", "worker"];

function actions(overrides: Partial<Parameters<typeof logShortcutBindings>[0]> = {}) {
  const calls: string[] = [];
  const record = (name: string) => () => calls.push(name);
  return {
    calls,
    input: {
      services: SERVICES,
      focusedService: null,
      focusFilter: record("focus-filter"),
      togglePause: record("toggle-pause"),
      jumpToLive: record("jump-to-live"),
      focusService: (service: string | null) => calls.push(`focus:${service}`),
      toggleWrap: record("toggle-wrap"),
      openHelp: record("open-help"),
      dismiss: record("dismiss"),
      ...overrides,
    },
  };
}

test("stepping wraps around the rail in both directions", () => {
  assert.equal(neighbourService(SERVICES, "admin", 1), "frontend");
  assert.equal(neighbourService(SERVICES, "worker", 1), "admin");
  assert.equal(neighbourService(SERVICES, "admin", -1), "worker");
  assert.equal(neighbourService(SERVICES, null, 1), "admin", "forward starts at the first");
  assert.equal(neighbourService(SERVICES, null, -1), "worker", "back starts at the last");
  assert.equal(neighbourService(SERVICES, "gone", 1), "admin");
  assert.equal(neighbourService([], null, 1), null);
});

test("every binding has a unique id and a unique key", () => {
  const bindings = logShortcutBindings(actions().input);
  assert.equal(new Set(bindings.map((entry) => entry.id)).size, bindings.length);
  assert.equal(
    new Set(bindings.map((entry) => entry.key.toLowerCase())).size,
    bindings.length,
    "two bindings on one key would make precedence invisible",
  );
  assert.ok(bindings.every((entry) => entry.description.length > 0));
});

test("only dismissal is allowed to act while typing", () => {
  const bindings = logShortcutBindings(actions().input);
  assert.deepEqual(
    bindings.filter((entry) => entry.allowWhileTyping).map((entry) => entry.id),
    ["dismiss"],
  );
});

test("the core loop is reachable from the keyboard", () => {
  const { calls, input } = actions();
  const registry = createShortcutRegistry(logShortcutBindings(input));
  for (const key of ["/", "p", "l", "]", "a", "w", "?"]) {
    assert.equal(registry.handle({ key }), true, `${key} should be bound`);
  }
  assert.deepEqual(calls, [
    "focus-filter",
    "toggle-pause",
    "jump-to-live",
    "focus:admin",
    "focus:null",
    "toggle-wrap",
    "open-help",
  ]);
});

test("stepping from a focused service moves along the rail", () => {
  const { calls, input } = actions({ focusedService: "frontend" });
  const registry = createShortcutRegistry(logShortcutBindings(input));
  registry.handle({ key: "[" });
  registry.handle({ key: "]" });
  assert.deepEqual(calls, ["focus:admin", "focus:worker"]);
});

test("with no services discovered, stepping does nothing rather than guessing", () => {
  const { calls, input } = actions({ services: [] });
  const registry = createShortcutRegistry(logShortcutBindings(input));
  assert.equal(registry.handle({ key: "]" }), true);
  assert.deepEqual(calls, []);
});

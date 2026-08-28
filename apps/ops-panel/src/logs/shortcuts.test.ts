import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createShortcutRegistry,
  groupShortcuts,
  isTypingTarget,
  shortcutKeyLabel,
  type ShortcutBinding,
} from "./shortcuts.ts";

function binding(
  id: string,
  key: string,
  run: () => void,
  overrides: Partial<ShortcutBinding> = {},
): ShortcutBinding {
  return {
    id,
    key,
    description: overrides.description ?? `does ${id}`,
    group: overrides.group ?? "View",
    allowWhileTyping: overrides.allowWhileTyping,
    keyLabel: overrides.keyLabel,
    run,
  };
}

test("a bound key runs its binding", () => {
  const fired: string[] = [];
  const registry = createShortcutRegistry([
    binding("pause", "p", () => fired.push("pause")),
  ]);
  assert.equal(registry.handle({ key: "p" }), true);
  assert.equal(registry.handle({ key: "P" }), true, "case does not matter");
  assert.equal(registry.handle({ key: "z" }), false);
  assert.deepEqual(fired, ["pause", "pause"]);
});

test("nothing fires while someone is typing", () => {
  const fired: string[] = [];
  const registry = createShortcutRegistry([
    binding("pause", "p", () => fired.push("pause")),
  ]);
  assert.equal(registry.handle({ key: "p" }, { tagName: "INPUT", type: "text" }), false);
  assert.equal(registry.handle({ key: "p" }, { tagName: "TEXTAREA" }), false);
  assert.equal(registry.handle({ key: "p" }, { isContentEditable: true }), false);
  assert.deepEqual(fired, []);
});

test("a binding may opt in to firing from inside a field", () => {
  const fired: string[] = [];
  const registry = createShortcutRegistry([
    binding("close", "Escape", () => fired.push("close"), { allowWhileTyping: true }),
  ]);
  assert.equal(registry.handle({ key: "Escape" }, { tagName: "INPUT" }), true);
  assert.deepEqual(fired, ["close"]);
});

test("a checkbox is not a place where someone is typing", () => {
  assert.equal(isTypingTarget({ tagName: "INPUT", type: "checkbox" }), false);
  assert.equal(isTypingTarget({ tagName: "INPUT", type: "text" }), true);
  assert.equal(isTypingTarget({ tagName: "INPUT" }), true, "an untyped input takes text");
  assert.equal(isTypingTarget({ tagName: "BUTTON" }), false);
  assert.equal(isTypingTarget({ tagName: "SELECT" }), true);
  assert.equal(isTypingTarget(null), false);
});

test("modified keystrokes belong to the browser", () => {
  let fired = 0;
  const registry = createShortcutRegistry([binding("pause", "p", () => (fired += 1))]);
  assert.equal(registry.handle({ key: "p", metaKey: true }), false);
  assert.equal(registry.handle({ key: "p", ctrlKey: true }), false);
  assert.equal(registry.handle({ key: "p", altKey: true }), false);
  assert.equal(fired, 0);
});

test("later surfaces register into the same framework and appear in help", () => {
  const fired: string[] = [];
  const registry = createShortcutRegistry([
    binding("filter", "/", () => fired.push("filter"), { group: "Filtering" }),
  ]);
  const remove = registry.register(
    binding("jump-start", "g", () => fired.push("jump-start"), { group: "Navigation" }),
  );

  assert.equal(registry.handle({ key: "g" }), true);
  assert.deepEqual(
    registry.bindings().map((entry) => entry.id),
    ["filter", "jump-start"],
  );

  remove();
  assert.equal(registry.handle({ key: "g" }), false);
  assert.deepEqual(
    registry.bindings().map((entry) => entry.id),
    ["filter"],
  );
});

test("removing a superseded registration leaves the replacement alone", () => {
  const fired: string[] = [];
  const registry = createShortcutRegistry();
  const removeFirst = registry.register(binding("x", "x", () => fired.push("first")));
  registry.register(binding("x", "x", () => fired.push("second")));
  removeFirst();
  assert.equal(registry.handle({ key: "x" }), true);
  assert.deepEqual(fired, ["second"]);
});

test("help is generated from the registry, grouped in registration order", () => {
  const registry = createShortcutRegistry([
    binding("filter", "/", () => {}, { group: "Filtering" }),
    binding("wrap", "w", () => {}, { group: "View" }),
    binding("case", "c", () => {}, { group: "Filtering" }),
  ]);
  assert.deepEqual(
    groupShortcuts(registry.bindings()).map((section) => [
      section.group,
      section.bindings.map((entry) => entry.id),
    ]),
    [
      ["Filtering", ["filter", "case"]],
      ["View", ["wrap"]],
    ],
  );
  assert.equal(shortcutKeyLabel(binding("help", "?", () => {})), "?");
  assert.equal(
    shortcutKeyLabel(binding("help", "?", () => {}, { keyLabel: "Shift + /" })),
    "Shift + /",
  );
});

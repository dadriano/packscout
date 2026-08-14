import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLOSED_GLOSSARY_HINT_STATE,
  positionGlossaryPanel,
  reduceGlossaryHintState,
  type GlossaryHintAction,
  type GlossaryHintState,
} from "./glossary-hint.client";

function apply(
  actions: readonly GlossaryHintAction[],
  initial: GlossaryHintState = CLOSED_GLOSSARY_HINT_STATE,
): GlossaryHintState {
  return actions.reduce(reduceGlossaryHintState, initial);
}

test("opens the same definition for pointer and keyboard focus", () => {
  const pointer = apply([{ type: "pointer_enter" }]);
  const keyboard = apply([{ type: "focus_enter" }]);

  assert.equal(pointer.open, true);
  assert.equal(pointer.pointerWithin, true);
  assert.equal(keyboard.open, true);
  assert.equal(keyboard.focusWithin, true);
});

test("keeps an activated hint pinned until the user dismisses it", () => {
  const pinned = apply([
    { type: "focus_enter" },
    { type: "toggle_pin" },
    { type: "focus_leave" },
    { type: "pointer_leave" },
  ]);
  assert.equal(pinned.open, true);
  assert.equal(pinned.pinned, true);

  const dismissed = reduceGlossaryHintState(pinned, { type: "dismiss" });
  assert.equal(dismissed.open, false);
  assert.equal(dismissed.pinned, false);
});

test("keeps the panel open while focus moves from its trigger to its Learn link", () => {
  const state = apply([
    { type: "focus_enter" },
    { type: "pointer_enter" },
    { type: "pointer_leave" },
  ]);
  assert.equal(state.open, true);
  assert.equal(state.focusWithin, true);

  const left = reduceGlossaryHintState(state, { type: "focus_leave" });
  assert.equal(left.open, false);
});

test("allows only one transient glossary surface to remain open", () => {
  const first = apply([{ type: "focus_enter" }, { type: "toggle_pin" }]);
  const second = apply([{ type: "pointer_enter" }]);

  assert.equal(first.open, true);
  assert.equal(second.open, true);

  const closedFirst = reduceGlossaryHintState(first, {
    type: "another_hint_opened",
  });
  assert.equal(closedFirst.open, false);
  assert.equal(closedFirst.dismissed, true);
});

test("does not immediately reopen a keyboard-dismissed hint", () => {
  const focused = apply([{ type: "focus_enter" }]);
  const dismissed = reduceGlossaryHintState(focused, { type: "dismiss" });

  assert.equal(dismissed.focusWithin, true);
  assert.equal(dismissed.open, false);

  const newlyFocused = apply(
    [{ type: "focus_leave" }, { type: "focus_enter" }],
    dismissed,
  );
  assert.equal(newlyFocused.open, true);
});

test("keeps glossary content inside narrow and zoomed viewports", () => {
  assert.deepEqual(
    positionGlossaryPanel({
      align: "start",
      viewportWidth: 390,
      viewportHeight: 844,
      trigger: { top: 200, right: 386, bottom: 218, left: 370 },
      panelWidth: 304,
      panelHeight: 190,
    }),
    { left: 70, top: 226 },
  );
  assert.deepEqual(
    positionGlossaryPanel({
      align: "end",
      viewportWidth: 390,
      viewportHeight: 300,
      trigger: { top: 260, right: 374, bottom: 278, left: 358 },
      panelWidth: 304,
      panelHeight: 190,
    }),
    { left: 70, top: 62 },
  );
});

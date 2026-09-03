import assert from "node:assert/strict";
import { test } from "node:test";
import { presentPackAvailability } from "./pack-availability-presentation";

test("availability uses four exact text labels without relying on color", () => {
  assert.deepEqual(
    (["available", "unavailable", "unknown", "sold_out"] as const).map(
      (state) => presentPackAvailability(state).label,
    ),
    ["Available", "Unavailable", "Availability unknown", "Sold out"],
  );
});

test("only available exposes purchase actions and unavailable does not imply sold out", () => {
  for (const state of ["unavailable", "unknown", "sold_out"] as const) {
    assert.equal(
      presentPackAvailability(state).purchaseActionsAvailable,
      false,
    );
  }
  assert.equal(
    presentPackAvailability("available").purchaseActionsAvailable,
    true,
  );
  const unavailable = presentPackAvailability("unavailable");
  assert.match(unavailable.description, /does not currently present/i);
  assert.match(unavailable.description, /does not assert.*sold out/i);
});

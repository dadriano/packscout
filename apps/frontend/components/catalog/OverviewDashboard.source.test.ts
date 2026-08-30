import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(
  new URL("./OverviewDashboard.client.tsx", import.meta.url),
  "utf8",
);

test("overview keeps a truthful inspector shell while selection loads", () => {
  assert.match(
    source,
    /inspectorOpen && inspectorPlacement === "side"/,
  );
  assert.match(
    source,
    /Select an opportunity to inspect its published evidence\./,
  );
});

test("overview does not pass the retired evaluated-EV coverage contract", () => {
  assert.doesNotMatch(source, /evaluatedEvRepacks=/);
});

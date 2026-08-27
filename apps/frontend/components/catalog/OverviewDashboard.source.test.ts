import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(
  new URL("./OverviewDashboard.client.tsx", import.meta.url),
  "utf8",
);

test("overview omits the inspector until an opportunity can be selected", () => {
  assert.match(
    source,
    /inspectorOpen && inspectorPlacement === "side" && selectedRepack !== null/,
  );
  assert.equal(
    source.includes("Select an opportunity to inspect its current evidence."),
    false,
  );
});

test("opportunity empty state receives EV coverage and a matching catalog link", () => {
  assert.match(
    source,
    /evaluatedEvRepacks=\{bundle\.kpis\.evaluatedEvRepacks\}/,
  );
  assert.match(source, /repacksHref=\{repacksHref\}/);
});

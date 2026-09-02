import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(
  new URL("./OpportunityTable.client.tsx", import.meta.url),
  "utf8",
);
const styles = readFileSync(
  new URL("./OpportunityTable.module.css", import.meta.url),
  "utf8",
);

test("non-current opportunity evidence is passed to the shared accessible hint", () => {
  assert.match(
    source,
    /const estimateEvidence = \[[\s\S]*?statusLabel[\s\S]*?reasonCopy[\s\S]*?sourceAgeLabel[\s\S]*?dataAsOfLabel[\s\S]*?calculationPriceNote[\s\S]*?\]\.filter/,
  );
  assert.match(
    source,
    /status !== "current"[\s\S]*?<GlossaryHint[\s\S]*?details=\{estimateEvidence\}[\s\S]*?field="evConfidence"/,
  );
});

test("the ten-column table scrolls without containing fixed hint panels", () => {
  assert.doesNotMatch(styles, /container-type\s*:/);
  assert.match(styles, /\.scrollRegion \{[\s\S]*?overflow-x: auto;/);
  assert.match(styles, /\.table \{[\s\S]*?min-width: 70rem;/);
});

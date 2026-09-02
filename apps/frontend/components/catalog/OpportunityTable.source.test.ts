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

test("opportunities delegate confidence and evidence to the shared component", () => {
  assert.match(source, /import \{ CatalogConfidenceEvidence \}/);
  assert.match(
    source,
    /<CatalogConfidenceEvidence[\s\S]*?estimate=\{row\.packScoutEv\}[\s\S]*?providerHealth=\{repack\.providerHealth\}[\s\S]*?repackName=\{row\.name\}/,
  );
  assert.doesNotMatch(source, /const estimateEvidence/);
});

test("the ten-column table scrolls without containing fixed hint panels", () => {
  assert.doesNotMatch(styles, /container-type\s*:/);
  assert.match(styles, /\.scrollRegion \{[\s\S]*?overflow-x: auto;/);
  assert.match(styles, /\.table \{[\s\S]*?min-width: 70rem;/);
});

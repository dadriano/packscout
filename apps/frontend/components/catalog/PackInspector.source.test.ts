import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("./PackInspector.client.tsx", import.meta.url), "utf8");

test("inspector moves estimate detail into contextual info hints", () => {
  assert.match(source, /definition: estimatedEvHint/);
  assert.match(source, /definition: vendorReportedEvHint/);
  assert.match(source, /definition: coverage/);
  assert.equal(source.includes("className={styles.estimateContext}"), false);
  assert.equal(source.includes("className={styles.vendorEstimateContext}"), false);
});

test("unavailable top chase uses a tappable visual placeholder", () => {
  assert.match(source, /triggerClassName=\{styles\.chaseUnavailableTrigger\}/);
  assert.match(source, /triggerClassName=\{styles\.chaseValueUnavailableTrigger\}/);
  assert.match(source, /triggerAriaLabel=\{chase\.accessibleLabel\}/);
  assert.equal(source.includes("className={styles.chaseUnavailable}"), false);
});

test("sheet inspector keeps the price explanation with the hero price and exposes a destination action", () => {
  assert.match(source, /className=\{styles\.priceValue\}/);
  assert.match(source, /<GlossaryHint field="repackPrice" \/>/);
  assert.match(source, /showRepackPrice=\{false\}/);
  assert.match(source, /Browse \{repack\.vendorDisplayName\} repacks/);
  assert.match(source, /className=\{styles\.financialDisclaimer\}/);
});

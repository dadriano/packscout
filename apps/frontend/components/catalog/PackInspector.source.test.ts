import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("./PackInspector.client.tsx", import.meta.url), "utf8");

test("inspector hints explain each term once instead of repeating visible detail", () => {
  // The heading hint uses the shared one-definition default; the timestamps it
  // used to append are available from the confidence value.
  assert.equal(source.includes("estimatedEvHint"), false);
  assert.equal(source.includes("headingHint="), false);
  // Vendor observation time and evidence coverage ride along as hint details
  // under the glossary definitions rather than replacing them.
  assert.match(source, /field="vendorReportedEv"/);
  assert.match(source, /details=\{vendorObservationDetails\}/);
  assert.match(source, /glossaryDetails=\{\[coverage\]\}/);
  assert.equal(source.includes("definition: coverage"), false);
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

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

const table = source("./AllRepacksTable.client.tsx");
const cards = source("./AllRepacksCards.client.tsx");
const inspector = source("./PackInspector.client.tsx");
const tableStyles = source("./AllRepacksTable.module.css");
const cardStyles = source("./AllRepacksCards.module.css");
const inspectorStyles = source("./PackInspector.module.css");
const filters = source("./CatalogFilters.client.tsx");

test("all established catalog presentations use the shared four-state text contract", () => {
  for (const component of [table, cards, inspector]) {
    assert.match(component, /presentPackAvailability\(repack\.availability\)/);
    assert.match(component, /data-state=\{repack\.availability\}/);
    assert.match(component, /availability\.label/);
  }
  assert.match(
    filters,
    /Include packs labeled Unavailable, Availability unknown, or Sold out/,
  );
  assert.match(filters, /\? "all" : "available"/);
});

test("availability meaning is available to screen readers and not encoded by color alone", () => {
  assert.match(table, /className="sr-only">\. \{availability\.description\}/);
  assert.match(cards, /className="sr-only">\. \{availability\.description\}/);
  assert.match(inspector, /aria-describedby=\{`\$\{headingId\}-availability-description`\}/);
  assert.match(inspector, /\{availability\.description\}/);
  assert.match(inspector, /purchaseActionsAvailable/);
});

test("availability labels wrap at narrow and zoomed widths and preserve reduced-motion behavior", () => {
  assert.match(tableStyles, /\.availabilityBadge[\s\S]*overflow-wrap: anywhere/);
  assert.match(cardStyles, /\.availability[\s\S]*overflow-wrap: anywhere/);
  assert.match(inspectorStyles, /\.availabilityDescription[\s\S]*overflow-wrap: anywhere/);
  assert.match(tableStyles, /@media \(max-width: 720px\)/);
  assert.match(cardStyles, /@media \(max-width: 560px\)/);
  assert.match(inspectorStyles, /@media \(max-width: 430px\)/);
  for (const styles of [tableStyles, cardStyles, inspectorStyles]) {
    assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(styles, /var\(--color-/);
  }
});

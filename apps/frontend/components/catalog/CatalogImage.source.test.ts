import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

const catalogImageStyles = source("./CatalogImage.module.css");
const allRepacksTableStyles = source("./AllRepacksTable.module.css");

test("pack artwork stays fully visible without changing chase image framing", () => {
  assert.match(
    catalogImageStyles,
    /\.image\s*\{[^}]*object-fit: cover;/,
  );
  assert.match(
    catalogImageStyles,
    /\.frame\[data-variant="thumbnail"\] \.image,\s*\.frame\[data-variant="pack"\] \.image\s*\{[^}]*object-fit: contain;/,
  );
  assert.match(
    catalogImageStyles,
    /\.frame\[data-variant="vendor"\] \.image\s*\{[^}]*object-fit: contain;/,
  );
  assert.doesNotMatch(
    catalogImageStyles,
    /\.frame\[data-variant="chase"\] \.image\s*\{[^}]*object-fit: contain;/,
  );
  assert.match(
    allRepacksTableStyles,
    /\.packImage,\s*\.imagePlaceholder\s*\{[^}]*object-fit: contain;/,
  );
});

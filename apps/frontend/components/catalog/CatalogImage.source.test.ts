import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

const catalogImageStyles = source("./CatalogImage.module.css");
const allRepacksTableStyles = source("./AllRepacksTable.module.css");

test("catalog artwork fills its frame and stays fully visible", () => {
  assert.match(
    catalogImageStyles,
    /\.frame\s*\{[^}]*position: relative;[^}]*overflow: hidden;/,
  );
  assert.match(
    catalogImageStyles,
    /\.image\s*\{[^}]*position: absolute;[^}]*inset: 0;[^}]*width: 100%;[^}]*height: 100%;[^}]*object-fit: contain;[^}]*object-position: center;/,
  );
  assert.match(
    catalogImageStyles,
    /\.frame\[data-variant="thumbnail"\]\s*\{[^}]*width: 2\.45rem;[^}]*aspect-ratio: 3 \/ 4;/,
  );
  assert.match(
    catalogImageStyles,
    /\.frame\[data-variant="pack"\]\s*\{[^}]*width: clamp\(6\.5rem, 8vw, 8rem\);[^}]*aspect-ratio: 8 \/ 11;/,
  );
  assert.match(
    catalogImageStyles,
    /\.frame\[data-variant="chase"\]\s*\{[^}]*width: 4\.5rem;[^}]*aspect-ratio: 3 \/ 4;/,
  );
  assert.doesNotMatch(
    catalogImageStyles,
    /object-fit: cover;/,
  );
  assert.match(
    allRepacksTableStyles,
    /\.packImage,\s*\.imagePlaceholder\s*\{[^}]*object-fit: contain;/,
  );
});

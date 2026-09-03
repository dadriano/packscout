import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(
  new URL("./DashboardPageHeader.tsx", import.meta.url),
  "utf8",
);

test("all-repacks can place desired chase search in the Dashboard page heading", () => {
  assert.match(source, /<DesiredCollectibleSearch/);
  assert.match(source, /variant="heading"/);
  assert.match(source, /data-has-desired-chase/);
  assert.match(source, /serializeCatalogViewState\(nextQuery, desiredChase\.layout\)/);
  assert.match(source, /chaseInspect\.open\(/);
});

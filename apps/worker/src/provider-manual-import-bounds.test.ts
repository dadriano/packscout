import assert from "node:assert/strict";
import test from "node:test";
import {
  PROVIDER_MANUAL_IMPORT_MAXIMUM_PAGES,
  providerManualImportPageNumberWithinBound,
} from "./provider-manual-import-bounds.ts";

test("restart at 49,999 pages admits page 50,000 but never page 50,001", () => {
  assert.equal(PROVIDER_MANUAL_IMPORT_MAXIMUM_PAGES, 50_000);
  const committedBeforeRestart = 49_999;
  assert.equal(
    providerManualImportPageNumberWithinBound(committedBeforeRestart + 1),
    true,
  );
  assert.equal(
    providerManualImportPageNumberWithinBound(
      PROVIDER_MANUAL_IMPORT_MAXIMUM_PAGES + 1,
    ),
    false,
  );
});

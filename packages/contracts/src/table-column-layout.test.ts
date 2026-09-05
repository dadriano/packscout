import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_TABLE_COLUMN_LAYOUT_ENTRIES,
  TABLE_COLUMN_LAYOUT_TABLE_KEYS,
  tableColumnLayoutEntriesSchema,
  tableColumnLayoutTableKeySchema,
} from "./table-column-layout.ts";

test("table column layouts accept ordered, unique, well-formed column entries", () => {
  const parsed = tableColumnLayoutEntriesSchema.parse([
    { key: "repack", visible: true },
    { key: "evDollars", visible: false },
  ]);
  assert.deepEqual(parsed, [
    { key: "repack", visible: true },
    { key: "evDollars", visible: false },
  ]);
  assert.deepEqual(TABLE_COLUMN_LAYOUT_TABLE_KEYS, ["all_repacks"]);
  assert.equal(tableColumnLayoutTableKeySchema.safeParse("all_repacks").success, true);
  assert.equal(tableColumnLayoutTableKeySchema.safeParse("overview").success, false);
});

test("table column layouts reject empty, oversized, duplicate, malformed, and widened entries", () => {
  const valid = { key: "repack", visible: true };
  const reject = (value: unknown) =>
    assert.equal(tableColumnLayoutEntriesSchema.safeParse(value).success, false);

  reject([]);
  reject(
    Array.from({ length: MAX_TABLE_COLUMN_LAYOUT_ENTRIES + 1 }, (_, index) => ({
      key: `column${index}`,
      visible: true,
    })),
  );
  reject([valid, { ...valid }]);
  reject([{ key: "Repack", visible: true }]);
  reject([{ key: "repack price", visible: true }]);
  reject([{ key: "", visible: true }]);
  reject([{ key: "repack", visible: "yes" }]);
  reject([{ key: "repack", visible: true, width: 120 }]);
  assert.equal(
    tableColumnLayoutEntriesSchema.safeParse(
      Array.from({ length: MAX_TABLE_COLUMN_LAYOUT_ENTRIES }, (_, index) => ({
        key: `column${index}`,
        visible: index % 2 === 0,
      })),
    ).success,
    true,
  );
});

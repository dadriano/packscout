import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearStoredTableColumnLayout,
  defaultTableColumnLayout,
  isDefaultTableColumnLayout,
  moveTableColumn,
  parseStoredTableColumnLayout,
  readStoredTableColumnLayout,
  reconcileTableColumnLayout,
  serializeStoredTableColumnLayout,
  setTableColumnVisibility,
  summarizeTableColumnLayout,
  tableColumnLayoutStorageKey,
  writeStoredTableColumnLayout,
  type TableColumnDefinition,
  type TableColumnLayoutStorage,
} from "./table-column-layout";
import { createSessionTableColumnLayoutStore } from "./table-column-layout.client";

type Key = "vendor" | "repack" | "price" | "ev" | "link";

const COLUMNS: readonly TableColumnDefinition<Key>[] = Object.freeze([
  { key: "vendor", label: "Vendor" },
  { key: "repack", label: "Repack", required: true },
  { key: "price", label: "Price" },
  { key: "ev", label: "EV" },
  { key: "link", label: "Link" },
]);

function memoryStorage(): TableColumnLayoutStorage & { readonly items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
}

test("an absent layout reconciles to every column visible in default order", () => {
  const layout = reconcileTableColumnLayout(null, COLUMNS);
  assert.deepEqual(layout, defaultTableColumnLayout(COLUMNS));
  assert.equal(isDefaultTableColumnLayout(layout, COLUMNS), true);
  assert.deepEqual(summarizeTableColumnLayout(layout, COLUMNS), {
    total: 5,
    visibleCount: 5,
    hiddenCount: 0,
    reordered: false,
    customized: false,
  });
});

test("reconciling drops unknown keys, collapses duplicates, keeps required columns visible, and slots new columns beside their default neighbour", () => {
  const layout = reconcileTableColumnLayout(
    [
      { key: "link", visible: false },
      { key: "repack", visible: false },
      { key: "retired", visible: true },
      { key: "vendor", visible: true },
      { key: "link", visible: true },
    ],
    COLUMNS,
  );
  assert.deepEqual(layout, [
    { key: "link", visible: false },
    { key: "repack", visible: true },
    { key: "price", visible: true },
    { key: "ev", visible: true },
    { key: "vendor", visible: true },
  ]);
  assert.deepEqual(summarizeTableColumnLayout(layout, COLUMNS), {
    total: 5,
    visibleCount: 4,
    hiddenCount: 1,
    reordered: true,
    customized: true,
  });
});

test("columns missing from a layout follow their nearest preceding default neighbour, or lead when none is present", () => {
  const layout = reconcileTableColumnLayout(
    [{ key: "ev", visible: true }, { key: "repack", visible: true }],
    COLUMNS,
  );
  // vendor has no default predecessor, price follows repack, link follows ev.
  assert.deepEqual(
    layout.map(({ key }) => key),
    ["vendor", "ev", "link", "repack", "price"],
  );
  assert.deepEqual(
    reconcileTableColumnLayout(
      [{ key: "link", visible: false }, { key: "vendor", visible: true }],
      COLUMNS,
    ).map(({ key }) => key),
    ["link", "vendor", "repack", "price", "ev"],
  );
});

test("moving clamps to the table bounds and returns the same layout for no-ops", () => {
  const layout = defaultTableColumnLayout(COLUMNS);
  assert.deepEqual(
    moveTableColumn(layout, "link", 0).map(({ key }) => key),
    ["link", "vendor", "repack", "price", "ev"],
  );
  assert.deepEqual(
    moveTableColumn(layout, "vendor", 99).map(({ key }) => key),
    ["repack", "price", "ev", "link", "vendor"],
  );
  assert.deepEqual(
    moveTableColumn(layout, "price", -4).map(({ key }) => key),
    ["price", "vendor", "repack", "ev", "link"],
  );
  assert.equal(moveTableColumn(layout, "price", 2), layout);
  assert.equal(moveTableColumn(layout, "missing" as Key, 0), layout);
});

test("visibility changes respect required columns and ignore unknown keys", () => {
  const layout = defaultTableColumnLayout(COLUMNS);
  const hidden = setTableColumnVisibility(layout, COLUMNS, "ev", false);
  assert.equal(hidden.find(({ key }) => key === "ev")?.visible, false);
  assert.equal(setTableColumnVisibility(layout, COLUMNS, "repack", false), layout);
  assert.equal(setTableColumnVisibility(layout, COLUMNS, "ev", true), layout);
  assert.equal(setTableColumnVisibility(layout, COLUMNS, "missing" as Key, false), layout);
  assert.equal(
    setTableColumnVisibility(hidden, COLUMNS, "ev", true).find(({ key }) => key === "ev")
      ?.visible,
    true,
  );
});

test("stored layouts round-trip and fail closed on foreign or malformed payloads", () => {
  const entries = [
    { key: "ev", visible: true },
    { key: "repack", visible: false },
  ];
  assert.deepEqual(
    parseStoredTableColumnLayout(serializeStoredTableColumnLayout(entries)),
    entries,
  );
  assert.equal(parseStoredTableColumnLayout(null), null);
  assert.equal(parseStoredTableColumnLayout("not json"), null);
  assert.equal(parseStoredTableColumnLayout(JSON.stringify({ version: 2, columns: entries })), null);
  assert.equal(parseStoredTableColumnLayout(JSON.stringify({ version: 1, columns: [] })), null);
  assert.equal(
    parseStoredTableColumnLayout(
      JSON.stringify({ version: 1, columns: [{ key: "Bad Key", visible: true }] }),
    ),
    null,
  );
  assert.equal(
    parseStoredTableColumnLayout(
      JSON.stringify({ version: 1, columns: [...entries, { key: "ev", visible: false }] }),
    ),
    null,
  );
});

test("session storage helpers namespace by table and tolerate a missing store", () => {
  const storage = memoryStorage();
  const entries = [{ key: "repack", visible: true }];
  assert.equal(tableColumnLayoutStorageKey("all_repacks"), "packscout.table-columns.all_repacks");

  writeStoredTableColumnLayout(storage, "all_repacks", entries);
  assert.deepEqual(readStoredTableColumnLayout(storage, "all_repacks"), entries);
  assert.equal(storage.items.has("packscout.table-columns.all_repacks"), true);

  clearStoredTableColumnLayout(storage, "all_repacks");
  assert.equal(readStoredTableColumnLayout(storage, "all_repacks"), null);

  writeStoredTableColumnLayout(null, "all_repacks", entries);
  assert.equal(readStoredTableColumnLayout(null, "all_repacks"), null);
  clearStoredTableColumnLayout(null, "all_repacks");
});

test("the session store exposes a stable snapshot, notifies subscribers, and persists per tab", () => {
  const storage = memoryStorage();
  const store = createSessionTableColumnLayoutStore(() => storage);
  const entries = [{ key: "repack", visible: true }, { key: "ev", visible: false }];
  let notifications = 0;
  const unsubscribe = store.subscribe(() => {
    notifications += 1;
  });

  assert.deepEqual(store.getServerSnapshot(), {});
  assert.equal(store.getSnapshot(), store.getSnapshot());
  assert.deepEqual(store.getSnapshot(), {});

  store.write("all_repacks", entries);
  assert.equal(notifications, 1);
  assert.deepEqual(store.getSnapshot(), { all_repacks: entries });
  assert.deepEqual(readStoredTableColumnLayout(storage, "all_repacks"), entries);

  const rehydrated = createSessionTableColumnLayoutStore(() => storage);
  assert.deepEqual(rehydrated.getSnapshot(), { all_repacks: entries });

  store.clear("all_repacks");
  assert.equal(notifications, 2);
  assert.deepEqual(store.getSnapshot(), {});
  assert.equal(storage.items.size, 0);

  unsubscribe();
  store.write("all_repacks", entries);
  assert.equal(notifications, 2);
});

import { renderStatic } from "@/lib/component-render.test-support";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReactElement } from "react";
import {
  buildV3ListPage,
  buildV3ViewDetail,
} from "@/lib/packscout-ev-fixtures.test-support";
import { ALL_REPACKS_HEADERS } from "@/lib/all-repacks-table";
import {
  PackScoutAuthContext,
  unavailableAuthValue,
} from "@/components/auth/AuthContext.client";
import {
  SavedItemsContext,
  unavailableSavedItemsValue,
} from "@/components/auth/SavedItemsContext.client";
import {
  SessionTableColumnLayoutProvider,
  TableColumnLayoutContext,
  type TableColumnLayoutStore,
} from "@/components/table-layout/TableColumnLayoutContext.client";
import type { TableColumnLayoutEntry } from "@packscout/contracts";
import { AllRepacksTable } from "./AllRepacksTable.client";

const noop = () => undefined;
const DEFAULT_KEYS = ALL_REPACKS_HEADERS.map(({ key }) => key);

function storeWith(
  entries: readonly TableColumnLayoutEntry[] | null,
): TableColumnLayoutStore {
  return {
    persistence: "account",
    loading: false,
    saveState: "idle",
    read: () => entries,
    write: noop,
    clear: noop,
  };
}

function withProviders(element: ReactElement, store: TableColumnLayoutStore | null): ReactElement {
  const layoutTree = store
    ? <TableColumnLayoutContext.Provider value={store}>{element}</TableColumnLayoutContext.Provider>
    : <SessionTableColumnLayoutProvider>{element}</SessionTableColumnLayoutProvider>;
  return (
    <PackScoutAuthContext.Provider value={unavailableAuthValue}>
      <SavedItemsContext.Provider value={unavailableSavedItemsValue}>
        {layoutTree}
      </SavedItemsContext.Provider>
    </PackScoutAuthContext.Provider>
  );
}

function renderTable(store: TableColumnLayoutStore | null): string {
  return renderStatic(
    withProviders(
      <AllRepacksTable
        onCopyPromo={noop}
        onOpenRepack={noop}
        onSelect={noop}
        onSort={noop}
        page={buildV3ListPage([buildV3ViewDetail()])}
        repackHrefById={new Map()}
        selectedPublicRepackId={null}
      />,
      store,
    ),
  );
}

function columnOrder(markup: string, cell: "th" | "td"): string[] {
  return [...markup.matchAll(new RegExp(`<${cell}[^>]*data-column="([^"]+)"`, "g"))].map(
    (match) => match[1]!,
  );
}

function triggerLabel(markup: string): string | null {
  return markup.match(/aria-haspopup="dialog"[^>]*aria-label="([^"]+)"/)?.[1] ?? null;
}

test("without a stored layout every column renders in the default order and the control stays quiet", () => {
  const markup = renderTable(null);
  assert.deepEqual(columnOrder(markup, "th"), DEFAULT_KEYS);
  assert.deepEqual(columnOrder(markup, "td"), DEFAULT_KEYS);
  assert.equal(triggerLabel(markup), "Columns");
  assert.doesNotMatch(markup, /hidden</);
});

test("a stored layout reorders and hides columns in the header and in every row alike", () => {
  const markup = renderTable(
    storeWith([
      { key: "evDollars", visible: true },
      { key: "repack", visible: true },
      { key: "vendor", visible: false },
    ]),
  );
  const headers = columnOrder(markup, "th");
  // Stored order wins for the columns it names; columns it has never seen slot
  // in after their default neighbour, so EV % follows EV $ ahead of Repack.
  assert.equal(headers[0], "evDollars");
  assert.equal(headers[1], "evPercent");
  assert.ok(headers.indexOf("evDollars") < headers.indexOf("repack"));
  assert.equal(headers.includes("vendor"), false);
  assert.equal(headers.length, DEFAULT_KEYS.length - 1);
  assert.deepEqual(columnOrder(markup, "td"), headers);
  assert.equal(triggerLabel(markup), "Columns, 14 of 15 shown, custom order");
  assert.match(markup, />1 hidden</);
});

test("the identity column stays visible even when a stored layout hides it", () => {
  const markup = renderTable(storeWith([{ key: "repack", visible: false }]));
  assert.equal(columnOrder(markup, "th").includes("repack"), true);
  assert.equal(triggerLabel(markup), "Columns");
});

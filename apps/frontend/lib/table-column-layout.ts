import {
  MAX_TABLE_COLUMN_LAYOUT_ENTRIES,
  TABLE_COLUMN_KEY_PATTERN,
  type TableColumnLayoutEntry,
  type TableColumnLayoutTableKey,
} from "@packscout/contracts";

export type TableColumnDefinition<K extends string = string> = Readonly<{
  key: K;
  label: string;
  /** Required columns are always shown; they can still be reordered. */
  required?: boolean;
}>;

export type TableColumnLayout<K extends string = string> = readonly Readonly<{
  key: K;
  visible: boolean;
}>[];

export type TableColumnLayoutSummary = Readonly<{
  total: number;
  visibleCount: number;
  hiddenCount: number;
  reordered: boolean;
  customized: boolean;
}>;

export const TABLE_COLUMN_LAYOUT_STORAGE_VERSION = 1;

export type TableColumnLayoutStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

export function defaultTableColumnLayout<K extends string>(
  columns: readonly TableColumnDefinition<K>[],
): TableColumnLayout<K> {
  return Object.freeze(
    columns.map(({ key }) => Object.freeze({ key, visible: true })),
  );
}

/**
 * Turns a stored layout into one that matches the table's current columns:
 * unknown keys are dropped, duplicates collapse to their first occurrence,
 * required columns stay visible, and columns the layout has never seen slot in
 * after their nearest default neighbour so new fields stay discoverable.
 */
export function reconcileTableColumnLayout<K extends string>(
  candidate: readonly TableColumnLayoutEntry[] | null | undefined,
  columns: readonly TableColumnDefinition<K>[],
): TableColumnLayout<K> {
  const definitions = new Map<string, TableColumnDefinition<K>>(
    columns.map((column) => [column.key, column]),
  );
  const entries: Array<{ key: K; visible: boolean }> = [];
  const seen = new Set<string>();

  for (const entry of candidate ?? []) {
    const definition = definitions.get(entry.key);
    if (definition === undefined || seen.has(entry.key)) continue;
    seen.add(entry.key);
    entries.push({
      key: definition.key,
      visible: definition.required === true ? true : entry.visible,
    });
  }

  columns.forEach((column, index) => {
    if (seen.has(column.key)) return;
    let insertAt = 0;
    for (let previous = index - 1; previous >= 0; previous -= 1) {
      const position = entries.findIndex(
        ({ key }) => key === columns[previous]!.key,
      );
      if (position !== -1) {
        insertAt = position + 1;
        break;
      }
    }
    entries.splice(insertAt, 0, { key: column.key, visible: true });
    seen.add(column.key);
  });

  return Object.freeze(entries.map((entry) => Object.freeze(entry)));
}

export function moveTableColumn<K extends string>(
  layout: TableColumnLayout<K>,
  key: K,
  toIndex: number,
): TableColumnLayout<K> {
  const fromIndex = layout.findIndex((entry) => entry.key === key);
  if (fromIndex === -1) return layout;
  const boundedIndex = Math.max(0, Math.min(toIndex, layout.length - 1));
  if (boundedIndex === fromIndex) return layout;
  const entries = [...layout];
  const [moved] = entries.splice(fromIndex, 1);
  entries.splice(boundedIndex, 0, moved!);
  return Object.freeze(entries);
}

export function setTableColumnVisibility<K extends string>(
  layout: TableColumnLayout<K>,
  columns: readonly TableColumnDefinition<K>[],
  key: K,
  visible: boolean,
): TableColumnLayout<K> {
  const definition = columns.find((column) => column.key === key);
  if (definition === undefined) return layout;
  const nextVisible = definition.required === true ? true : visible;
  if (!layout.some((entry) => entry.key === key && entry.visible !== nextVisible)) {
    return layout;
  }
  return Object.freeze(
    layout.map((entry) =>
      entry.key === key ? Object.freeze({ key, visible: nextVisible }) : entry,
    ),
  );
}

export function summarizeTableColumnLayout<K extends string>(
  layout: TableColumnLayout<K>,
  columns: readonly TableColumnDefinition<K>[],
): TableColumnLayoutSummary {
  const hiddenCount = layout.filter((entry) => !entry.visible).length;
  const reordered = layout.some((entry, index) => entry.key !== columns[index]?.key);
  return Object.freeze({
    total: layout.length,
    visibleCount: layout.length - hiddenCount,
    hiddenCount,
    reordered,
    customized: reordered || hiddenCount > 0,
  });
}

export function isDefaultTableColumnLayout<K extends string>(
  layout: TableColumnLayout<K>,
  columns: readonly TableColumnDefinition<K>[],
): boolean {
  return !summarizeTableColumnLayout(layout, columns).customized;
}

export function isTableColumnLayoutEntries(
  value: unknown,
): value is readonly TableColumnLayoutEntry[] {
  if (!Array.isArray(value)) return false;
  if (value.length === 0 || value.length > MAX_TABLE_COLUMN_LAYOUT_ENTRIES) {
    return false;
  }
  const keys = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return false;
    const { key, visible } = entry as { key?: unknown; visible?: unknown };
    if (typeof key !== "string" || !TABLE_COLUMN_KEY_PATTERN.test(key)) {
      return false;
    }
    if (typeof visible !== "boolean" || keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}

export function tableColumnLayoutStorageKey(
  tableKey: TableColumnLayoutTableKey,
): string {
  return `packscout.table-columns.${tableKey}`;
}

export function serializeStoredTableColumnLayout(
  entries: readonly TableColumnLayoutEntry[],
): string {
  return JSON.stringify({
    version: TABLE_COLUMN_LAYOUT_STORAGE_VERSION,
    columns: entries.map(({ key, visible }) => ({ key, visible })),
  });
}

export function parseStoredTableColumnLayout(
  raw: string | null,
): readonly TableColumnLayoutEntry[] | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { version, columns } = parsed as { version?: unknown; columns?: unknown };
    if (version !== TABLE_COLUMN_LAYOUT_STORAGE_VERSION) return null;
    if (!isTableColumnLayoutEntries(columns)) return null;
    return Object.freeze(
      columns.map(({ key, visible }) => Object.freeze({ key, visible })),
    );
  } catch {
    return null;
  }
}

export function readStoredTableColumnLayout(
  storage: TableColumnLayoutStorage | null,
  tableKey: TableColumnLayoutTableKey,
): readonly TableColumnLayoutEntry[] | null {
  if (storage === null) return null;
  try {
    return parseStoredTableColumnLayout(
      storage.getItem(tableColumnLayoutStorageKey(tableKey)),
    );
  } catch {
    return null;
  }
}

export function writeStoredTableColumnLayout(
  storage: TableColumnLayoutStorage | null,
  tableKey: TableColumnLayoutTableKey,
  entries: readonly TableColumnLayoutEntry[],
): void {
  if (storage === null) return;
  try {
    storage.setItem(
      tableColumnLayoutStorageKey(tableKey),
      serializeStoredTableColumnLayout(entries),
    );
  } catch {
    // Storage can be full or unavailable in privacy modes. The in-memory layout still applies.
  }
}

export function clearStoredTableColumnLayout(
  storage: TableColumnLayoutStorage | null,
  tableKey: TableColumnLayoutTableKey,
): void {
  if (storage === null) return;
  try {
    storage.removeItem(tableColumnLayoutStorageKey(tableKey));
  } catch {
    // Nothing to recover: the default layout applies when the entry is unreadable.
  }
}

export function browserSessionTableColumnLayoutStorage(): TableColumnLayoutStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

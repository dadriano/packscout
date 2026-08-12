import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";

interface ExpectedColumn {
  type: string;
  primaryKey: boolean;
  notNull: boolean;
  identity: string | null;
  default: unknown;
}

interface ExpectedIndex {
  columns: string[];
  unique: boolean;
  where: string | null;
}

interface ExpectedUniqueConstraint {
  columns: string[];
  nullsNotDistinct: boolean;
}

interface ExpectedForeignKey {
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
  onDelete: string;
  onUpdate: string;
}

interface ExpectedCheckConstraint {
  value: string;
}

interface ExpectedTable {
  columns: Record<string, ExpectedColumn>;
  indexes: Record<string, ExpectedIndex>;
  uniqueConstraints: Record<string, ExpectedUniqueConstraint>;
  foreignKeys: Record<string, ExpectedForeignKey>;
  checkConstraints: Record<string, ExpectedCheckConstraint>;
}

export interface SchemaParityManifest {
  source: string;
  target: { schema: string; migration: string };
  expectedCounts: {
    tables: number;
    enums: number;
    columns: number;
    indexes: number;
    uniqueConstraints: number;
    foreignKeys: number;
    checkConstraints: number;
  };
  nativeExtensions?: {
    foreignKeys: Record<string, ExpectedForeignKey & { table: string }>;
  };
  enums: Record<string, string[]>;
  tables: Record<string, ExpectedTable>;
}

interface CatalogColumn {
  table_name: string;
  column_name: string;
  data_type: string;
  not_null: boolean;
  identity: string;
  default_value: string | null;
}

interface CatalogConstraint {
  table_name: string;
  constraint_name: string;
  constraint_type: "c" | "f" | "p" | "u";
  columns: string[];
  referenced_table: string | null;
  referenced_columns: string[] | null;
  delete_action: string | null;
  update_action: string | null;
  definition: string;
  nulls_not_distinct: boolean | null;
}

interface CatalogIndex {
  table_name: string;
  index_name: string;
  unique: boolean;
  columns: string[];
  predicate: string | null;
}

const sortRecord = <T>(record: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));

const normalizeSql = (value: string | null): string | null => {
  if (value === null) return null;
  return value
    .replaceAll('"', "")
    .replaceAll("::text", "")
    .replace(/::[a-z_ ]+(\[\])?/g, "")
    .replace(/('[^']*')\.[a-z_][a-z0-9_]*/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/^\((.*)\)$/s, "$1")
    .trim()
    .toLowerCase();
};

const normalizeAction = (value: string | null): string => {
  const actions: Record<string, string> = {
    a: "no action",
    c: "cascade",
    d: "set default",
    n: "set null",
    r: "restrict",
  };
  return actions[value ?? ""] ?? value ?? "";
};

const normalizeDefault = (value: unknown): string | null => {
  if (value === null || value === undefined || value === "") return null;
  const jsonDefault = /^'(\{.*\})'::jsonb$/s.exec(String(value));
  if (jsonDefault) {
    const json = JSON.parse(jsonDefault[1]!) as Record<string, unknown>;
    return JSON.stringify(sortRecord(json));
  }
  const normalized = normalizeSql(String(value));
  return normalized;
};

export async function loadSchemaParityManifest(): Promise<SchemaParityManifest> {
  const contents = await readFile(new URL("./schema-parity-manifest.json", import.meta.url), "utf8");
  return JSON.parse(contents) as SchemaParityManifest;
}

export async function inspectSchema(db: Pick<Pool, "query">): Promise<SchemaParityManifest> {
  const [columns, constraints, indexes, enums] = await Promise.all([
    db.query<CatalogColumn>(`
      select
        table_class.relname as table_name,
        attribute.attname as column_name,
        format_type(attribute.atttypid, attribute.atttypmod) as data_type,
        attribute.attnotnull as not_null,
        attribute.attidentity as identity,
        pg_get_expr(default_value.adbin, default_value.adrelid) as default_value
      from pg_attribute attribute
      join pg_class table_class on table_class.oid = attribute.attrelid
      join pg_namespace table_schema on table_schema.oid = table_class.relnamespace
      left join pg_attrdef default_value
        on default_value.adrelid = attribute.attrelid
       and default_value.adnum = attribute.attnum
      where table_schema.nspname = 'public'
        and table_class.relkind = 'r'
        and table_class.relname <> '_prisma_migrations'
        and attribute.attnum > 0
        and not attribute.attisdropped
      order by table_class.relname, attribute.attnum
    `),
    db.query<CatalogConstraint>(`
      select
        table_class.relname as table_name,
        constraint_row.conname as constraint_name,
        constraint_row.contype as constraint_type,
        coalesce(array(
          select attribute.attname
          from unnest(constraint_row.conkey) with ordinality as key(attnum, position)
          join pg_attribute attribute
            on attribute.attrelid = constraint_row.conrelid
           and attribute.attnum = key.attnum
          order by key.position
        ), array[]::name[])::text[] as columns,
        referenced_table.relname as referenced_table,
        case when constraint_row.confkey is null then null else array(
          select attribute.attname
          from unnest(constraint_row.confkey) with ordinality as key(attnum, position)
          join pg_attribute attribute
            on attribute.attrelid = constraint_row.confrelid
           and attribute.attnum = key.attnum
          order by key.position
        )::text[] end as referenced_columns,
        constraint_row.confdeltype as delete_action,
        constraint_row.confupdtype as update_action,
        pg_get_constraintdef(constraint_row.oid, false) as definition,
        constraint_index.indnullsnotdistinct as nulls_not_distinct
      from pg_constraint constraint_row
      join pg_class table_class on table_class.oid = constraint_row.conrelid
      join pg_namespace table_schema on table_schema.oid = table_class.relnamespace
      left join pg_class referenced_table on referenced_table.oid = constraint_row.confrelid
      left join pg_index constraint_index on constraint_index.indexrelid = constraint_row.conindid
      where table_schema.nspname = 'public'
        and table_class.relname <> '_prisma_migrations'
      order by table_class.relname, constraint_row.conname
    `),
    db.query<CatalogIndex>(`
      select
        table_class.relname as table_name,
        index_class.relname as index_name,
        index_row.indisunique as unique,
        array(
          select pg_get_indexdef(index_row.indexrelid, position, false)
          from generate_series(1, index_row.indnkeyatts) position
          order by position
        ) as columns,
        pg_get_expr(index_row.indpred, index_row.indrelid) as predicate
      from pg_index index_row
      join pg_class table_class on table_class.oid = index_row.indrelid
      join pg_namespace table_schema on table_schema.oid = table_class.relnamespace
      join pg_class index_class on index_class.oid = index_row.indexrelid
      left join pg_constraint constraint_row on constraint_row.conindid = index_row.indexrelid
      where table_schema.nspname = 'public'
        and table_class.relkind = 'r'
        and table_class.relname <> '_prisma_migrations'
        and constraint_row.oid is null
      order by table_class.relname, index_class.relname
    `),
    db.query<{ enum_name: string; labels: string[] }>(`
      select enum_type.typname as enum_name,
             array_agg(enum_value.enumlabel order by enum_value.enumsortorder) as labels
      from pg_type enum_type
      join pg_namespace enum_schema on enum_schema.oid = enum_type.typnamespace
      join pg_enum enum_value on enum_value.enumtypid = enum_type.oid
      where enum_schema.nspname = 'public'
      group by enum_type.typname
      order by enum_type.typname
    `),
  ]);

  const tables: Record<string, ExpectedTable> = {};
  for (const column of columns.rows) {
    tables[column.table_name] ??= {
      columns: {}, indexes: {}, uniqueConstraints: {}, foreignKeys: {}, checkConstraints: {},
    };
    const primaryKey = constraints.rows.some(
      (constraint) => constraint.table_name === column.table_name
        && constraint.constraint_type === "p"
        && constraint.columns.includes(column.column_name),
    );
    tables[column.table_name]!.columns[column.column_name] = {
      type: column.data_type.replace(/^public\./, ""),
      primaryKey,
      notNull: column.not_null,
      identity: column.identity === "a" ? "always" : column.identity === "d" ? "byDefault" : null,
      default: column.default_value,
    };
  }

  for (const constraint of constraints.rows) {
    const table = tables[constraint.table_name]!;
    if (constraint.constraint_type === "u") {
      table.uniqueConstraints[constraint.constraint_name] = {
        columns: constraint.columns,
        nullsNotDistinct: constraint.nulls_not_distinct ?? false,
      };
    } else if (constraint.constraint_type === "f") {
      table.foreignKeys[constraint.constraint_name] = {
        columns: constraint.columns,
        referencedTable: constraint.referenced_table!,
        referencedColumns: constraint.referenced_columns!,
        onDelete: normalizeAction(constraint.delete_action),
        onUpdate: normalizeAction(constraint.update_action),
      };
    } else if (constraint.constraint_type === "c") {
      const match = /^CHECK \((.*)\)$/s.exec(constraint.definition);
      table.checkConstraints[constraint.constraint_name] = { value: match?.[1] ?? constraint.definition };
    }
  }

  for (const index of indexes.rows) {
    tables[index.table_name]!.indexes[index.index_name] = {
      columns: index.columns,
      unique: index.unique,
      where: index.predicate,
    };
  }

  for (const table of Object.values(tables)) {
    table.columns = sortRecord(table.columns);
    table.indexes = sortRecord(table.indexes);
    table.uniqueConstraints = sortRecord(table.uniqueConstraints);
    table.foreignKeys = sortRecord(table.foreignKeys);
    table.checkConstraints = sortRecord(table.checkConstraints);
  }

  const expectedCounts = {
    tables: Object.keys(tables).length,
    enums: enums.rows.length,
    columns: columns.rows.length,
    indexes: indexes.rows.length,
    uniqueConstraints: constraints.rows.filter(({ constraint_type }) => constraint_type === "u").length,
    foreignKeys: constraints.rows.filter(({ constraint_type }) => constraint_type === "f").length,
    checkConstraints: constraints.rows.filter(({ constraint_type }) => constraint_type === "c").length,
  };
  const parsedEnums = Object.fromEntries(enums.rows.map(({ enum_name, labels }) => [
    enum_name,
    Array.isArray(labels)
      ? labels
      : String(labels).slice(1, -1).split(","),
  ]));
  return {
    source: "database catalog",
    target: { schema: "database catalog", migration: "database catalog" },
    expectedCounts,
    enums: sortRecord(parsedEnums),
    tables: sortRecord(tables),
  };
}

export function assertSchemaParity(
  actual: SchemaParityManifest,
  expected: SchemaParityManifest,
): void {
  const expectedNativeForeignKeys = Object.keys(expected.nativeExtensions?.foreignKeys ?? {}).length;
  assert.deepEqual(
    actual.expectedCounts,
    { ...expected.expectedCounts, foreignKeys: expected.expectedCounts.foreignKeys + expectedNativeForeignKeys },
    "schema object counts drifted",
  );
  assert.deepEqual(actual.enums, expected.enums, "enum labels or ordering drifted");
  assert.deepEqual(Object.keys(actual.tables), Object.keys(expected.tables), "table inventory drifted");

  for (const [tableName, expectedTable] of Object.entries(expected.tables)) {
    const actualTable = actual.tables[tableName];
    assert.ok(actualTable, `missing table ${tableName}`);
    assert.deepEqual(Object.keys(actualTable.columns), Object.keys(expectedTable.columns), `${tableName} columns drifted`);
    for (const [columnName, expectedColumn] of Object.entries(expectedTable.columns)) {
      const actualColumn = actualTable.columns[columnName]!;
      assert.equal(actualColumn.type, expectedColumn.type, `${tableName}.${columnName} type drifted`);
      assert.equal(actualColumn.primaryKey, expectedColumn.primaryKey, `${tableName}.${columnName} primary key drifted`);
      assert.equal(actualColumn.notNull, expectedColumn.notNull, `${tableName}.${columnName} nullability drifted`);
      assert.equal(actualColumn.identity, expectedColumn.identity, `${tableName}.${columnName} identity drifted`);
      assert.equal(normalizeDefault(actualColumn.default), normalizeDefault(expectedColumn.default), `${tableName}.${columnName} default drifted`);
    }
    assert.deepEqual(actualTable.uniqueConstraints, expectedTable.uniqueConstraints, `${tableName} unique constraints drifted`);
    const nativeForeignKeys = Object.fromEntries(
      Object.entries(expected.nativeExtensions?.foreignKeys ?? {})
        .filter(([, foreignKey]) => foreignKey.table === tableName)
        .map(([name, foreignKey]) => [name, {
          columns: foreignKey.columns,
          referencedTable: foreignKey.referencedTable,
          referencedColumns: foreignKey.referencedColumns,
          onDelete: foreignKey.onDelete,
          onUpdate: foreignKey.onUpdate,
        }]),
    );
    assert.deepEqual(
      actualTable.foreignKeys,
      sortRecord({ ...expectedTable.foreignKeys, ...nativeForeignKeys }),
      `${tableName} foreign keys drifted`,
    );
    assert.deepEqual(
      Object.fromEntries(Object.entries(actualTable.indexes).map(([name, index]) => [name, { ...index, where: index.where === null ? null : "present" }])),
      Object.fromEntries(Object.entries(expectedTable.indexes).map(([name, index]) => [name, { ...index, where: index.where === null ? null : "present" }])),
      `${tableName} indexes drifted`,
    );
    assert.deepEqual(
      Object.keys(actualTable.checkConstraints),
      Object.keys(expectedTable.checkConstraints),
      `${tableName} check constraint inventory drifted`,
    );
  }
}

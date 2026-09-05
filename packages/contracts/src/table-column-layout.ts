import { z } from "zod";

/**
 * Tables whose column layout a viewer can personalize. The frontend and the
 * Convex store both validate against this vocabulary so an unknown table key
 * fails closed on every surface.
 */
export const TABLE_COLUMN_LAYOUT_TABLE_KEYS = ["all_repacks"] as const;

export type TableColumnLayoutTableKey =
  (typeof TABLE_COLUMN_LAYOUT_TABLE_KEYS)[number];

export const MAX_TABLE_COLUMN_LAYOUT_ENTRIES = 64;

export const TABLE_COLUMN_KEY_PATTERN = /^[a-z][A-Za-z0-9]{0,63}$/;

export type TableColumnLayoutEntry = Readonly<{
  key: string;
  visible: boolean;
}>;

export const tableColumnLayoutTableKeySchema = z.enum(
  TABLE_COLUMN_LAYOUT_TABLE_KEYS,
);

export const tableColumnLayoutEntrySchema = z.strictObject({
  key: z.string().regex(TABLE_COLUMN_KEY_PATTERN),
  visible: z.boolean(),
});

export const tableColumnLayoutEntriesSchema = z
  .array(tableColumnLayoutEntrySchema)
  .min(1)
  .max(MAX_TABLE_COLUMN_LAYOUT_ENTRIES)
  .refine(
    (entries) => new Set(entries.map(({ key }) => key)).size === entries.length,
    { message: "Column keys must be unique." },
  );

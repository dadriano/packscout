import {
  tableColumnLayoutEntriesSchema,
  type TableColumnLayoutTableKey,
} from "@packscout/contracts";
import { ConvexError, v } from "convex/values";
import { mutation, query, type MutationCtx } from "./_generated/server";
import {
  PRODUCT_USER_READ_CAPABILITY,
  PRODUCT_USER_WRITE_CAPABILITY,
  requireAdmittedProductUser,
} from "./productUserCapabilityGate";

/**
 * Per-account table column layouts: which columns a signed-in viewer shows
 * and in what order, one document per table key. Ownership is the verified
 * token identifier the capability gate returns; the browser never names an
 * owner. A layout is personal display state, so a refused read costs the
 * viewer nothing but the account copy — the frontend keeps a tab-scoped
 * layout instead.
 */

const MAX_TABLE_LAYOUTS_PER_OWNER = 16;

/**
 * Codes this module raises itself. Authentication and admission refusals —
 * `AUTH_REQUIRED`, `AUTH_IDENTITY_INVALID`, the closed-beta reason codes,
 * and `ACCOUNT_SUSPENDED` — are raised by the shared capability gate every
 * entry point here passes through before touching any layout state.
 */
type TableColumnLayoutsErrorCode =
  | "INVALID_TABLE_COLUMN_LAYOUT"
  | "TABLE_COLUMN_LAYOUT_STATE_CONFLICT";

// Extend this union alongside TABLE_COLUMN_LAYOUT_TABLE_KEYS; the test suite
// asserts every contract key is accepted here.
const tableKeyValidator = v.literal(
  "all_repacks" satisfies TableColumnLayoutTableKey,
);

const columnsValidator = v.array(
  v.object({ key: v.string(), visible: v.boolean() }),
);

function refuse(code: TableColumnLayoutsErrorCode): never {
  throw new ConvexError({
    code,
    message:
      code === "INVALID_TABLE_COLUMN_LAYOUT"
        ? "The table column layout is invalid."
        : "The table layout state is inconsistent.",
  });
}

async function ownerLayoutForTable(
  ctx: MutationCtx,
  ownerTokenIdentifier: string,
  tableKey: TableColumnLayoutTableKey,
) {
  const matches = await ctx.db
    .query("tableColumnLayouts")
    .withIndex("by_owner_token_identifier_and_table_key", (index) =>
      index
        .eq("ownerTokenIdentifier", ownerTokenIdentifier)
        .eq("tableKey", tableKey),
    )
    .take(2);
  if (matches.length > 1) refuse("TABLE_COLUMN_LAYOUT_STATE_CONFLICT");
  return matches[0] ?? null;
}

export const getTableColumnLayouts = query({
  args: {},
  returns: v.array(v.object({ tableKey: v.string(), columns: columnsValidator })),
  handler: async (ctx) => {
    const ownerTokenIdentifier = await requireAdmittedProductUser(
      ctx,
      PRODUCT_USER_READ_CAPABILITY,
    );
    const layouts = await ctx.db
      .query("tableColumnLayouts")
      .withIndex("by_owner_token_identifier_and_table_key", (index) =>
        index.eq("ownerTokenIdentifier", ownerTokenIdentifier),
      )
      .take(MAX_TABLE_LAYOUTS_PER_OWNER + 1);
    if (layouts.length > MAX_TABLE_LAYOUTS_PER_OWNER) {
      refuse("TABLE_COLUMN_LAYOUT_STATE_CONFLICT");
    }
    return layouts.map(({ tableKey, columns }) => ({ tableKey, columns }));
  },
});

export const setTableColumnLayout = mutation({
  args: { tableKey: tableKeyValidator, columns: columnsValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerTokenIdentifier = await requireAdmittedProductUser(
      ctx,
      PRODUCT_USER_WRITE_CAPABILITY,
    );
    const parsed = tableColumnLayoutEntriesSchema.safeParse(args.columns);
    if (!parsed.success) refuse("INVALID_TABLE_COLUMN_LAYOUT");
    const columns = parsed.data.map(({ key, visible }) => ({ key, visible }));
    const existing = await ownerLayoutForTable(
      ctx,
      ownerTokenIdentifier,
      args.tableKey,
    );
    if (existing === null) {
      await ctx.db.insert("tableColumnLayouts", {
        ownerTokenIdentifier,
        tableKey: args.tableKey,
        columns,
      });
    } else {
      await ctx.db.patch("tableColumnLayouts", existing._id, { columns });
    }
    return null;
  },
});

export const clearTableColumnLayout = mutation({
  args: { tableKey: tableKeyValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerTokenIdentifier = await requireAdmittedProductUser(
      ctx,
      PRODUCT_USER_WRITE_CAPABILITY,
    );
    const existing = await ownerLayoutForTable(
      ctx,
      ownerTokenIdentifier,
      args.tableKey,
    );
    if (existing !== null) {
      await ctx.db.delete("tableColumnLayouts", existing._id);
    }
    return null;
  },
});

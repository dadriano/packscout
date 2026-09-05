/// <reference types="vite/client" />

import {
  MAX_TABLE_COLUMN_LAYOUT_ENTRIES,
  TABLE_COLUMN_LAYOUT_TABLE_KEYS,
} from "@packscout/contracts";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { PRODUCT_USER_CAPABILITY_REFUSAL_CODES } from "./productUserCapabilityGate";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const USER_A = {
  subject: "did:privy:user-a",
  issuer: "privy.io",
  tokenIdentifier: "privy.io|did:privy:user-a",
};
const USER_B = {
  subject: "did:privy:user-b",
  issuer: "privy.io",
  tokenIdentifier: "privy.io|did:privy:user-b",
};

const LAYOUT = [
  { key: "repack", visible: true },
  { key: "evDollars", visible: true },
  { key: "vendor", visible: false },
];

function createTest() {
  return convexTest({ schema, modules, transactionLimits: true });
}

async function expectErrorCode(
  operation: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await operation;
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toMatchObject({ data: { code } });
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("account table column layouts", () => {
  test("rejects every unauthenticated read and write", async () => {
    const t = createTest();
    await expectErrorCode(
      t.query(api.tableColumnLayouts.getTableColumnLayouts, {}),
      "AUTH_REQUIRED",
    );
    await expectErrorCode(
      t.mutation(api.tableColumnLayouts.setTableColumnLayout, {
        tableKey: "all_repacks",
        columns: LAYOUT,
      }),
      "AUTH_REQUIRED",
    );
    await expectErrorCode(
      t.mutation(api.tableColumnLayouts.clearTableColumnLayout, {
        tableKey: "all_repacks",
      }),
      "AUTH_REQUIRED",
    );
  });

  test("an account the closed beta has not admitted is refused before any layout state changes", async () => {
    vi.stubEnv("PACKSCOUT_CLOSED_BETA", "1");
    const t = createTest();
    const held = t.withIdentity(USER_A);
    const code = PRODUCT_USER_CAPABILITY_REFUSAL_CODES.awaiting_review;
    await expectErrorCode(
      held.query(api.tableColumnLayouts.getTableColumnLayouts, {}),
      code,
    );
    await expectErrorCode(
      held.mutation(api.tableColumnLayouts.setTableColumnLayout, {
        tableKey: "all_repacks",
        columns: LAYOUT,
      }),
      code,
    );
    await expectErrorCode(
      held.mutation(api.tableColumnLayouts.clearTableColumnLayout, {
        tableKey: "all_repacks",
      }),
      code,
    );
    expect(
      await t.run((ctx) => ctx.db.query("tableColumnLayouts").collect()),
    ).toEqual([]);
  });

  test("scopes layouts to the authenticated token identifier", async () => {
    const t = createTest();
    const userA = t.withIdentity(USER_A);
    const userB = t.withIdentity(USER_B);

    await userA.mutation(api.tableColumnLayouts.setTableColumnLayout, {
      tableKey: "all_repacks",
      columns: LAYOUT,
    });

    expect(
      await userA.query(api.tableColumnLayouts.getTableColumnLayouts, {}),
    ).toEqual([{ tableKey: "all_repacks", columns: LAYOUT }]);
    expect(
      await userB.query(api.tableColumnLayouts.getTableColumnLayouts, {}),
    ).toEqual([]);

    await userB.mutation(api.tableColumnLayouts.clearTableColumnLayout, {
      tableKey: "all_repacks",
    });
    expect(
      await userA.query(api.tableColumnLayouts.getTableColumnLayouts, {}),
    ).toEqual([{ tableKey: "all_repacks", columns: LAYOUT }]);
  });

  test("replaces the stored layout in place and clears it back to the default", async () => {
    const t = createTest();
    const userA = t.withIdentity(USER_A);
    const replacement = [
      { key: "evPercent", visible: true },
      { key: "repack", visible: true },
    ];

    await userA.mutation(api.tableColumnLayouts.setTableColumnLayout, {
      tableKey: "all_repacks",
      columns: LAYOUT,
    });
    await userA.mutation(api.tableColumnLayouts.setTableColumnLayout, {
      tableKey: "all_repacks",
      columns: replacement,
    });

    expect(
      await userA.query(api.tableColumnLayouts.getTableColumnLayouts, {}),
    ).toEqual([{ tableKey: "all_repacks", columns: replacement }]);
    expect(
      await t.run((ctx) => ctx.db.query("tableColumnLayouts").collect()),
    ).toHaveLength(1);

    await userA.mutation(api.tableColumnLayouts.clearTableColumnLayout, {
      tableKey: "all_repacks",
    });
    await userA.mutation(api.tableColumnLayouts.clearTableColumnLayout, {
      tableKey: "all_repacks",
    });
    expect(
      await userA.query(api.tableColumnLayouts.getTableColumnLayouts, {}),
    ).toEqual([]);
    expect(
      await t.run((ctx) => ctx.db.query("tableColumnLayouts").collect()),
    ).toEqual([]);
  });

  test("fails closed on malformed layouts and unknown tables", async () => {
    const t = createTest();
    const userA = t.withIdentity(USER_A);
    const invalidLayouts: unknown[] = [
      [],
      [{ key: "repack", visible: true }, { key: "repack", visible: false }],
      [{ key: "Repack", visible: true }],
      [{ key: "repack price", visible: true }],
      Array.from({ length: MAX_TABLE_COLUMN_LAYOUT_ENTRIES + 1 }, (_, index) => ({
        key: `column${index}`,
        visible: true,
      })),
    ];
    for (const columns of invalidLayouts) {
      await expectErrorCode(
        userA.mutation(api.tableColumnLayouts.setTableColumnLayout, {
          tableKey: "all_repacks",
          columns: columns as typeof LAYOUT,
        }),
        "INVALID_TABLE_COLUMN_LAYOUT",
      );
    }
    await expect(
      userA.mutation(api.tableColumnLayouts.setTableColumnLayout, {
        tableKey: "overview" as "all_repacks",
        columns: LAYOUT,
      }),
    ).rejects.toThrow();
    expect(
      await userA.query(api.tableColumnLayouts.getTableColumnLayouts, {}),
    ).toEqual([]);
  });

  test("accepts every table key in the shared contract vocabulary", async () => {
    const t = createTest();
    const userA = t.withIdentity(USER_A);
    for (const tableKey of TABLE_COLUMN_LAYOUT_TABLE_KEYS) {
      await userA.mutation(api.tableColumnLayouts.setTableColumnLayout, {
        tableKey,
        columns: LAYOUT,
      });
    }
    expect(
      (await userA.query(api.tableColumnLayouts.getTableColumnLayouts, {}))
        .map(({ tableKey }) => tableKey)
        .sort(),
    ).toEqual([...TABLE_COLUMN_LAYOUT_TABLE_KEYS].sort());
  });
});

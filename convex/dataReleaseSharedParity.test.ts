import {
  canonicalJson as sharedCanonicalJson,
  productionReceiptSchema,
  repackSearchRowFromDetail as sharedSearchRow,
  repackSearchRowSchema,
  sha256CanonicalJson as sharedSha256,
} from "@packscout/contracts";
import { describe, expect, test } from "vitest";
import {
  canonicalJson as convexCanonicalJson,
  sha256CanonicalJson as convexSha256,
} from "./dataReleaseCanonicalHash";
import { buildMockDataReleaseV2 } from "./mockDataReleaseFixture";
import {
  isValidRepackSearchRow,
  searchRowFromRepackDetail as convexSearchRow,
} from "./publicRepackValidation";

describe("runtime-neutral data release primitives", () => {
  test("Convex and Node-facing canonical hashes are byte-identical", async () => {
    const value = { z: [3, { b: true, a: "value" }], a: 1 };
    expect(convexCanonicalJson(value)).toBe(sharedCanonicalJson(value));
    await expect(convexSha256("packscout.parity.v1", value)).resolves.toBe(
      await sharedSha256("packscout.parity.v1", value),
    );
  });

  test("Convex search rows use the shared release projection exactly", () => {
    const detail = buildMockDataReleaseV2().repacks[0]!;
    expect(convexCanonicalJson(convexSearchRow(detail))).toBe(
      sharedCanonicalJson(sharedSearchRow(detail)),
    );
  });

  test("strict shared schemas reject invalid receipts and search rows", () => {
    const row = sharedSearchRow(buildMockDataReleaseV2().repacks[0]!);
    const invalidRow = { ...row, rawPayload: "protected" };
    expect(repackSearchRowSchema.safeParse(invalidRow).success).toBe(false);
    expect(isValidRepackSearchRow(invalidRow)).toBe(false);
    expect(productionReceiptSchema.safeParse({
      operationKind: "start",
      terminalState: "complete",
      result: "arbitrary",
    }).success).toBe(false);
  });
});

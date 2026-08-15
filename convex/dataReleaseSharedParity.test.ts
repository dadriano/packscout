import {
  canonicalJson as sharedCanonicalJson,
  productionReceiptSchema,
  recomputeProductionBatchHash as sharedBatchHash,
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
import { recomputeProductionBatchHash as convexBatchHash } from "./productionDataReleaseProtocol";
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

  test("full transport requests hash only canonical batch content", async () => {
    const request = {
      schemaVersion: "data_release_v2",
      operationId: "apply:release:0",
      idempotencyKey: "apply:release:0",
      publicationId: "50000000-0000-4000-8000-000000000001",
      batchIndex: 0,
      kind: "vendors",
      batchHash: "a".repeat(64),
      records: [{ publicVendorId: "vendor-1", name: "Vendor One" }],
    } as const;
    await expect(convexBatchHash(request)).resolves.toBe(
      await sharedBatchHash({ kind: request.kind, records: request.records }),
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

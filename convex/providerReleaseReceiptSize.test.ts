import { MAX_PROVIDER_RELEASE_RECEIPT_BYTES } from "@packscout/contracts";
import { describe, expect, test } from "vitest";
import { providerReleaseReceiptJsonFitsStorageLimit } from "./providerReleaseOperations";

describe("provider release receipt storage bound", () => {
  test("accepts the exact UTF-8 byte limit and rejects one byte over", () => {
    const exactLimit = "é".repeat(MAX_PROVIDER_RELEASE_RECEIPT_BYTES / 2);

    expect(providerReleaseReceiptJsonFitsStorageLimit(exactLimit)).toBe(true);
    expect(providerReleaseReceiptJsonFitsStorageLimit(`${exactLimit}x`)).toBe(
      false,
    );
  });
});

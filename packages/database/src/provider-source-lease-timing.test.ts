import assert from "node:assert/strict";
import { test } from "node:test";
import {
  providerSourceControlPlaneRetry,
  providerSourceSingletonTiming,
} from "@packscout/contracts";
import { PACKSCOUT_TRANSACTION_OPTIONS } from "./database.ts";

test("source ownership lease outlives a locked page transaction and recovery margin", () => {
  const leaseMilliseconds = providerSourceSingletonTiming.leaseSeconds * 1_000;
  const recoveryMarginMilliseconds =
    providerSourceSingletonTiming.maximumRenewalIntervalSeconds * 2 * 1_000 +
    providerSourceControlPlaneRetry.wallClockLimitMilliseconds;

  assert.ok(
    leaseMilliseconds >
      PACKSCOUT_TRANSACTION_OPTIONS.timeout + recoveryMarginMilliseconds,
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderManualImportExecutor } from "./provider-manual-import-executor.ts";
import { providerManualImportExecutionBudget, providerManualImportLeaseMilliseconds } from
  "./provider-manual-import-execution-budget.ts";
import type { ProviderPrismaClient } from "@packscout/database";

test("remote atomic pages have finite nested deadlines within their lease; local budgets remain unchanged", () => {
  assert.deepEqual(providerManualImportExecutionBudget(), {
    transactionMilliseconds: 30_000, pageMilliseconds: 55_000,
    gatewayMilliseconds: 60_000, leaseMilliseconds: 300_000,
  });
  const remote = providerManualImportExecutionBudget("remote");
  assert.equal(remote.transactionMilliseconds, 480_000);
  assert.equal(remote.pageMilliseconds - remote.transactionMilliseconds, 60_000);
  assert.equal(remote.gatewayMilliseconds - remote.pageMilliseconds, 60_000);
  assert.equal(remote.leaseMilliseconds - remote.gatewayMilliseconds, 300_000);
  assert.equal(providerManualImportLeaseMilliseconds("remote"), 900_000);
  assert.equal(providerManualImportLeaseMilliseconds("remote", 660_000), 660_000);
});

test("invalid execution modes and leases cannot admit an executor or begin database work", () => {
  const database = new Proxy({}, { get() { assert.fail("Invalid admission cannot access the database."); } }) as ProviderPrismaClient;
  const source = { supports: () => true, nextPage: async () => assert.fail("No source call is allowed.") };
  for (const leaseMilliseconds of [30_000, 300_000, 659_999, 900_001, Number.NaN, 900_000.1]) {
    assert.throws(() => new ProviderManualImportExecutor({ database, source, workerId: "worker",
      executionMode: "remote", leaseMilliseconds }), /lease duration is invalid/u);
  }
  assert.throws(() => new ProviderManualImportExecutor({ database, source, workerId: "worker",
    executionMode: "unknown" as "remote" }), /execution mode is invalid/u);
  assert.equal(providerManualImportLeaseMilliseconds("local", 30_000), 30_000);
});

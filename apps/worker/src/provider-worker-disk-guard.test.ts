import assert from "node:assert/strict";
import { test } from "node:test";
import { PROVIDER_IMPORT_MAXIMUM_PAGE_STORAGE_BYTES } from "@packscout/services";
import { ProviderWorkerDiskGuard } from "./provider-worker-disk-guard.ts";

test("disk guard reserves one worst-case provider page in addition to the free-space floor", async () => {
  const reserve = 20 * 1024 * 1024 * 1024;
  const required = BigInt(reserve + PROVIDER_IMPORT_MAXIMUM_PAGE_STORAGE_BYTES);
  const samples = [required, required - 1n];
  const guard = new ProviderWorkerDiskGuard(
    {
      async freeBytes() {
        return samples.shift()!;
      },
    },
    reserve,
  );

  assert.equal(await guard.canStartPage(), true);
  assert.equal(await guard.canStartPage(), false);
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createMembershipHarness, postgresBinDirectory } from "./provider-pack-content-snapshot.test-support.ts";

test("a disposable membership database releases its setup backend before provider work and repeated shutdown", async context => {
  const bin = await postgresBinDirectory();
  if (bin === null) { context.skip("PostgreSQL is required for a socket-only membership database."); return; }
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const harness = await createMembershipHarness(bin, randomUUID());
    try {
      const [state] = await harness.client.$queryRaw<Array<{ setup_backends: bigint; provider_backends: bigint }>>`
        SELECT count(*) FILTER (WHERE datname = 'postgres') AS setup_backends,
               count(*) FILTER (WHERE datname = current_database()) AS provider_backends
        FROM pg_stat_activity WHERE backend_type = 'client backend'
      `;
      assert.equal(state?.setup_backends, 0n,
        "The setup session must finish before exposing a provider database that can be stopped.");
      assert.ok(state && state.provider_backends >= 1n);
      const category = await harness.repository.upsertCategory({ categoryKey: "synthetic-ready",
        parentCategoryId: null, displayName: "Synthetic ready" });
      assert.equal((await harness.client.categories.findUniqueOrThrow({ where: { id: category.id } })).display_name, "Synthetic ready");
      assert.equal(await harness.client.promotion_changes.count(), 1);
    } finally { await harness.close(); }
  }
});

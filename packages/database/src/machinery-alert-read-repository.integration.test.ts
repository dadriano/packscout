import assert from "node:assert/strict";
import { test } from "node:test";
import { PrismaMachineryAlertReadRepository } from "./machinery-alert-read-repository.ts";
import { PipelineSetupRepository } from "./setup-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

/**
 * One alerting cycle must stay a bounded unit of work, but a bound that always
 * begins at the oldest workspace is not a bound — it is a cut-off. Everything
 * past the page size would never be evaluated for a worker, backlog, schedule,
 * or retention condition at all.
 */

const createdAt = new Date("2026-08-20T12:00:00.000Z");
const PAGE_LIMIT = 50;
const WORKSPACES = 60;

test("workspaces past the first page are reached on a later cycle", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const setup = new PipelineSetupRepository(harness.database);
    const created: string[] = [];
    for (let index = 0; index < WORKSPACES; index += 1) {
      created.push(
        await setup.createOrganization({
          slug: `rotation-${String(index).padStart(3, "0")}`,
          name: `Rotation ${index}`,
          // Distinct creation instants keep the keyset order deterministic.
          createdAt: new Date(createdAt.getTime() + index * 1_000),
        }),
      );
    }

    const repository = new PrismaMachineryAlertReadRepository(harness.database);
    const first = await repository.listOrganizations({ limit: PAGE_LIMIT });
    const second = await repository.listOrganizations({ limit: PAGE_LIMIT });

    // Each cycle stays bounded, and one cycle never evaluates a workspace twice.
    assert.equal(first.length, PAGE_LIMIT);
    assert.equal(second.length, PAGE_LIMIT);
    assert.equal(new Set(second).size, PAGE_LIMIT);
    // The second cycle resumes where the first stopped rather than repeating it.
    assert.deepEqual(second.slice(0, WORKSPACES - PAGE_LIMIT), created.slice(PAGE_LIMIT));
    // Every workspace has been evaluated, not just the oldest page of them.
    assert.equal(new Set([...first, ...second]).size, WORKSPACES);
  } finally {
    await harness.close();
  }
});

test("the rotation wraps back to the oldest workspace once the tail runs out", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const setup = new PipelineSetupRepository(harness.database);
    const created: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      created.push(
        await setup.createOrganization({
          slug: `wrap-${index}`,
          name: `Wrap ${index}`,
          createdAt: new Date(createdAt.getTime() + index * 1_000),
        }),
      );
    }

    const repository = new PrismaMachineryAlertReadRepository(harness.database);
    const first = await repository.listOrganizations({ limit: PAGE_LIMIT });
    const second = await repository.listOrganizations({ limit: PAGE_LIMIT });

    // A workspace count below the page size means every cycle still evaluates
    // all of them, each exactly once.
    assert.deepEqual([...first], created);
    assert.deepEqual([...second].sort(), [...created].sort());
    assert.equal(new Set(second).size, created.length);
  } finally {
    await harness.close();
  }
});

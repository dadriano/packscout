import assert from "node:assert/strict";
import { test } from "node:test";
import { createPrismaClientLifecycle } from "./database.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

test("Prisma lifecycle starts once, commits, rolls back, and closes idempotently", async () => {
  const harness = await createMigratedTestDatabase();
  const lifecycle = harness.createClientLifecycle();
  try {
    await Promise.all([lifecycle.start(), lifecycle.start()]);
    assert.equal(await lifecycle.client.organizations.count(), 0);

    await assert.rejects(
      lifecycle.transaction(async (transaction) => {
        await transaction.organizations.create({
          data: { slug: "rolled-back", name: "Rolled Back" },
        });
        throw new Error("rollback sentinel");
      }),
      /rollback sentinel/,
    );
    assert.equal(await lifecycle.client.organizations.count(), 0);

    const id = await lifecycle.transaction(async (transaction) => {
      const organization = await transaction.organizations.create({
        data: { slug: "committed", name: "Committed" },
        select: { id: true },
      });
      return organization.id;
    });
    assert.equal(
      await lifecycle.client.organizations.count({ where: { id } }),
      1,
    );

    await Promise.all([lifecycle.close(), lifecycle.close()]);
    await assert.rejects(lifecycle.start(), /lifecycle is closed/);
  } finally {
    await lifecycle.close();
    await harness.close();
  }
});

test("test harness uses independent PostgreSQL sessions and count-only instrumentation", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const second = await harness.createIndependentClient();
    const [firstPid] = await harness.client.$queryRaw<Array<{ pid: number }>>`
      select pg_backend_pid()::integer as pid
    `;
    const [secondPid] = await second.$queryRaw<Array<{ pid: number }>>`
      select pg_backend_pid()::integer as pid
    `;
    assert.ok(firstPid);
    assert.ok(secondPid);
    assert.notEqual(firstPid.pid, secondPid.pid);
    assert.ok(harness.statementCounter.count >= 2);
    harness.statementCounter.reset();
    assert.equal(harness.statementCounter.count, 0);

    const release = deferred();
    const locked = deferred();
    const owner = harness.client.$transaction(async (transaction) => {
      await transaction.$executeRaw`select pg_advisory_xact_lock(424242)`;
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const contender = await second.$queryRaw<Array<{ acquired: boolean }>>`
      select pg_try_advisory_xact_lock(424242) as acquired
    `;
    assert.equal(contender[0]?.acquired, false);
    release.resolve();
    await owner;
  } finally {
    await harness.close();
  }
});

test("startup failures are stable and do not expose connection details", async () => {
  const lifecycle = createPrismaClientLifecycle({
    databaseUrl:
      "postgresql://secret-user:secret-password@127.0.0.1:1/secret-database?connect_timeout=1",
  });
  try {
    await assert.rejects(
      lifecycle.start(),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "PackScout database connection failed.");
        assert.doesNotMatch(error.message, /secret|password|127\.0\.0\.1/);
        return true;
      },
    );
  } finally {
    await lifecycle.close();
  }
});

/**
 * Migrations that must each independently gate startup.
 *
 * The buyback-adjusted EV migration sits between two of the migrations the
 * readiness pins already covered, and every one of them is checked on its own:
 * corrupting them as a group would still pass if a pin were silently dropped,
 * so a pin that stops being enforced has to fail here rather than hide behind a
 * sibling that still fails closed.
 */
const PINNED_MIGRATIONS = [
  "20260819010000_buyback_ev_revisions",
  "20260824223000_fix_normalized_text_vertical_tab",
  "20260825041000_raise_provider_source_raw_response_limit",
] as const;

test("startup fails closed when an expected Prisma migration is not ready", async () => {
  for (const migrationName of PINNED_MIGRATIONS) {
    const harness = await createMigratedTestDatabase();
    try {
      await harness.client.$executeRaw`
        delete from public."_prisma_migrations"
        where migration_name = ${migrationName}
      `;
      const lifecycle = harness.createClientLifecycle();
      try {
        await assert.rejects(
          lifecycle.start(),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(error.message, "PackScout database schema is not ready.");
            return true;
          },
          `a missing ${migrationName} row must fail startup closed`,
        );
      } finally {
        await lifecycle.close();
      }
    } finally {
      await harness.close();
    }
  }
});

test("startup fails closed when an expected migration checksum is inconsistent", async () => {
  for (const migrationName of PINNED_MIGRATIONS) {
    const harness = await createMigratedTestDatabase();
    try {
      await harness.client.$executeRaw`
        update public."_prisma_migrations"
        set checksum = ${"0".repeat(64)}
        where migration_name = ${migrationName}
      `;
      const lifecycle = harness.createClientLifecycle();
      try {
        await assert.rejects(
          lifecycle.start(),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(error.message, "PackScout database schema is not ready.");
            return true;
          },
          `a rewritten ${migrationName} checksum must fail startup closed`,
        );
      } finally {
        await lifecycle.close();
      }
    } finally {
      await harness.close();
    }
  }
});

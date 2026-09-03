import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CENTRAL_SCHEMA_VERSION, centralDatabaseTarget } from "./database-topology.ts";
import {
  DatabaseUnavailableError,
  createRoleAwareDatabaseLifecycle,
} from "./role-aware-database.ts";

interface FakeTransaction {
  readonly marker: "transaction";
}

function fakeClient(overrides: {
  connectError?: Error;
  queryRows?: unknown[];
} = {}) {
  let connectCount = 0;
  let disconnectCount = 0;
  let transactionCount = 0;
  const client = {
    async $connect() {
      connectCount += 1;
      if (overrides.connectError) throw overrides.connectError;
    },
    async $disconnect() {
      disconnectCount += 1;
    },
    async $queryRawUnsafe<T>(): Promise<T> {
      return (overrides.queryRows ?? [{
        databaseName: "packscout",
        databaseRole: "central",
        schemaVersion: CENTRAL_SCHEMA_VERSION,
        providerId: null,
        providerKey: null,
      }]) as T;
    },
    async $transaction<T>(
      callback: (transaction: FakeTransaction) => Promise<T>,
    ): Promise<T> {
      transactionCount += 1;
      return callback({ marker: "transaction" });
    },
  };
  return {
    client,
    counts: {
      get connect() {
        return connectCount;
      },
      get disconnect() {
        return disconnectCount;
      },
      get transaction() {
        return transactionCount;
      },
    },
  };
}

describe("role-aware database lifecycle", () => {
  test("starts once, verifies identity, transacts, and closes idempotently", async () => {
    const fake = fakeClient();
    const lifecycle = createRoleAwareDatabaseLifecycle<typeof fake.client, FakeTransaction>({
      client: fake.client,
      target: centralDatabaseTarget(),
    });
    await Promise.all([lifecycle.start(), lifecycle.start()]);
    assert.equal(fake.counts.connect, 1);
    assert.equal(
      await lifecycle.transaction(async (transaction) => transaction.marker),
      "transaction",
    );
    assert.equal(fake.counts.transaction, 1);
    await Promise.all([lifecycle.close(), lifecycle.close()]);
    assert.equal(fake.counts.disconnect, 1);
    await assert.rejects(lifecycle.start(), /lifecycle is closed/);
  });

  test("returns stable sanitized readiness for connection failure", async () => {
    const fake = fakeClient({
      connectError: new Error("postgresql://secret@db.internal/packscout"),
    });
    const lifecycle = createRoleAwareDatabaseLifecycle<typeof fake.client, FakeTransaction>({
      client: fake.client,
      target: centralDatabaseTarget(),
      now: () => new Date("2026-08-29T02:00:00.000Z"),
    });
    const readiness = await lifecycle.readiness();
    assert.equal(readiness.state, "unavailable");
    if (readiness.state === "unavailable") {
      assert.equal(readiness.failureCode, "DATABASE_UNREACHABLE");
    }
    assert.doesNotMatch(JSON.stringify(readiness), /secret|db\.internal|postgresql/);
    await lifecycle.close();
  });

  test("fails start closed for a role or schema mismatch without raw details", async () => {
    const fake = fakeClient({
      queryRows: [{
        databaseName: "packscout",
        databaseRole: "provider",
        schemaVersion: "wrong",
        providerId: "79ad49f7-94a3-4fb9-a03e-58506e802c62",
        providerKey: "beezie",
      }],
    });
    const lifecycle = createRoleAwareDatabaseLifecycle<typeof fake.client, FakeTransaction>({
      client: fake.client,
      target: centralDatabaseTarget(),
    });
    await assert.rejects(
      lifecycle.start(),
      (error: unknown) => {
        assert.ok(error instanceof DatabaseUnavailableError);
        assert.equal(error.code, "DATABASE_ROLE_MISMATCH");
        assert.doesNotMatch(error.message, /beezie|wrong|79ad49f7/);
        return true;
      },
    );
    await lifecycle.close();
  });
});

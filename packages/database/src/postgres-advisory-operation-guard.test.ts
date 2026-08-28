import assert from "node:assert/strict";
import { test } from "node:test";
import {
  runWithPostgresAdvisoryOperationGuard,
  type PostgresAdvisoryOperationGuardClient,
  type PostgresAdvisoryOperationGuardDependencies,
} from "./postgres-advisory-operation-guard.ts";

const connectionString =
  "postgresql://private-user:private-password@database.test/packscout";
const lockName = "packscout:test:operation:v1";

interface RecordedQuery {
  readonly statement: string;
  readonly values: readonly string[];
}

class RecordingClient implements PostgresAdvisoryOperationGuardClient {
  readonly events: string[] = [];
  readonly queries: RecordedQuery[] = [];
  acquire = true;
  release = true;
  connectError: Error | undefined;
  acquireError: Error | undefined;
  releaseError: Error | undefined;
  endError: Error | undefined;

  async connect(): Promise<void> {
    this.events.push("connect");
    if (this.connectError) throw this.connectError;
  }

  async query(
    statement: string,
    values: readonly string[],
  ): Promise<{ rows: readonly Readonly<Record<string, unknown>>[] }> {
    const acquisition = statement.includes("pg_try_advisory_lock");
    this.events.push(acquisition ? "acquire" : "release");
    this.queries.push({ statement, values: [...values] });
    if (acquisition && this.acquireError) throw this.acquireError;
    if (!acquisition && this.releaseError) throw this.releaseError;
    return acquisition
      ? { rows: [{ acquired: this.acquire }] }
      : { rows: [{ released: this.release }] };
  }

  async end(): Promise<void> {
    this.events.push("end");
    if (this.endError) throw this.endError;
  }
}

function dependenciesFor(
  client: RecordingClient,
  observedConnectionStrings: string[] = [],
): PostgresAdvisoryOperationGuardDependencies {
  return {
    createClient(input) {
      observedConnectionStrings.push(input.connectionString);
      return client;
    },
  };
}

test("guard executes under one parameterized session lock and releases it", async () => {
  const client = new RecordingClient();
  const observedConnectionStrings: string[] = [];
  const input = { unpooledConnectionString: connectionString, lockName };

  const result = await runWithPostgresAdvisoryOperationGuard(
    input,
    () => {
      client.events.push("operation");
      input.lockName = "mutated-after-acquisition";
      return { cycle: 7 };
    },
    dependenciesFor(client, observedConnectionStrings),
  );

  assert.deepEqual(result, { status: "executed", value: { cycle: 7 } });
  assert.deepEqual(client.events, [
    "connect",
    "acquire",
    "operation",
    "release",
    "end",
  ]);
  assert.deepEqual(observedConnectionStrings, [connectionString]);
  assert.equal(client.queries.length, 2);
  for (const query of client.queries) {
    assert.match(query.statement, /hashtextextended\(\$1::text, 0\)/u);
    assert.doesNotMatch(query.statement, /packscout:test/u);
    assert.doesNotMatch(query.statement, /private-password/u);
    assert.deepEqual(query.values, [lockName]);
  }
  assert.match(client.queries[0]!.statement, /pg_try_advisory_lock/u);
  assert.match(client.queries[1]!.statement, /pg_advisory_unlock/u);
});

test("guard reports busy without executing or trying to unlock", async () => {
  const client = new RecordingClient();
  client.acquire = false;
  let operationCalls = 0;

  const result = await runWithPostgresAdvisoryOperationGuard(
    { unpooledConnectionString: connectionString, lockName },
    () => {
      operationCalls += 1;
    },
    dependenciesFor(client),
  );

  assert.deepEqual(result, { status: "busy" });
  assert.equal(operationCalls, 0);
  assert.deepEqual(client.events, ["connect", "acquire", "end"]);
});

test("guard releases and closes the session when the operation rejects", async () => {
  const client = new RecordingClient();
  const operationError = new Error("operation failed");

  await assert.rejects(
    runWithPostgresAdvisoryOperationGuard(
      { unpooledConnectionString: connectionString, lockName },
      () => {
        client.events.push("operation");
        throw operationError;
      },
      dependenciesFor(client),
    ),
    (error: unknown) => error === operationError,
  );
  assert.deepEqual(client.events, [
    "connect",
    "acquire",
    "operation",
    "release",
    "end",
  ]);
});

test("guard closes failed sessions and exposes only stable infrastructure errors", async (context) => {
  await context.test("connect failure", async () => {
    const client = new RecordingClient();
    client.connectError = new Error(connectionString);

    await assert.rejects(
      runWithPostgresAdvisoryOperationGuard(
        { unpooledConnectionString: connectionString, lockName },
        () => undefined,
        dependenciesFor(client),
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          "PostgreSQL advisory operation client could not connect.",
        );
        assert.doesNotMatch(error.message, /private|password|database\.test/u);
        return true;
      },
    );
    assert.deepEqual(client.events, ["connect", "end"]);
  });

  await context.test("acquisition failure", async () => {
    const client = new RecordingClient();
    client.acquireError = new Error(connectionString);

    await assert.rejects(
      runWithPostgresAdvisoryOperationGuard(
        { unpooledConnectionString: connectionString, lockName },
        () => undefined,
        dependenciesFor(client),
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          "PostgreSQL advisory operation lock could not be acquired.",
        );
        assert.doesNotMatch(error.message, /private|password|database\.test/u);
        return true;
      },
    );
    assert.deepEqual(client.events, ["connect", "acquire", "end"]);
  });
});

test("guard attempts to close after release failure without exposing details", async () => {
  const client = new RecordingClient();
  client.releaseError = new Error(connectionString);

  await assert.rejects(
    runWithPostgresAdvisoryOperationGuard(
      { unpooledConnectionString: connectionString, lockName },
      () => "completed",
      dependenciesFor(client),
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        "PostgreSQL advisory operation lock could not be released.",
      );
      assert.doesNotMatch(error.message, /private|password|database\.test/u);
      return true;
    },
  );
  assert.deepEqual(client.events, [
    "connect",
    "acquire",
    "release",
    "end",
  ]);
});

test("guard hides client-construction details", async () => {
  const dependencies: PostgresAdvisoryOperationGuardDependencies = {
    createClient() {
      throw new Error(connectionString);
    },
  };

  await assert.rejects(
    runWithPostgresAdvisoryOperationGuard(
      { unpooledConnectionString: connectionString, lockName },
      () => undefined,
      dependencies,
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        "PostgreSQL advisory operation client could not be created.",
      );
      assert.doesNotMatch(error.message, /private|password|database\.test/u);
      return true;
    },
  );
});

test("guard rejects invalid configuration before creating a client", async () => {
  let clientCreations = 0;
  const dependencies: PostgresAdvisoryOperationGuardDependencies = {
    createClient() {
      clientCreations += 1;
      return new RecordingClient();
    },
  };

  await assert.rejects(
    runWithPostgresAdvisoryOperationGuard(
      { unpooledConnectionString: " ", lockName },
      () => undefined,
      dependencies,
    ),
    /unpooled PostgreSQL connection string is required/u,
  );
  await assert.rejects(
    runWithPostgresAdvisoryOperationGuard(
      { unpooledConnectionString: connectionString, lockName: " " },
      () => undefined,
      dependencies,
    ),
    /lock name is invalid/u,
  );
  assert.equal(clientCreations, 0);
});

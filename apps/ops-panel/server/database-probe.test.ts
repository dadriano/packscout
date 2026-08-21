import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyConnectionFailure,
  probeDatabase,
  type ProbeConnection,
} from "./database-probe.ts";

const CONNECTION = "postgresql://packscout:hunter2@127.0.0.1:5432/packscout_dev";

function postgresError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

interface FakeOptions {
  connectError?: unknown;
  failQuery?: (text: string) => unknown;
  migrationRows?: Array<Record<string, unknown>>;
}

function fakeConnection(options: FakeOptions = {}) {
  const seen: string[] = [];
  const state = { ended: 0 };
  const connection: ProbeConnection = {
    connect: async () => {
      if (options.connectError) throw options.connectError;
    },
    query: async <Row,>(text: string) => {
      seen.push(text);
      const failure = options.failQuery?.(text);
      if (failure) throw failure;
      if (text.includes("pg_database_size")) {
        return { rows: [{ database: "packscout_dev", size_bytes: "12557335" }] as Row[] };
      }
      if (text.includes("pg_total_relation_size")) {
        return {
          rows: [
            { name: "repacks", approximate_rows: "4211", total_bytes: "65536" },
          ] as Row[],
        };
      }
      return { rows: (options.migrationRows ?? []) as Row[] };
    },
    end: async () => {
      state.ended += 1;
    },
  };
  return { connection, seen, state };
}

test("a healthy probe reports size, tables, and migration history", async () => {
  const fake = fakeConnection({
    migrationRows: [
      {
        name: "20260812000000_baseline",
        started_at: new Date("2026-08-18T00:00:00.000Z"),
        finished_at: new Date("2026-08-18T00:00:01.000Z"),
        rolled_back_at: null,
      },
    ],
  });
  const result = await probeDatabase({
    connectionString: CONNECTION,
    connect: () => fake.connection,
  });

  assert.equal(result.outcome, "reachable");
  assert.equal(result.sizeBytes, 12_557_335);
  assert.deepEqual(result.tables, [
    { name: "repacks", approximateRows: 4_211, totalBytes: 65_536 },
  ]);
  assert.deepEqual(result.migrationHistory, [
    {
      name: "20260812000000_baseline",
      startedAt: "2026-08-18T00:00:00.000Z",
      finishedAt: "2026-08-18T00:00:01.000Z",
      rolledBackAt: null,
    },
  ]);
  assert.equal(fake.state.ended, 1, "the connection is always released");
});

test("every statement the probe issues is fixed and parameterless", async () => {
  const fake = fakeConnection();
  await probeDatabase({ connectionString: CONNECTION, connect: () => fake.connection });
  assert.equal(fake.seen.length, 3);
  for (const statement of fake.seen) {
    assert.ok(!statement.includes("$1"), statement);
    assert.ok(!statement.includes(CONNECTION), statement);
  }
});

test("a refused connection reads as unreachable with a redacted detail", async () => {
  const result = await probeDatabase({
    connectionString: CONNECTION,
    connect: () =>
      fakeConnection({
        connectError: postgresError(
          `connect ECONNREFUSED 127.0.0.1:5432 for ${CONNECTION}`,
          "ECONNREFUSED",
        ),
      }).connection,
  });
  assert.equal(result.outcome, "unreachable");
  assert.equal(result.migrationHistory, null);
  assert.ok(!(result.detail ?? "").includes("hunter2"));
  assert.match(result.detail ?? "", /ECONNREFUSED/u);
});

test("a server that answers and refuses reads as unqueryable, not unreachable", async () => {
  const result = await probeDatabase({
    connectionString: CONNECTION,
    connect: () =>
      fakeConnection({
        connectError: postgresError(
          'password authentication failed for user "packscout"',
          "28P01",
        ),
      }).connection,
  });
  assert.equal(result.outcome, "unqueryable");
  assert.match(result.detail ?? "", /authentication failed/u);
});

test("a failing status query reads as unqueryable and still releases the connection", async () => {
  const fake = fakeConnection({
    failQuery: (text) =>
      text.includes("pg_total_relation_size")
        ? postgresError("permission denied for table pg_class", "42501")
        : undefined,
  });
  const result = await probeDatabase({
    connectionString: CONNECTION,
    connect: () => fake.connection,
  });
  assert.equal(result.outcome, "unqueryable");
  assert.match(result.detail ?? "", /permission denied/u);
  assert.equal(fake.state.ended, 1);
});

test("a database with no migration table reports empty history, not an error", async () => {
  const fake = fakeConnection({
    failQuery: (text) =>
      text.includes("_prisma_migrations")
        ? postgresError('relation "_prisma_migrations" does not exist', "42P01")
        : undefined,
  });
  const result = await probeDatabase({
    connectionString: CONNECTION,
    connect: () => fake.connection,
  });
  assert.equal(result.outcome, "reachable");
  assert.deepEqual(result.migrationHistory, []);
});

test("a driver that cannot even be constructed reads as unreachable", async () => {
  const result = await probeDatabase({
    connectionString: CONNECTION,
    connect: () => {
      throw new Error(`invalid connection string ${CONNECTION}`);
    },
  });
  assert.equal(result.outcome, "unreachable");
  assert.ok(!(result.detail ?? "").includes("hunter2"));
});

test("connection failures are classified by whether PostgreSQL answered", () => {
  assert.equal(classifyConnectionFailure(new Error("socket hang up")), "unreachable");
  assert.equal(
    classifyConnectionFailure(postgresError("timeout", "ETIMEDOUT")),
    "unreachable",
  );
  assert.equal(classifyConnectionFailure(postgresError("nope", "28P01")), "unqueryable");
  assert.equal(classifyConnectionFailure(postgresError("nope", "3D000")), "unqueryable");
  assert.equal(classifyConnectionFailure(undefined), "unreachable");
});

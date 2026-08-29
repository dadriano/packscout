import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  CENTRAL_DATABASE_NAME,
  CENTRAL_SCHEMA_VERSION,
  PROVIDER_SCHEMA_VERSION,
  centralDatabaseTarget,
  evaluateDatabaseIdentity,
  isProviderKey,
  providerDatabaseName,
  providerDatabaseTarget,
  readDatabaseReadiness,
} from "./database-topology.ts";

const providerId = "79ad49f7-94a3-4fb9-a03e-58506e802c62";

describe("distributed database topology", () => {
  test("uses exact stable central and provider database names", () => {
    assert.equal(CENTRAL_DATABASE_NAME, "packscout");
    assert.deepEqual(centralDatabaseTarget(), {
      databaseRole: "central",
      databaseName: "packscout",
      schemaVersion: CENTRAL_SCHEMA_VERSION,
    });
    assert.equal(providerDatabaseName("collector_crypt"), "packscout_collector_crypt");
    assert.deepEqual(providerDatabaseTarget({ providerId, providerKey: "beezie" }), {
      databaseRole: "provider",
      databaseName: "packscout_beezie",
      schemaVersion: PROVIDER_SCHEMA_VERSION,
      providerId,
      providerKey: "beezie",
    });
  });

  test("accepts only provider keys safe for exact PostgreSQL names", () => {
    assert.equal(isProviderKey("a"), true);
    assert.equal(isProviderKey(`a${"0".repeat(52)}`), true);
    for (const invalid of ["", "A", "1provider", "provider-name", "provider.name", `a${"0".repeat(53)}`]) {
      assert.equal(isProviderKey(invalid), false, invalid);
      assert.throws(() => providerDatabaseName(invalid), /Provider key is invalid/);
    }
    assert.throws(
      () => providerDatabaseTarget({ providerId: "not-a-uuid", providerKey: "beezie" }),
      /Provider ID is invalid/,
    );
  });

  test("fails readiness closed for every central identity mismatch", () => {
    const target = centralDatabaseTarget();
    const observedAt = new Date("2026-08-29T00:00:00.000Z");
    const valid = {
      databaseName: "packscout",
      databaseRole: "central",
      schemaVersion: CENTRAL_SCHEMA_VERSION,
      providerId: null,
      providerKey: null,
    };

    assert.equal(evaluateDatabaseIdentity({ target, observation: valid, observedAt }).state, "ready");
    assert.equal(
      evaluateDatabaseIdentity({ target, observation: null, observedAt }).state,
      "unavailable",
    );
    assert.equal(
      evaluateDatabaseIdentity({
        target,
        observation: { ...valid, databaseName: "packscout_dev" },
        observedAt,
      }).state,
      "unavailable",
    );
    const leakedProviderIdentity = evaluateDatabaseIdentity({
      target,
      observation: { ...valid, providerId, providerKey: "beezie" },
      observedAt,
    });
    assert.deepEqual(leakedProviderIdentity, {
      state: "unavailable",
      target,
      failureCode: "PROVIDER_IDENTITY_MISMATCH",
      observedAt,
    });
  });

  test("requires the exact provider role, schema, id, key, and database name", () => {
    const target = providerDatabaseTarget({ providerId, providerKey: "beezie" });
    const valid = {
      databaseName: "packscout_beezie",
      databaseRole: "provider",
      schemaVersion: PROVIDER_SCHEMA_VERSION,
      providerId,
      providerKey: "beezie",
    };
    assert.equal(evaluateDatabaseIdentity({ target, observation: valid }).state, "ready");

    const mismatches = [
      [{ ...valid, databaseName: "packscout_trove" }, "DATABASE_NAME_MISMATCH"],
      [{ ...valid, databaseRole: "central" }, "DATABASE_ROLE_MISMATCH"],
      [{ ...valid, schemaVersion: "old" }, "DATABASE_SCHEMA_MISMATCH"],
      [{ ...valid, providerId: "c50b30f4-9dc7-423d-8a56-12ef92cecd71" }, "PROVIDER_IDENTITY_MISMATCH"],
      [{ ...valid, providerKey: "trove" }, "PROVIDER_IDENTITY_MISMATCH"],
    ] as const;
    for (const [observation, failureCode] of mismatches) {
      const result = evaluateDatabaseIdentity({ target, observation });
      assert.equal(result.state, "unavailable");
      if (result.state === "unavailable") assert.equal(result.failureCode, failureCode);
    }
  });

  test("reads one identity row and sanitizes database failures", async () => {
    const observedAt = new Date("2026-08-29T01:00:00.000Z");
    const target = providerDatabaseTarget({ providerId, providerKey: "beezie" });
    const queries: string[] = [];
    const ready = await readDatabaseReadiness({
      target,
      now: () => observedAt,
      client: {
        async $queryRawUnsafe<T>(query: string): Promise<T> {
          queries.push(query);
          return [{
            databaseName: "packscout_beezie",
            databaseRole: "provider",
            schemaVersion: PROVIDER_SCHEMA_VERSION,
            providerId,
            providerKey: "beezie",
          }] as T;
        },
      },
    });
    assert.equal(queries.length, 1);
    assert.equal(ready.state, "ready");

    const unavailable = await readDatabaseReadiness({
      target,
      now: () => observedAt,
      client: {
        async $queryRawUnsafe(): Promise<never> {
          throw new Error("postgresql://user:secret@db.internal/packscout_beezie");
        },
      },
    });
    assert.deepEqual(unavailable, {
      state: "unavailable",
      target,
      failureCode: "DATABASE_UNREACHABLE",
      observedAt,
    });
    assert.doesNotMatch(JSON.stringify(unavailable), /secret|db\.internal|postgresql/);
  });

  test("rejects duplicate identity singleton observations", async () => {
    const target = centralDatabaseTarget();
    const result = await readDatabaseReadiness({
      target,
      client: {
        async $queryRawUnsafe<T>(): Promise<T> {
          return [
            {
              databaseName: "packscout",
              databaseRole: "central",
              schemaVersion: CENTRAL_SCHEMA_VERSION,
              providerId: null,
              providerKey: null,
            },
            {
              databaseName: "packscout",
              databaseRole: "central",
              schemaVersion: CENTRAL_SCHEMA_VERSION,
              providerId: null,
              providerKey: null,
            },
          ] as T;
        },
      },
    });
    assert.equal(result.state, "unavailable");
    if (result.state === "unavailable") {
      assert.equal(result.failureCode, "DATABASE_IDENTITY_MISSING");
    }
  });
});

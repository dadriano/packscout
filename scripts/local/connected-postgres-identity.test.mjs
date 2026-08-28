import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONNECTED_POSTGRES_IDENTITY_SQL,
  ConnectedPostgresIdentityError,
  assertConnectedPostgresIdentity,
  assertSameConnectedPostgresIdentity,
  connectedPostgresIdentityBindingParts,
  readConnectedPostgresIdentity,
} from "./connected-postgres-identity.mjs";

const IDENTITY = Object.freeze({
  databaseName: "packscout_clutchpacks_v3_canary",
  databaseOid: "16432",
  systemIdentifier: "7541020403012209001",
});

function assertCode(code) {
  return (error) => {
    assert.ok(error instanceof ConnectedPostgresIdentityError);
    assert.equal(error.code, code);
    return true;
  };
}

test("connected identity comes from database, OID, and cluster system identifier", async () => {
  let sql;
  const identity = await readConnectedPostgresIdentity(async (statement) => {
    sql = statement;
    return [IDENTITY];
  }, IDENTITY.databaseName);
  assert.deepEqual(identity, IDENTITY);
  assert.match(sql, /current_database\(\)/u);
  assert.match(sql, /pg_catalog\.pg_database/u);
  assert.match(sql, /pg_catalog\.pg_control_system\(\)/u);
  assert.deepEqual(connectedPostgresIdentityBindingParts(identity), [
    IDENTITY.databaseName,
    IDENTITY.databaseOid,
    IDENTITY.systemIdentifier,
  ]);
  assert.equal(sql, CONNECTED_POSTGRES_IDENTITY_SQL);
});

test("connected identity fails closed on the wrong database or incomplete rows", async () => {
  assert.throws(
    () => assertConnectedPostgresIdentity(
      { ...IDENTITY, databaseName: "packscout_dev" },
      IDENTITY.databaseName,
    ),
    assertCode("CONNECTED_POSTGRES_DATABASE_NAME_MISMATCH"),
  );
  for (const row of [
    { ...IDENTITY, databaseOid: "" },
    { ...IDENTITY, databaseOid: "016432" },
    { ...IDENTITY, systemIdentifier: null },
  ]) {
    assert.throws(
      () => assertConnectedPostgresIdentity(row, IDENTITY.databaseName),
      assertCode("CONNECTED_POSTGRES_IDENTITY_UNAVAILABLE"),
    );
  }
  await assert.rejects(
    readConnectedPostgresIdentity(async () => [], IDENTITY.databaseName),
    assertCode("CONNECTED_POSTGRES_IDENTITY_UNAVAILABLE"),
  );
});

test("exact identity comparison detects database or cluster replacement", () => {
  assert.deepEqual(assertSameConnectedPostgresIdentity(IDENTITY, IDENTITY), IDENTITY);
  for (const changed of [
    { ...IDENTITY, databaseOid: "16433" },
    { ...IDENTITY, systemIdentifier: "7541020403012209002" },
  ]) {
    assert.throws(
      () => assertSameConnectedPostgresIdentity(changed, IDENTITY),
      assertCode("CONNECTED_POSTGRES_IDENTITY_MISMATCH"),
    );
  }
});

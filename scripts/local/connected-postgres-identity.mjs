export const CONNECTED_POSTGRES_IDENTITY_SQL = `
  select current_database() as "databaseName",
         database.oid::text as "databaseOid",
         control.system_identifier::text as "systemIdentifier"
  from pg_catalog.pg_database as database
  cross join pg_catalog.pg_control_system() as control
  where database.datname = current_database()
`;

const CANONICAL_POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/u;

export class ConnectedPostgresIdentityError extends Error {
  constructor(code, options) {
    super("The connected PostgreSQL identity could not be verified.", options);
    this.name = "ConnectedPostgresIdentityError";
    this.code = code;
  }
}

function refuse(code, options) {
  throw new ConnectedPostgresIdentityError(code, options);
}

/**
 * Validate the immutable cluster/database identity returned by PostgreSQL.
 * The URL is deliberately not part of this proof: a loopback socket may be a
 * tunnel, while the database OID plus PostgreSQL system identifier names the
 * database and cluster that actually accepted the connection.
 */
export function assertConnectedPostgresIdentity(row, expectedDatabaseName) {
  if (
    typeof expectedDatabaseName !== "string" ||
    expectedDatabaseName.length === 0 ||
    typeof row !== "object" ||
    row === null ||
    row.databaseName !== expectedDatabaseName
  ) {
    refuse("CONNECTED_POSTGRES_DATABASE_NAME_MISMATCH");
  }
  if (
    !CANONICAL_POSITIVE_DECIMAL_PATTERN.test(row.databaseOid ?? "") ||
    !CANONICAL_POSITIVE_DECIMAL_PATTERN.test(row.systemIdentifier ?? "")
  ) {
    refuse("CONNECTED_POSTGRES_IDENTITY_UNAVAILABLE");
  }
  return Object.freeze({
    databaseName: row.databaseName,
    databaseOid: row.databaseOid,
    systemIdentifier: row.systemIdentifier,
  });
}

export async function readConnectedPostgresIdentity(
  readRows,
  expectedDatabaseName,
) {
  let rows;
  try {
    rows = await readRows(CONNECTED_POSTGRES_IDENTITY_SQL);
  } catch (error) {
    refuse("CONNECTED_POSTGRES_IDENTITY_UNAVAILABLE", { cause: error });
  }
  if (!Array.isArray(rows) || rows.length !== 1) {
    refuse("CONNECTED_POSTGRES_IDENTITY_UNAVAILABLE");
  }
  return assertConnectedPostgresIdentity(rows[0], expectedDatabaseName);
}

export function assertSameConnectedPostgresIdentity(actual, expected) {
  const normalizedExpected = assertConnectedPostgresIdentity(
    expected,
    expected?.databaseName,
  );
  const normalizedActual = assertConnectedPostgresIdentity(
    actual,
    normalizedExpected.databaseName,
  );
  if (
    normalizedActual.databaseOid !== normalizedExpected.databaseOid ||
    normalizedActual.systemIdentifier !== normalizedExpected.systemIdentifier
  ) {
    refuse("CONNECTED_POSTGRES_IDENTITY_MISMATCH");
  }
  return normalizedActual;
}

export function connectedPostgresIdentityBindingParts(identity) {
  const normalized = assertConnectedPostgresIdentity(
    identity,
    identity?.databaseName,
  );
  return Object.freeze([
    normalized.databaseName,
    normalized.databaseOid,
    normalized.systemIdentifier,
  ]);
}

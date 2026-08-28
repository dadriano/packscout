export interface ConnectedPostgresIdentity {
  readonly databaseName: string;
  readonly databaseOid: string;
  readonly systemIdentifier: string;
}

export const CONNECTED_POSTGRES_IDENTITY_SQL: string;

export class ConnectedPostgresIdentityError extends Error {
  readonly code: string;
  constructor(code: string, options?: ErrorOptions);
}

export function assertConnectedPostgresIdentity(
  row: unknown,
  expectedDatabaseName: string,
): ConnectedPostgresIdentity;

export function readConnectedPostgresIdentity(
  readRows: (sql: string) => Promise<unknown[]>,
  expectedDatabaseName: string,
): Promise<ConnectedPostgresIdentity>;

export function assertSameConnectedPostgresIdentity(
  actual: unknown,
  expected: unknown,
): ConnectedPostgresIdentity;

export function connectedPostgresIdentityBindingParts(
  identity: unknown,
): readonly [string, string, string];

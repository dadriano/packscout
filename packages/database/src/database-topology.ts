const PROVIDER_KEY_PATTERN = /^[a-z][a-z0-9_]{0,52}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const CENTRAL_DATABASE_NAME = "packscout";
export const CENTRAL_SCHEMA_VERSION = "distributed-central-v1";
export const PROVIDER_SCHEMA_VERSION = "distributed-provider-v1";

export type DatabaseRole = "central" | "provider";

export interface CentralDatabaseTargetDescriptor {
  readonly databaseRole: "central";
  readonly databaseName: typeof CENTRAL_DATABASE_NAME;
  readonly schemaVersion: typeof CENTRAL_SCHEMA_VERSION;
}

export interface ProviderDatabaseTargetDescriptor {
  readonly databaseRole: "provider";
  readonly databaseName: string;
  readonly schemaVersion: typeof PROVIDER_SCHEMA_VERSION;
  readonly providerId: string;
  readonly providerKey: string;
}

export type DatabaseTargetDescriptor =
  | CentralDatabaseTargetDescriptor
  | ProviderDatabaseTargetDescriptor;

export interface DatabaseIdentityObservation {
  readonly databaseName: string;
  readonly databaseRole: string;
  readonly schemaVersion: string;
  readonly providerId: string | null;
  readonly providerKey: string | null;
}

export type DatabaseReadinessFailureCode =
  | "DATABASE_UNREACHABLE"
  | "DATABASE_IDENTITY_MISSING"
  | "DATABASE_NAME_MISMATCH"
  | "DATABASE_ROLE_MISMATCH"
  | "DATABASE_SCHEMA_MISMATCH"
  | "PROVIDER_IDENTITY_MISMATCH";

export type DatabaseReadinessResult =
  | {
      readonly state: "ready";
      readonly target: DatabaseTargetDescriptor;
      readonly observedSchemaVersion: string;
      readonly observedAt: Date;
    }
  | {
      readonly state: "unavailable";
      readonly target: DatabaseTargetDescriptor;
      readonly failureCode: DatabaseReadinessFailureCode;
      readonly observedAt: Date;
    };

export function isProviderKey(value: string): boolean {
  return PROVIDER_KEY_PATTERN.test(value);
}

export function assertProviderKey(value: string): void {
  if (!isProviderKey(value)) {
    throw new TypeError("Provider key is invalid.");
  }
}

export function assertDatabaseUuid(value: string, label = "ID"): void {
  if (!UUID_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
}

export function providerDatabaseName(providerKey: string): string {
  assertProviderKey(providerKey);
  return `packscout_${providerKey}`;
}

export function centralDatabaseTarget(): CentralDatabaseTargetDescriptor {
  return Object.freeze({
    databaseRole: "central",
    databaseName: CENTRAL_DATABASE_NAME,
    schemaVersion: CENTRAL_SCHEMA_VERSION,
  });
}

export function providerDatabaseTarget(input: {
  providerId: string;
  providerKey: string;
}): ProviderDatabaseTargetDescriptor {
  assertDatabaseUuid(input.providerId, "Provider ID");
  return Object.freeze({
    databaseRole: "provider",
    databaseName: providerDatabaseName(input.providerKey),
    schemaVersion: PROVIDER_SCHEMA_VERSION,
    providerId: input.providerId.toLowerCase(),
    providerKey: input.providerKey,
  });
}

export function evaluateDatabaseIdentity(input: {
  target: DatabaseTargetDescriptor;
  observation: DatabaseIdentityObservation | null;
  observedAt?: Date;
}): DatabaseReadinessResult {
  const observedAt = input.observedAt ?? new Date();
  const unavailable = (
    failureCode: DatabaseReadinessFailureCode,
  ): DatabaseReadinessResult => ({
    state: "unavailable",
    target: input.target,
    failureCode,
    observedAt,
  });
  const observation = input.observation;

  if (!observation) return unavailable("DATABASE_IDENTITY_MISSING");
  if (observation.databaseName !== input.target.databaseName) {
    return unavailable("DATABASE_NAME_MISMATCH");
  }
  if (observation.databaseRole !== input.target.databaseRole) {
    return unavailable("DATABASE_ROLE_MISMATCH");
  }
  if (observation.schemaVersion !== input.target.schemaVersion) {
    return unavailable("DATABASE_SCHEMA_MISMATCH");
  }

  if (input.target.databaseRole === "central") {
    if (observation.providerId !== null || observation.providerKey !== null) {
      return unavailable("PROVIDER_IDENTITY_MISMATCH");
    }
  } else if (
    observation.providerId?.toLowerCase() !== input.target.providerId
    || observation.providerKey !== input.target.providerKey
  ) {
    return unavailable("PROVIDER_IDENTITY_MISMATCH");
  }

  return {
    state: "ready",
    target: input.target,
    observedSchemaVersion: observation.schemaVersion,
    observedAt,
  };
}

export interface DatabaseIdentityQueryClient {
  $queryRawUnsafe<T = unknown>(query: string): Promise<T>;
}

interface DatabaseIdentityRow {
  databaseName: string;
  databaseRole: string;
  schemaVersion: string;
  providerId: string | null;
  providerKey: string | null;
}

const DATABASE_IDENTITY_QUERY = `
  select current_database() as "databaseName",
         database_role as "databaseRole",
         schema_version as "schemaVersion",
         provider_id::text as "providerId",
         provider_key as "providerKey"
  from public.database_identity
  where singleton_key = true
  limit 2
`;

export async function readDatabaseReadiness(input: {
  client: DatabaseIdentityQueryClient;
  target: DatabaseTargetDescriptor;
  now?: () => Date;
}): Promise<DatabaseReadinessResult> {
  const observedAt = input.now?.() ?? new Date();
  let rows: DatabaseIdentityRow[];
  try {
    rows = await input.client.$queryRawUnsafe<DatabaseIdentityRow[]>(
      DATABASE_IDENTITY_QUERY,
    );
  } catch {
    return {
      state: "unavailable",
      target: input.target,
      failureCode: "DATABASE_UNREACHABLE",
      observedAt,
    };
  }

  return evaluateDatabaseIdentity({
    target: input.target,
    observation: rows.length === 1 ? rows[0]! : null,
    observedAt,
  });
}

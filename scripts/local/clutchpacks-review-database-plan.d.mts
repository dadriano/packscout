export interface ClutchpacksReviewDatabaseTarget {
  readonly appRoleName: string;
  readonly databaseName: string;
  readonly migrationName: string;
  readonly ownerRoleName: string;
  readonly schemaVersion: string;
}

export interface ClutchpacksReviewProviderTarget
  extends ClutchpacksReviewDatabaseTarget {
  readonly adapterKey: string;
  readonly providerKey: string;
}

export const CLUTCHPACKS_REVIEW_DATABASES: Readonly<{
  central: Readonly<ClutchpacksReviewDatabaseTarget>;
  provider: Readonly<ClutchpacksReviewProviderTarget>;
}>;

export const CLUTCHPACKS_REVIEW_REBUILD_CONFIRMATION: string;

export const CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS: Readonly<{
  mode: string;
  adminDatabaseUrl: string;
  centralAppPassword: string;
  providerAppPassword: string;
  organizationSlug: string;
  organizationName: string;
  adminEmail: string;
  adminDisplayName: string;
  adminPassword: string;
  credentialKey: string;
  credentialKeyVersion: string;
  rebuildConfirmation: string;
  backupDirectory: string;
}>;

export class ClutchpacksReviewProvisionError extends Error {
  readonly code: string;
  constructor(code: string);
}

export interface LocalPostgresAdminTarget {
  readonly host: string;
  readonly port: number;
  readonly url: string;
}

export interface BootstrapAdminInput {
  readonly organizationSlug: string;
  readonly organizationName: string;
  readonly adminEmail: string;
  readonly adminDisplayName: string;
  readonly adminPassword: string;
}

export interface ProviderCredentialKeyInput {
  readonly bytes: Uint8Array;
  readonly version: number;
}

export interface InspectClutchpacksProvisionEnvironment {
  readonly mode: "inspect";
  readonly admin: LocalPostgresAdminTarget;
}

export interface MutatingClutchpacksProvisionEnvironment {
  readonly mode: "create" | "rebuild";
  readonly admin: LocalPostgresAdminTarget;
  readonly centralAppPassword: string;
  readonly providerAppPassword: string;
  readonly bootstrap: BootstrapAdminInput;
  readonly credentialKey: ProviderCredentialKeyInput;
  readonly backupDirectory: string | null;
}

export type ClutchpacksProvisionEnvironment =
  | InspectClutchpacksProvisionEnvironment
  | MutatingClutchpacksProvisionEnvironment;

export interface ReviewDatabaseInventoryProof {
  readonly databaseName: string;
  readonly exists: boolean;
  readonly owner?: string | null;
  readonly migrationState?: string;
  readonly identityState?: string;
}

export interface ReviewRoleInventoryProof {
  readonly roleName: string;
  readonly exists: boolean;
  readonly login: boolean;
  readonly superuser: boolean;
  readonly createRole: boolean;
  readonly createDatabase: boolean;
  readonly replication: boolean;
  readonly bypassRls: boolean;
  readonly membershipCount: number;
  readonly foreignOwnedDatabaseCount: number;
}

export interface ReviewInventoryProof {
  readonly databases: readonly ReviewDatabaseInventoryProof[];
  readonly roles: readonly ReviewRoleInventoryProof[];
}

export interface BackupProof {
  readonly databaseName: string;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export function assertNoClutchpacksProvisionArguments(
  argumentsList: readonly string[],
): void;
export function parseLocalPostgresAdminUrl(
  value: string,
): Readonly<LocalPostgresAdminTarget>;
export function parsePrivateBackupDirectory(value: string): string;
export function readClutchpacksProvisionEnvironment(
  environment: NodeJS.ProcessEnv,
): Readonly<ClutchpacksProvisionEnvironment>;
export function assertCreateOnlyInventory(
  inventory: Pick<ReviewInventoryProof, "databases" | "roles">,
): void;
export function assertRebuildRoleInventory(
  inventory: Pick<ReviewInventoryProof, "roles">,
): void;
export function assertVerifiedBackupProofs(
  inventory: Pick<ReviewInventoryProof, "databases">,
  backupDirectory: string,
  proofs: readonly BackupProof[],
): void;
export function assertProvisionedReviewInventory(
  inventory: ReviewInventoryProof,
): void;

export function buildClutchpacksProvisionPlan(
  ids: Readonly<Record<string, string>>,
  mode?: "create" | "rebuild",
): Readonly<{
  databaseNames: readonly string[];
  roleNames: readonly string[];
  identities: Readonly<Record<string, string>>;
  providerIdentity: Readonly<{
    databaseRole: "provider";
    databaseName: string;
    schemaVersion: string;
    providerId: string;
    providerKey: string;
  }>;
  stages: readonly string[];
}>;

export function safeClutchpacksProvisionFailure(error: unknown): Readonly<{
  ok: false;
  operation: "provision_clutchpacks_review_databases";
  code: string;
}>;

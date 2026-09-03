export type ClusterKey =
  | "control"
  | "clutchpacks"
  | "courtyard"
  | "collector_crypt"
  | "phygitals";
export type ClusterTarget = "all" | ClusterKey;
export type ClusterAction = "inspect" | "provision" | "start" | "stop";
export type ClusterMarkerState = "initialized" | "provisioned";

export interface ClutchpacksReviewDatabaseTarget {
  readonly appRoleName: string;
  readonly clusterAdminRoleName: string;
  readonly clusterKey: ClusterKey;
  readonly dataDirectory: string;
  readonly databaseName: string;
  readonly migrationName: string;
  readonly ownerRoleName: string;
  readonly port: number;
  readonly schemaVersion: string;
  readonly adapterKey?: string;
  readonly providerKey?: string;
}

export const CLUTCHPACKS_REVIEW_CLUSTER_ROOT: string;
export const CLUTCHPACKS_REVIEW_CLUSTER_MARKER: string;
export const CLUTCHPACKS_REVIEW_CLUSTER_MARKER_FORMAT: string;
export const CLUTCHPACKS_REVIEW_DATABASES: Readonly<{
  central: Readonly<ClutchpacksReviewDatabaseTarget>;
  provider: Readonly<ClutchpacksReviewDatabaseTarget & {
    adapterKey: string;
    providerKey: string;
  }>;
}>;

export const CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS: Readonly<{
  action: string;
  target: string;
  centralClusterAdminPassword: string;
  providerClusterAdminPassword: string;
  centralAppPassword: string;
  providerAppPassword: string;
  organizationSlug: string;
  organizationName: string;
  adminEmail: string;
  adminDisplayName: string;
  adminPassword: string;
  credentialKey: string;
  credentialKeyVersion: string;
}>;

export class ClutchpacksReviewProvisionError extends Error {
  readonly code: string;
  constructor(code: string);
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

export interface ClusterMarker {
  readonly format: string;
  readonly clusterKey: ClusterKey;
  readonly dataDirectory: string;
  readonly port: number;
  readonly databaseName: string;
  readonly clusterAdminRoleName: string;
  readonly ownerRoleName: string;
  readonly appRoleName: string;
  readonly systemIdentifier: string;
  readonly state: ClusterMarkerState;
}

interface BaseClusterEnvironment {
  readonly action: ClusterAction;
  readonly target: ClusterTarget;
  readonly selected: readonly Readonly<ClutchpacksReviewDatabaseTarget>[];
}

export interface StopClusterEnvironment extends BaseClusterEnvironment {
  readonly action: "stop";
  readonly target: ClusterKey;
}

export interface ReadClusterEnvironment extends BaseClusterEnvironment {
  readonly action: "inspect" | "start";
  readonly centralAppPassword: string | null;
  readonly providerAppPassword: string | null;
}

export interface ProvisionClusterEnvironment extends BaseClusterEnvironment {
  readonly action: "provision";
  readonly target: "all";
  readonly centralClusterAdminPassword: string;
  readonly providerClusterAdminPassword: string;
  readonly centralAppPassword: string;
  readonly providerAppPassword: string;
  readonly bootstrap: BootstrapAdminInput;
  readonly credentialKey: ProviderCredentialKeyInput;
}

export type ClutchpacksProvisionEnvironment =
  | StopClusterEnvironment
  | ReadClusterEnvironment
  | ProvisionClusterEnvironment;

export function assertNoClutchpacksProvisionArguments(
  argumentsList: readonly string[],
): void;
export function readClutchpacksProvisionEnvironment(
  environment: NodeJS.ProcessEnv,
): Readonly<ClutchpacksProvisionEnvironment>;
export function buildClusterMarker(
  cluster: ClutchpacksReviewDatabaseTarget,
  systemIdentifier: string,
  state: ClusterMarkerState,
): Readonly<ClusterMarker>;
export function assertClusterMarker(
  marker: unknown,
  cluster: ClutchpacksReviewDatabaseTarget,
): Readonly<ClusterMarker>;
export function assertCreateClusterInventory(inventory: {
  readonly parentPrivate: boolean;
  readonly portOccupied: boolean;
  readonly directoryState: string;
}): void;
export function assertResumableClusterTopology(
  cluster: ClutchpacksReviewDatabaseTarget,
  inventory: {
    readonly roles: readonly {
      readonly rolbypassrls: boolean;
      readonly rolcanlogin: boolean;
      readonly rolconnlimit: number;
      readonly rolcreatedb: boolean;
      readonly rolcreaterole: boolean;
      readonly rolinherit: boolean;
      readonly rolname: string;
      readonly rolreplication: boolean;
      readonly rolsuper: boolean;
    }[];
    readonly databases: readonly {
      readonly datname: string;
      readonly owner_name: string;
    }[];
  },
): Readonly<{
  readonly appRoleExists: boolean;
  readonly ownerRoleExists: boolean;
  readonly targetDatabaseExists: boolean;
}>;
export function assertDistinctClusterProofs(
  central: {
    readonly clusterKey: ClusterKey;
    readonly dataDirectory: string;
    readonly port: number;
    readonly systemIdentifier: string;
    readonly databaseName: string;
  },
  provider: {
    readonly clusterKey: ClusterKey;
    readonly dataDirectory: string;
    readonly port: number;
    readonly systemIdentifier: string;
    readonly databaseName: string;
  },
): void;
export function buildClutchpacksProvisionPlan(
  ids: Readonly<Record<string, string>>,
): Readonly<{
  clusters: readonly Readonly<ClutchpacksReviewDatabaseTarget>[];
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
  operation: "manage_clutchpacks_review_clusters";
  code: string;
}>;

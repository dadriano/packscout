import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  DATAFORREST_EVENTS_V1_ENDPOINT,
  type LaunchProviderKey,
} from "@packscout/contracts";
import {
  CLUTCHPACKS_REVIEW_CLUSTER_ROOT,
  CLUTCHPACKS_REVIEW_DATABASES,
  ClutchpacksReviewProvisionError,
  type ClutchpacksReviewDatabaseTarget,
} from "./clutchpacks-review-database-plan.mjs";

export type AdditionalProviderKey = Exclude<LaunchProviderKey, "clutchpacks">;
export type AdditionalReviewClusterAction =
  | "inspect"
  | "provision"
  | "start"
  | "stop";
export type AdditionalReviewClusterTarget = "all" | AdditionalProviderKey;

export interface ReviewProviderDescriptor
  extends ClutchpacksReviewDatabaseTarget {
  readonly clusterKey: AdditionalProviderKey;
  readonly providerKey: AdditionalProviderKey;
  readonly adapterKey: string;
  readonly displayName: string;
  readonly endpointUrl: string;
  readonly sourceConfiguration: Readonly<{ platform: AdditionalProviderKey }>;
  readonly cloneExistingSourceCredentialFromProviderKey: "clutchpacks" | null;
  readonly executionCapability: "installed" | "uninstalled";
  readonly connectionTestKind: "activation" | "database";
  readonly publicProfile: Readonly<{
    displayName: string;
    logoUrl: null;
    websiteUrl: null;
    listingHosts: readonly string[];
    imageOrigins: readonly string[];
    referralParameters: readonly never[];
    promoCode: null;
    promoLabel: null;
    contentHash: string;
  }>;
  readonly environmentKeys: Readonly<{
    clusterAdminPassword: string;
    appPassword: string;
  }>;
}

export interface ProviderReviewCredentialInput {
  readonly clusterAdminPassword: string | null;
  readonly appPassword: string | null;
}

export interface ProviderReviewIsolationInput {
  readonly providerKey: LaunchProviderKey;
  readonly providerId: string;
  readonly dataDirectory: string;
  readonly databaseName: string;
  readonly port: number;
  readonly schemaVersion: string;
  readonly systemIdentifier: string;
  readonly databaseNodeId: string;
  readonly databaseCredentialVersionId: string;
}

export interface SanitizedProviderReviewIsolationFact {
  readonly providerKey: LaunchProviderKey;
  readonly providerId: string;
  readonly databaseName: string;
  readonly port: number;
  readonly schemaVersion: "distributed-provider-v1";
  readonly systemIdentifier: string;
  readonly dataDirectoryHash: string;
  readonly databaseNodeId: string;
  readonly databaseCredentialVersionId: string;
  readonly stateOwnership: Readonly<{
    databaseName: string;
    runtimeTable: "provider_runtime";
    leaseTable: "provider_worker_states";
    commandTable: "control_commands";
    cursorTable: "provider_runtime";
  }>;
}

export interface AdditionalProviderRuntimeFact {
  readonly providerKey: AdditionalProviderKey;
  readonly running: boolean;
}

interface ProviderReviewBaseEnvironment {
  readonly action: AdditionalReviewClusterAction;
  readonly target: AdditionalReviewClusterTarget;
  readonly selected: readonly Readonly<ReviewProviderDescriptor>[];
  readonly credentials: Readonly<
    Record<AdditionalProviderKey, Readonly<ProviderReviewCredentialInput>>
  >;
}

export interface ProviderReviewReadEnvironment
  extends ProviderReviewBaseEnvironment {
  readonly action: "inspect" | "start";
}

export interface ProviderReviewStopEnvironment
  extends ProviderReviewBaseEnvironment {
  readonly action: "stop";
  readonly target: AdditionalProviderKey;
}

export interface ProviderReviewProvisionEnvironment
  extends ProviderReviewBaseEnvironment {
  readonly action: "provision";
  readonly target: "all";
  readonly centralAppPassword: string;
  readonly clutchpacksAppPassword: string;
  readonly organizationSlug: string;
  readonly adminEmail: string;
  readonly credentialKey: Readonly<{
    bytes: Uint8Array;
    version: number;
  }>;
}

export type AdditionalProviderReviewEnvironment =
  | ProviderReviewReadEnvironment
  | ProviderReviewStopEnvironment
  | ProviderReviewProvisionEnvironment;

export const DATAFORREST_LAUNCH_DISTRIBUTED_ADAPTER_KEY =
  "dataforrest-launch-distributed-adapter-v1" as const;

export const PROVIDER_REVIEW_ENVIRONMENT_KEYS = Object.freeze({
  action: "PACKSCOUT_LOCAL_PROVIDER_REVIEW_CLUSTER_ACTION",
  target: "PACKSCOUT_LOCAL_PROVIDER_REVIEW_CLUSTER_TARGET",
  centralAppPassword: "PACKSCOUT_LOCAL_CONTROL_APP_PASSWORD",
  clutchpacksAppPassword: "PACKSCOUT_LOCAL_CLUTCHPACKS_APP_PASSWORD",
  organizationSlug: "PACKSCOUT_LOCAL_ORGANIZATION_SLUG",
  adminEmail: "PACKSCOUT_LOCAL_BOOTSTRAP_ADMIN_EMAIL",
  credentialKey: "PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64",
  credentialKeyVersion: "PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION",
});

const SYSTEM_ACCOUNT_CLUSTER_ROOT = path.join(
  os.userInfo().homedir,
  "Library/Application Support/PackScout/postgres-review",
);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const ACTIONS = new Set<AdditionalReviewClusterAction>([
  "inspect",
  "provision",
  "start",
  "stop",
]);
const ADDITIONAL_PROVIDER_KEYS = Object.freeze([
  "courtyard",
  "collector_crypt",
  "phygitals",
] as const satisfies readonly AdditionalProviderKey[]);

export class ProviderReviewProvisionError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ProviderReviewProvisionError";
    this.code = code;
  }
}

function refuse(code: string): never {
  throw new ProviderReviewProvisionError(code);
}

function profile(displayName: string): ReviewProviderDescriptor["publicProfile"] {
  const value: Omit<
    ReviewProviderDescriptor["publicProfile"],
    "contentHash"
  > = Object.freeze({
    displayName,
    logoUrl: null,
    websiteUrl: null,
    listingHosts: Object.freeze([] as string[]),
    imageOrigins: Object.freeze([] as string[]),
    referralParameters: Object.freeze([] as never[]),
    promoCode: null,
    promoLabel: null,
  });
  const contentHash = createHash("sha256")
    .update("packscout-local-provider-public-profile-v1\0", "utf8")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
  return Object.freeze({ ...value, contentHash });
}

function descriptor(input: {
  readonly providerKey: AdditionalProviderKey;
  readonly displayName: string;
  readonly port: number;
  readonly cloneExistingSourceCredentialFromProviderKey: "clutchpacks" | null;
  readonly executionCapability: "installed" | "uninstalled";
}): Readonly<ReviewProviderDescriptor> {
  const environmentPrefix = input.providerKey.toUpperCase();
  return Object.freeze({
    adapterKey: DATAFORREST_LAUNCH_DISTRIBUTED_ADAPTER_KEY,
    appRoleName: `packscout_${input.providerKey}_app`,
    clusterAdminRoleName: `packscout_${input.providerKey}_cluster_admin`,
    clusterKey: input.providerKey,
    dataDirectory: path.join(CLUTCHPACKS_REVIEW_CLUSTER_ROOT, input.providerKey),
    databaseName: `packscout_${input.providerKey}`,
    displayName: input.displayName,
    endpointUrl: DATAFORREST_EVENTS_V1_ENDPOINT,
    environmentKeys: Object.freeze({
      clusterAdminPassword:
        `PACKSCOUT_LOCAL_${environmentPrefix}_CLUSTER_ADMIN_PASSWORD`,
      appPassword: `PACKSCOUT_LOCAL_${environmentPrefix}_APP_PASSWORD`,
    }),
    executionCapability: input.executionCapability,
    migrationName: "20260829000000_distributed_provider_baseline",
    ownerRoleName: `packscout_${input.providerKey}_owner`,
    port: input.port,
    providerKey: input.providerKey,
    publicProfile: profile(input.displayName),
    schemaVersion: "distributed-provider-v1",
    sourceConfiguration: Object.freeze({ platform: input.providerKey }),
    cloneExistingSourceCredentialFromProviderKey:
      input.cloneExistingSourceCredentialFromProviderKey,
    connectionTestKind: input.executionCapability === "installed"
      ? "activation"
      : "database",
  });
}

export const ADDITIONAL_PROVIDER_REVIEW_DATABASES = Object.freeze([
  descriptor({
    providerKey: "courtyard",
    displayName: "Courtyard",
    port: 55_433,
    cloneExistingSourceCredentialFromProviderKey: "clutchpacks",
    executionCapability: "installed",
  }),
  descriptor({
    providerKey: "collector_crypt",
    displayName: "Collector Crypt",
    port: 55_434,
    cloneExistingSourceCredentialFromProviderKey: null,
    executionCapability: "uninstalled",
  }),
  descriptor({
    providerKey: "phygitals",
    displayName: "Phygitals",
    port: 55_435,
    cloneExistingSourceCredentialFromProviderKey: null,
    executionCapability: "uninstalled",
  }),
] as const);

export const ALL_PROVIDER_REVIEW_DATABASES = Object.freeze([
  CLUTCHPACKS_REVIEW_DATABASES.central,
  CLUTCHPACKS_REVIEW_DATABASES.provider,
  ...ADDITIONAL_PROVIDER_REVIEW_DATABASES,
]);

export function assertAdditionalProviderDescriptors(
  providers: readonly Readonly<ReviewProviderDescriptor>[],
): void {
  if (
    providers.length !== ADDITIONAL_PROVIDER_KEYS.length ||
    providers.some((provider) =>
      provider.clusterKey !== provider.providerKey ||
      provider.databaseName !== `packscout_${provider.providerKey}` ||
      provider.dataDirectory !==
        path.join(CLUTCHPACKS_REVIEW_CLUSTER_ROOT, provider.providerKey) ||
      provider.sourceConfiguration.platform !== provider.providerKey ||
      provider.adapterKey !== DATAFORREST_LAUNCH_DISTRIBUTED_ADAPTER_KEY ||
      provider.endpointUrl !== DATAFORREST_EVENTS_V1_ENDPOINT ||
      (provider.executionCapability === "installed") !==
        (provider.connectionTestKind === "activation") ||
      (provider.executionCapability === "installed") !==
        (provider.cloneExistingSourceCredentialFromProviderKey !== null) ||
      !/^[0-9a-f]{64}$/u.test(provider.publicProfile.contentHash)
    ) ||
    ADDITIONAL_PROVIDER_KEYS.some((providerKey) =>
      providers.filter((provider) => provider.providerKey === providerKey).length !== 1
    )
  ) {
    refuse("PROVIDER_DESCRIPTOR_INVALID");
  }
  const all = [CLUTCHPACKS_REVIEW_DATABASES.central,
    CLUTCHPACKS_REVIEW_DATABASES.provider, ...providers];
  for (const field of [
    "appRoleName",
    "clusterAdminRoleName",
    "clusterKey",
    "dataDirectory",
    "databaseName",
    "ownerRoleName",
    "port",
  ] as const) {
    if (new Set(all.map((item) => item[field])).size !== all.length) {
      refuse("PROVIDER_DESCRIPTOR_COLLISION");
    }
  }
}

assertAdditionalProviderDescriptors(ADDITIONAL_PROVIDER_REVIEW_DATABASES);

const PROVIDER_BY_KEY = new Map(
  ADDITIONAL_PROVIDER_REVIEW_DATABASES.map((provider) => [
    provider.providerKey,
    provider,
  ]),
);

const FORBIDDEN_REDIRECT_KEYS = Object.freeze([
  "PACKSCOUT_LOCAL_REVIEW_CLUSTER_ROOT",
  "PACKSCOUT_LOCAL_PROVIDER_DATABASE_NAME",
  "PACKSCOUT_LOCAL_PROVIDER_KEY",
  ...ADDITIONAL_PROVIDER_REVIEW_DATABASES.flatMap((provider) => {
    const prefix = provider.providerKey.toUpperCase();
    return [
      `PACKSCOUT_LOCAL_${prefix}_DATA_DIRECTORY`,
      `PACKSCOUT_LOCAL_${prefix}_PORT`,
      `PACKSCOUT_LOCAL_${prefix}_DATABASE_NAME`,
      `PACKSCOUT_LOCAL_${prefix}_ROLE_NAME`,
    ];
  }),
]);

function required(
  environment: NodeJS.ProcessEnv,
  key: string,
  maximumBytes = 4_096,
): string {
  const value = environment[key];
  if (
    typeof value !== "string" || value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximumBytes || /[\r\n\0]/u.test(value)
  ) {
    refuse("PROVISION_INPUT_INVALID");
  }
  return value;
}

function password(
  environment: NodeJS.ProcessEnv,
  key: string,
  isRequired: boolean,
): string | null {
  if (!isRequired && environment[key] === undefined) return null;
  const value = required(environment, key, 512);
  if (value.length < 20 || value.length > 256) {
    refuse("PROVISION_CREDENTIAL_INVALID");
  }
  return value;
}

function providerCredentials(
  environment: NodeJS.ProcessEnv,
  action: AdditionalReviewClusterAction,
  selected: readonly Readonly<ReviewProviderDescriptor>[],
): Readonly<Record<AdditionalProviderKey, Readonly<ProviderReviewCredentialInput>>> {
  const selectedKeys = new Set(selected.map((provider) => provider.providerKey));
  return Object.freeze(Object.fromEntries(
    ADDITIONAL_PROVIDER_REVIEW_DATABASES.map((provider) => {
      const selectedForCredential = selectedKeys.has(provider.providerKey);
      const appRequired = selectedForCredential &&
        (action === "start" || action === "provision");
      return [provider.providerKey, Object.freeze({
        clusterAdminPassword: password(
          environment,
          provider.environmentKeys.clusterAdminPassword,
          action === "provision",
        ),
        appPassword: password(
          environment,
          provider.environmentKeys.appPassword,
          appRequired,
        ),
      })];
    }),
  ) as Record<AdditionalProviderKey, Readonly<ProviderReviewCredentialInput>>);
}

function credentialKey(environment: NodeJS.ProcessEnv) {
  const encoded = required(
    environment,
    PROVIDER_REVIEW_ENVIRONMENT_KEYS.credentialKey,
    128,
  );
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength !== 32 || bytes.toString("base64") !== encoded) {
    refuse("PROVIDER_CREDENTIAL_KEY_INVALID");
  }
  const value =
    environment[PROVIDER_REVIEW_ENVIRONMENT_KEYS.credentialKeyVersion] ?? "1";
  if (!/^[1-9][0-9]{0,9}$/u.test(value)) {
    refuse("PROVIDER_CREDENTIAL_KEY_VERSION_INVALID");
  }
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version > 2_147_483_647) {
    refuse("PROVIDER_CREDENTIAL_KEY_VERSION_INVALID");
  }
  return Object.freeze({ bytes: new Uint8Array(bytes), version });
}

export function assertNoProviderReviewProvisionArguments(
  argumentsList: readonly string[],
): void {
  if (argumentsList.length !== 0) refuse("ARGUMENTS_FORBIDDEN");
}

export function readProviderReviewProvisionEnvironment(
  environment: NodeJS.ProcessEnv,
): Readonly<AdditionalProviderReviewEnvironment> {
  if (environment.NODE_ENV !== "development") {
    refuse("LOCAL_DEVELOPMENT_ENVIRONMENT_REQUIRED");
  }
  if (
    CLUTCHPACKS_REVIEW_CLUSTER_ROOT !== SYSTEM_ACCOUNT_CLUSTER_ROOT ||
    (environment.HOME !== undefined && environment.HOME !== os.userInfo().homedir)
  ) {
    refuse("CLUSTER_REDIRECT_FORBIDDEN");
  }
  for (const key of FORBIDDEN_REDIRECT_KEYS) {
    if (environment[key] !== undefined) refuse("CLUSTER_REDIRECT_FORBIDDEN");
  }
  const actionValue =
    environment[PROVIDER_REVIEW_ENVIRONMENT_KEYS.action] ?? "inspect";
  const targetValue =
    environment[PROVIDER_REVIEW_ENVIRONMENT_KEYS.target] ?? "all";
  if (!ACTIONS.has(actionValue as AdditionalReviewClusterAction)) {
    refuse("CLUSTER_ACTION_INVALID");
  }
  const action = actionValue as AdditionalReviewClusterAction;
  const targetProvider = PROVIDER_BY_KEY.get(targetValue as AdditionalProviderKey);
  if (targetValue !== "all" && targetProvider === undefined) {
    refuse("CLUSTER_ACTION_INVALID");
  }
  if (action === "provision" && targetValue !== "all") {
    refuse("PROVISION_REQUIRES_ALL_ADDITIONAL_PROVIDERS");
  }
  if ((action === "start" || action === "stop") && targetValue === "all") {
    refuse("CLUSTER_LIFECYCLE_TARGET_MUST_BE_INDIVIDUAL");
  }
  const selected = targetValue === "all"
    ? ADDITIONAL_PROVIDER_REVIEW_DATABASES
    : Object.freeze([targetProvider!]);
  const credentials = providerCredentials(environment, action, selected);
  const base = Object.freeze({
    action,
    target: targetValue as AdditionalReviewClusterTarget,
    selected,
    credentials,
  });
  if (action !== "provision") {
    return base as Readonly<ProviderReviewReadEnvironment | ProviderReviewStopEnvironment>;
  }
  const centralAppPassword = password(
    environment,
    PROVIDER_REVIEW_ENVIRONMENT_KEYS.centralAppPassword,
    true,
  )!;
  const clutchpacksAppPassword = password(
    environment,
    PROVIDER_REVIEW_ENVIRONMENT_KEYS.clutchpacksAppPassword,
    true,
  )!;
  const allPasswords = [
    centralAppPassword,
    clutchpacksAppPassword,
    ...ADDITIONAL_PROVIDER_REVIEW_DATABASES.flatMap((provider) => {
      const values = credentials[provider.providerKey];
      return [values.clusterAdminPassword!, values.appPassword!];
    }),
  ];
  if (new Set(allPasswords).size !== allPasswords.length) {
    refuse("CLUSTER_CREDENTIALS_NOT_DISTINCT");
  }
  const organizationSlug =
    (environment[PROVIDER_REVIEW_ENVIRONMENT_KEYS.organizationSlug] ??
      "packscout-local-review").trim();
  const adminEmail = required(
    environment,
    PROVIDER_REVIEW_ENVIRONMENT_KEYS.adminEmail,
    254,
  ).trim().toLocaleLowerCase("en-US");
  if (!SAFE_SLUG_PATTERN.test(organizationSlug) || !EMAIL_PATTERN.test(adminEmail)) {
    refuse("CENTRAL_BASELINE_IDENTITY_INVALID");
  }
  return Object.freeze({
    ...base,
    action: "provision",
    target: "all",
    centralAppPassword,
    clutchpacksAppPassword,
    organizationSlug,
    adminEmail,
    credentialKey: credentialKey(environment),
  });
}

export function assertDistinctProviderReviewClusterProofs(
  proofs: readonly Readonly<{
    clusterKey: string;
    dataDirectory: string;
    databaseName: string;
    port: number;
    systemIdentifier: string;
  }>[],
): void {
  if (proofs.length !== ALL_PROVIDER_REVIEW_DATABASES.length) {
    refuse("CLUSTER_ISOLATION_PROOF_FAILED");
  }
  const byKey = new Map(proofs.map((proof) => [proof.clusterKey, proof]));
  for (const expected of ALL_PROVIDER_REVIEW_DATABASES) {
    const actual = byKey.get(expected.clusterKey);
    if (
      actual === undefined || actual.dataDirectory !== expected.dataDirectory ||
      actual.databaseName !== expected.databaseName || actual.port !== expected.port ||
      !/^[1-9][0-9]*$/u.test(actual.systemIdentifier)
    ) {
      refuse("CLUSTER_ISOLATION_PROOF_FAILED");
    }
  }
  for (const field of ["dataDirectory", "port", "systemIdentifier"] as const) {
    if (new Set(proofs.map((proof) => proof[field])).size !== proofs.length) {
      refuse("CLUSTER_ISOLATION_PROOF_FAILED");
    }
  }
}

export function buildSanitizedProviderReviewIsolationProof(
  inputs: readonly Readonly<ProviderReviewIsolationInput>[],
): readonly Readonly<SanitizedProviderReviewIsolationFact>[] {
  const expectedProviders = [
    CLUTCHPACKS_REVIEW_DATABASES.provider,
    ...ADDITIONAL_PROVIDER_REVIEW_DATABASES,
  ];
  if (inputs.length !== expectedProviders.length) {
    refuse("PROVIDER_ISOLATION_PROOF_FAILED");
  }
  const byProvider = new Map(inputs.map((input) => [input.providerKey, input]));
  if (byProvider.size !== expectedProviders.length) {
    refuse("PROVIDER_ISOLATION_PROOF_FAILED");
  }
  const ordered = expectedProviders.map((expected) => {
    const input = byProvider.get(expected.clusterKey as LaunchProviderKey);
    if (
      input === undefined || input.dataDirectory !== expected.dataDirectory ||
      input.databaseName !== expected.databaseName || input.port !== expected.port ||
      input.schemaVersion !== "distributed-provider-v1" ||
      !/^[1-9][0-9]*$/u.test(input.systemIdentifier) ||
      !UUID_PATTERN.test(input.providerId) ||
      !UUID_PATTERN.test(input.databaseNodeId) ||
      !UUID_PATTERN.test(input.databaseCredentialVersionId)
    ) {
      refuse("PROVIDER_ISOLATION_PROOF_FAILED");
    }
    return input;
  });
  for (const field of [
    "providerId",
    "dataDirectory",
    "databaseName",
    "port",
    "systemIdentifier",
    "databaseNodeId",
    "databaseCredentialVersionId",
  ] as const) {
    if (new Set(ordered.map((input) => input[field])).size !== ordered.length) {
      refuse("PROVIDER_ISOLATION_PROOF_FAILED");
    }
  }
  return Object.freeze(ordered.map((input) => Object.freeze({
    providerKey: input.providerKey,
    providerId: input.providerId,
    databaseName: input.databaseName,
    port: input.port,
    schemaVersion: "distributed-provider-v1" as const,
    systemIdentifier: input.systemIdentifier,
    dataDirectoryHash: providerReviewDataDirectoryHash(input.dataDirectory),
    databaseNodeId: input.databaseNodeId,
    databaseCredentialVersionId: input.databaseCredentialVersionId,
    stateOwnership: Object.freeze({
      databaseName: input.databaseName,
      runtimeTable: "provider_runtime" as const,
      leaseTable: "provider_worker_states" as const,
      commandTable: "control_commands" as const,
      cursorTable: "provider_runtime" as const,
    }),
  })));
}

export function providerReviewDataDirectoryHash(dataDirectory: string): string {
  return createHash("sha256")
    .update("packscout-provider-review-data-directory-v1\0", "utf8")
    .update(dataDirectory, "utf8")
    .digest("hex");
}

export function assertAdditionalProviderRuntimeSelection(
  facts: readonly Readonly<AdditionalProviderRuntimeFact>[],
): void {
  if (facts.length !== ADDITIONAL_PROVIDER_REVIEW_DATABASES.length) {
    refuse("PROVIDER_RUNTIME_SELECTION_FAILED");
  }
  const byProvider = new Map(facts.map((fact) => [fact.providerKey, fact]));
  if (
    byProvider.size !== ADDITIONAL_PROVIDER_REVIEW_DATABASES.length ||
    ADDITIONAL_PROVIDER_REVIEW_DATABASES.some((provider) =>
      byProvider.get(provider.providerKey)?.running !== true
    )
  ) {
    refuse("PROVIDER_RUNTIME_SELECTION_FAILED");
  }
}

export function buildAdditionalProviderProvisionPlan<
  T extends Readonly<Record<AdditionalProviderKey, Readonly<object>>>,
>(identities: T) {
  for (const provider of ADDITIONAL_PROVIDER_REVIEW_DATABASES) {
    const providerIds = identities[provider.providerKey];
    if (
      providerIds === undefined ||
      Object.values(providerIds).some((value) =>
        typeof value !== "string" || !UUID_PATTERN.test(value)
      )
    ) {
      refuse("PROVISION_IDENTITY_INVALID");
    }
  }
  return Object.freeze({
    providers: ADDITIONAL_PROVIDER_REVIEW_DATABASES,
    identities,
    stages: Object.freeze([
      "verify_existing_control_and_clutchpacks_read_only",
      "verify_fixed_pg16_binaries_and_cluster_layout",
      "initialize_or_resume_additional_provider_clusters",
      "prove_all_five_cluster_system_identifiers_are_distinct",
      "create_additional_provider_roles_and_databases",
      "deploy_provider_template_migrations",
      "initialize_provider_identity_and_idle_runtime",
      "grant_explicit_provider_runtime_tables",
      "verify_zero_runs_commands_cursors_and_canonical_mutations",
      "register_provider_profile_config_credentials_node_tests_and_audit",
      "mark_only_additional_provider_clusters_provisioned",
      "keep_all_provider_databases_reachable_and_only_run_installed_courtyard",
    ]),
  });
}

export function safeProviderReviewProvisionFailure(error: unknown) {
  return Object.freeze({
    ok: false,
    operation: "manage_additional_provider_review_clusters",
    code: error instanceof ProviderReviewProvisionError ||
        error instanceof ClutchpacksReviewProvisionError
      ? error.code
      : "UNEXPECTED_LOCAL_CLUSTER_FAILURE",
  });
}

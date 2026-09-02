import type {
  ManifestGateExplicitOperation,
  ManifestGateIntent,
} from "@packscout/database";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAXIMUM_COMMAND_AGE_MS = 5 * 60_000;
const MAXIMUM_CLOCK_SKEW_MS = 30_000;
const UNRELATED_AUTHORITY_KEYS = Object.freeze([
  "PACKSCOUT_CONVEX_PUBLICATION_BASE_URL",
  "PACKSCOUT_PROVIDER_DATABASE_URL",
  "PACKSCOUT_PROMOTION_PROVIDER_ID",
  "PACKSCOUT_PROMOTION_PROVIDER_KEY_ID",
  "PACKSCOUT_PROMOTION_PROVIDER_SECRET_BASE64",
  "PACKSCOUT_PROMOTION_PROVIDER_BOOTSTRAP_BASE_URL",
  "PACKSCOUT_PROMOTION_PROVIDER_BOOTSTRAP_TOKEN_BASE64",
  "PACKSCOUT_PROMOTION_MANIFEST_KEY_ID",
  "PACKSCOUT_PROMOTION_MANIFEST_SECRET_BASE64",
  "PACKSCOUT_PROMOTION_MANIFEST_AUTHORITY_VERSION",
  "PACKSCOUT_DISTRIBUTED_PROMOTION_MANUAL_PUBLIC_KEY_PEM",
  "PACKSCOUT_DISTRIBUTED_PROMOTION_MANUAL_PRIVATE_KEY_PEM",
] as const);

export type DistributedManifestGateOperationCommandErrorCode =
  | "DISTRIBUTED_MANIFEST_OPERATION_AUTHORITY_CONFLICT"
  | "DISTRIBUTED_MANIFEST_OPERATION_ENVIRONMENT_INVALID"
  | "DISTRIBUTED_MANIFEST_OPERATION_INPUT_INVALID";

export class DistributedManifestGateOperationCommandError extends Error {
  constructor(readonly code: DistributedManifestGateOperationCommandErrorCode) {
    super("Distributed manifest operation command is invalid.");
    this.name = "DistributedManifestGateOperationCommandError";
  }
}

export interface DistributedManifestGateOperationCommandConfiguration {
  readonly providerId: string;
  readonly operation: ManifestGateExplicitOperation;
  readonly targetProviderReleaseId: string | null;
  readonly targetCatalogVersionId: string | null;
  readonly requestedByOperatorId: string;
  readonly authorizationDigest: string;
  readonly requestedAt: Date;
}

export interface DistributedManifestGateOperationCommandPort {
  authorizeExplicit(input: DistributedManifestGateOperationCommandConfiguration):
    Promise<ManifestGateIntent>;
}

function fail(code: DistributedManifestGateOperationCommandErrorCode): never {
  throw new DistributedManifestGateOperationCommandError(code);
}

function uuid(value: string | undefined): string {
  if (!value || !UUID_PATTERN.test(value)) {
    fail("DISTRIBUTED_MANIFEST_OPERATION_INPUT_INVALID");
  }
  return value.toLowerCase();
}

function instant(value: string | undefined): Date {
  if (!value) fail("DISTRIBUTED_MANIFEST_OPERATION_INPUT_INVALID");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    fail("DISTRIBUTED_MANIFEST_OPERATION_INPUT_INVALID");
  }
  return parsed;
}

/**
 * Reads one exact central-only operator authorization. The command has no
 * provider database, publication credential, routing, or all-provider mode.
 */
export function readDistributedManifestGateOperationCommandConfiguration(
  environment: NodeJS.ProcessEnv,
  now: () => Date = () => new Date(),
): DistributedManifestGateOperationCommandConfiguration {
  if (
    environment.PACKSCOUT_DISTRIBUTED_PROMOTION_MODE !== "split" ||
    !["development", "production"].includes(environment.NODE_ENV ?? "")
  ) fail("DISTRIBUTED_MANIFEST_OPERATION_ENVIRONMENT_INVALID");
  if (UNRELATED_AUTHORITY_KEYS.some((key) => environment[key] !== undefined)) {
    fail("DISTRIBUTED_MANIFEST_OPERATION_AUTHORITY_CONFLICT");
  }
  const requestedOperation =
    environment.PACKSCOUT_DISTRIBUTED_MANIFEST_OPERATION;
  if (
    !["advance", "add", "remove", "rollback"].includes(
      requestedOperation ?? "",
    )
  ) fail("DISTRIBUTED_MANIFEST_OPERATION_INPUT_INVALID");
  const operation = requestedOperation as ManifestGateExplicitOperation;
  const releaseValue =
    environment.PACKSCOUT_DISTRIBUTED_MANIFEST_OPERATION_PROVIDER_RELEASE_ID;
  const catalogValue =
    environment.PACKSCOUT_DISTRIBUTED_MANIFEST_OPERATION_CATALOG_VERSION_ID;
  const remove = operation === "remove";
  if (
    remove ? releaseValue !== undefined || catalogValue !== undefined
      : releaseValue === undefined || catalogValue === undefined
  ) fail("DISTRIBUTED_MANIFEST_OPERATION_INPUT_INVALID");
  const authorizationDigest =
    environment.PACKSCOUT_DISTRIBUTED_MANIFEST_OPERATION_AUTHORIZATION_SHA256;
  if (!authorizationDigest || !SHA256_PATTERN.test(authorizationDigest)) {
    fail("DISTRIBUTED_MANIFEST_OPERATION_INPUT_INVALID");
  }
  const requestedAt = instant(
    environment.PACKSCOUT_DISTRIBUTED_MANIFEST_OPERATION_REQUESTED_AT,
  );
  const observedAt = now();
  if (
    !Number.isFinite(observedAt.getTime()) ||
    requestedAt.getTime() < observedAt.getTime() - MAXIMUM_COMMAND_AGE_MS ||
    requestedAt.getTime() > observedAt.getTime() + MAXIMUM_CLOCK_SKEW_MS
  ) fail("DISTRIBUTED_MANIFEST_OPERATION_INPUT_INVALID");
  return Object.freeze({
    providerId: uuid(
      environment.PACKSCOUT_DISTRIBUTED_MANIFEST_OPERATION_PROVIDER_ID,
    ),
    operation,
    targetProviderReleaseId: remove ? null : uuid(releaseValue),
    targetCatalogVersionId: remove ? null : uuid(catalogValue),
    requestedByOperatorId: uuid(
      environment.PACKSCOUT_DISTRIBUTED_MANIFEST_OPERATION_OPERATOR_ID,
    ),
    authorizationDigest,
    requestedAt,
  });
}

export async function runDistributedManifestGateOperationCommand(
  repository: DistributedManifestGateOperationCommandPort,
  configuration: DistributedManifestGateOperationCommandConfiguration,
): Promise<Readonly<{
  status: "authorized";
  operation: ManifestGateExplicitOperation;
  requestedGeneration: string;
  pending: true;
  authorizationDigest: string;
}>> {
  const intent = await repository.authorizeExplicit(configuration);
  if (
    intent.requestedOperation !== configuration.operation ||
    intent.authorizationDigest !== configuration.authorizationDigest ||
    !intent.pending || intent.operationGeneration === null
  ) throw new DistributedManifestGateOperationCommandError(
    "DISTRIBUTED_MANIFEST_OPERATION_INPUT_INVALID",
  );
  return Object.freeze({
    status: "authorized",
    operation: configuration.operation,
    requestedGeneration: intent.operationGeneration.toString(),
    pending: true,
    authorizationDigest: configuration.authorizationDigest,
  });
}

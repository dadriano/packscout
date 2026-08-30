import { launchProviderKeySchema, type LaunchProviderKey } from
  "@packscout/contracts";
import type {
  ProviderDatabaseRoute,
  ProviderPrismaClient,
} from "@packscout/database";
import {
  StaticDataforrestSourceAuthorityResolver,
  type ResolvedDataforrestSourceAuthority,
} from
  "./dataforrest-source-authority-resolver.ts";
import type {
  ProviderDataforrestLiveIntegration,
} from
  "./provider-dataforrest-live-integration.ts";
import { PROVIDER_MANUAL_IMPORT_MAXIMUM_PAGES } from
  "./provider-manual-import-bounds.ts";
import type {
  ProviderManualImportExecutionResult,
  ProviderManualImportExecutor,
  ProviderManualImportInterruptionFailureCode,
} from "./provider-manual-import-executor.ts";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const workerIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
export const PROVIDER_MANUAL_IMPORT_MAXIMUM_ROUTED_PAGE_STEPS =
  PROVIDER_MANUAL_IMPORT_MAXIMUM_PAGES;

export type ProviderManualImportLocalFailureCode =
  | "PROVIDER_IMPORT_AUTHORITY_EXPIRED"
  | "PROVIDER_IMPORT_AUTHORITY_INVALID"
  | "PROVIDER_IMPORT_CONFIGURATION_INVALID"
  | "PROVIDER_IMPORT_DATABASE_UNAVAILABLE"
  | "PROVIDER_IMPORT_IDENTITY_UNAVAILABLE"
  | "PROVIDER_IMPORT_STEP_LIMIT_EXCEEDED";

export class ProviderManualImportLocalError extends Error {
  constructor(readonly code: ProviderManualImportLocalFailureCode) {
    super(code);
    this.name = "ProviderManualImportLocalError";
  }
}

export interface ProviderManualImportLocalConfiguration {
  readonly providerId: string;
  readonly providerKey: LaunchProviderKey;
  readonly workerId: string;
}

function configurationError(): never {
  throw new ProviderManualImportLocalError(
    "PROVIDER_IMPORT_CONFIGURATION_INVALID",
  );
}

function required(value: string | undefined): string {
  const normalized = value?.trim() ?? "";
  if (normalized.length === 0 || /[\r\n\0]/u.test(normalized)) {
    configurationError();
  }
  return normalized;
}

export function readProviderManualImportLocalConfiguration(
  environment: NodeJS.ProcessEnv,
  fallbackWorkerId: string,
): ProviderManualImportLocalConfiguration {
  const providerId = required(environment.PACKSCOUT_PROVIDER_ID);
  const parsedProvider = launchProviderKeySchema.safeParse(
    required(environment.PACKSCOUT_PROVIDER_KEY),
  );
  const workerId = environment.PACKSCOUT_PROVIDER_WORKER_ID === undefined
    ? fallbackWorkerId
    : required(environment.PACKSCOUT_PROVIDER_WORKER_ID);
  if (
    !uuidPattern.test(providerId)
    || !parsedProvider.success
    || !workerIdPattern.test(workerId)
  ) {
    configurationError();
  }
  return Object.freeze({
    providerId,
    providerKey: parsedProvider.data,
    workerId,
  });
}

interface RoutedProviderDatabaseResult<T> {
  readonly state: "reachable" | "unreachable";
  readonly value?: T;
}

export interface ProviderManualImportBootstrap {
  readonly organizationId: string;
  readonly providerId: string;
  readonly providerKey: LaunchProviderKey;
  readonly databaseRoute: ProviderDatabaseRoute;
  readonly sourceAuthority: ResolvedDataforrestSourceAuthority;
  readonly integration: ProviderDataforrestLiveIntegration;
}

export interface ProviderManualImportLocalDependencies {
  bootstrapProvider(input: Readonly<{
    providerId: string;
    providerKey: LaunchProviderKey;
  }>): Promise<ProviderManualImportBootstrap | null>;
  runWithCachedProviderDatabase<T>(
    route: ProviderDatabaseRoute,
    operation: (database: ProviderPrismaClient) => Promise<T>,
  ): Promise<RoutedProviderDatabaseResult<T>>;
  createExecutor(input: Readonly<{
    database: ProviderPrismaClient;
    providerId: string;
    providerKey: LaunchProviderKey;
    workerId: string;
    sourceAuthority: ResolvedDataforrestSourceAuthority;
    sourceAuthorityResolver: Pick<
      StaticDataforrestSourceAuthorityResolver,
      "resolve"
    >;
    integration: ProviderDataforrestLiveIntegration;
  }>): Pick<
    ProviderManualImportExecutor,
    "executeNextPage" | "terminalizeProgress"
  >;
  now?: () => Date;
  relayProviderActivity?(): Promise<void>;
  observeRelayFailure?(failureCode: "CENTRAL_ACTIVITY_UNAVAILABLE"): void;
}

/**
 * Resolves one central-owned provider route and advances it in independently
 * bounded page steps. No central or process-global execution lock is held.
 */
export async function runProviderManualImportOnce(input: Readonly<{
  environment: NodeJS.ProcessEnv;
  fallbackWorkerId: string;
  signal?: AbortSignal;
  dependencies: ProviderManualImportLocalDependencies;
}>): Promise<ProviderManualImportExecutionResult> {
  const configuration = readProviderManualImportLocalConfiguration(
    input.environment,
    input.fallbackWorkerId,
  );
  const bootstrap = await input.dependencies.bootstrapProvider({
    providerId: configuration.providerId,
    providerKey: configuration.providerKey,
  }).catch(() => null);
  if (bootstrap === null) {
    throw new ProviderManualImportLocalError(
      "PROVIDER_IMPORT_IDENTITY_UNAVAILABLE",
    );
  }
  const authority = bootstrap.sourceAuthority;
  const route = bootstrap.databaseRoute;
  const integration = bootstrap.integration;
  if (
    bootstrap.providerId !== configuration.providerId
    || bootstrap.providerKey !== configuration.providerKey
    || !uuidPattern.test(bootstrap.organizationId)
    || route.organizationId !== bootstrap.organizationId
    || route.target.providerId !== bootstrap.providerId
    || route.target.providerKey !== bootstrap.providerKey
    || route.configVersionId !== authority.configVersionId
    || authority.organizationId !== bootstrap.organizationId
    || authority.providerId !== bootstrap.providerId
    || authority.providerKey !== bootstrap.providerKey
    || authority.sourceConfiguration.platform !== bootstrap.providerKey
    || integration.providerKey !== bootstrap.providerKey
    || integration.manifest.adapterVersion !== authority.adapterKey
    || integration.manifest.adapterVersion !== authority.sourceAdapterVersion
    || integration.manifest.sourceTypeKey !== authority.sourceTypeKey
  ) {
    throw new ProviderManualImportLocalError(
      "PROVIDER_IMPORT_AUTHORITY_INVALID",
    );
  }

  const now = input.dependencies.now ?? (() => new Date());
  const authorityExpiresAtMilliseconds = authority.expiresAt === null
    ? null
    : authority.expiresAt instanceof Date
      ? authority.expiresAt.getTime()
      : Number.NaN;
  const authorityExpired = (): boolean => {
    const observed = now();
    return !(observed instanceof Date)
      || !Number.isFinite(observed.getTime())
      || (authorityExpiresAtMilliseconds !== null
        && (!Number.isFinite(authorityExpiresAtMilliseconds)
          || authorityExpiresAtMilliseconds <= observed.getTime()));
  };
  if (authorityExpired()) {
    throw new ProviderManualImportLocalError(
      "PROVIDER_IMPORT_AUTHORITY_EXPIRED",
    );
  }
  const sourceAuthorityResolver = new StaticDataforrestSourceAuthorityResolver({
    authority,
    now,
  });

  const createExecutor = (database: ProviderPrismaClient) =>
    input.dependencies.createExecutor({
      database,
      providerId: bootstrap.providerId,
      providerKey: bootstrap.providerKey,
      workerId: configuration.workerId,
      sourceAuthority: authority,
      sourceAuthorityResolver,
      integration,
    });
  const terminalizeProgress = async (
    progress: Extract<ProviderManualImportExecutionResult, { kind: "progress" }>,
    failureCode: ProviderManualImportInterruptionFailureCode,
  ): Promise<ProviderManualImportExecutionResult> => {
    const routed = await input.dependencies.runWithCachedProviderDatabase(
      route,
      (database) => createExecutor(database).terminalizeProgress({
        progress,
        failureCode,
      }),
    );
    if (routed.state !== "reachable" || routed.value === undefined) {
      throw new ProviderManualImportLocalError(
        "PROVIDER_IMPORT_DATABASE_UNAVAILABLE",
      );
    }
    return routed.value;
  };

  let result: ProviderManualImportExecutionResult | null = null;
  for (
    let step = 0;
    step < PROVIDER_MANUAL_IMPORT_MAXIMUM_ROUTED_PAGE_STEPS;
    step += 1
  ) {
    if (authorityExpired()) {
      if (result?.kind === "progress") {
        await terminalizeProgress(result, "PROVIDER_IMPORT_AUTHORITY_EXPIRED");
      }
      throw new ProviderManualImportLocalError(
        "PROVIDER_IMPORT_AUTHORITY_EXPIRED",
      );
    }
    if (input.signal?.aborted) {
      result = result?.kind === "progress"
        ? await terminalizeProgress(result, "PROVIDER_CAPTURE_ABORTED")
        : {
            kind: "blocked",
            runId: null,
            failureCode: "PROVIDER_CAPTURE_ABORTED",
          };
      break;
    }
    const previousProgress = result?.kind === "progress" ? result : null;
    const routed = await input.dependencies.runWithCachedProviderDatabase(
      route,
      (database) => createExecutor(database).executeNextPage(input.signal),
    );
    if (routed.state !== "reachable" || routed.value === undefined) {
      throw new ProviderManualImportLocalError(
        "PROVIDER_IMPORT_DATABASE_UNAVAILABLE",
      );
    }
    result = routed.value;
    if (
      previousProgress !== null
      && result.kind === "blocked"
      && result.runId === null
      && result.failureCode === "PROVIDER_CAPTURE_ABORTED"
    ) {
      result = await terminalizeProgress(
        previousProgress,
        "PROVIDER_CAPTURE_ABORTED",
      );
    }
    if (result.kind !== "progress") break;
  }
  if (result === null || result.kind === "progress") {
    if (result?.kind === "progress") {
      await terminalizeProgress(result, "PROVIDER_IMPORT_STEP_LIMIT_EXCEEDED");
    }
    throw new ProviderManualImportLocalError(
      "PROVIDER_IMPORT_STEP_LIMIT_EXCEEDED",
    );
  }

  if (input.dependencies.relayProviderActivity) {
    try {
      await input.dependencies.relayProviderActivity();
    } catch {
      try {
        input.dependencies.observeRelayFailure?.(
          "CENTRAL_ACTIVITY_UNAVAILABLE",
        );
      } catch {
        // Best-effort observer failures never change committed provider work.
      }
    }
  }
  return result;
}

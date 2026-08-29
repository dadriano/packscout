import path from "node:path";
import type {
  ProviderDatabaseLifecycle,
  ProviderPrismaClient,
} from "@packscout/database";
import type {
  ClutchpacksManualImportExecutionResult,
  ClutchpacksManualImportExecutor,
} from "./clutchpacks-manual-import-executor.ts";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const workerIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;

export type ClutchpacksManualImportLocalFailureCode =
  | "CLUTCHPACKS_IMPORT_CONFIGURATION_INVALID"
  | "CLUTCHPACKS_IMPORT_DATABASE_UNAVAILABLE";

export class ClutchpacksManualImportLocalError extends Error {
  constructor(readonly code: ClutchpacksManualImportLocalFailureCode) {
    super(code);
    this.name = "ClutchpacksManualImportLocalError";
  }
}

export interface ClutchpacksManualImportLocalConfiguration {
  readonly databaseUrl: string;
  readonly providerId: string;
  readonly providerKey: "clutchpacks";
  readonly captureRoot: string;
  readonly actorHmacKey: Uint8Array;
  readonly workerId: string;
}

function configurationError(): never {
  throw new ClutchpacksManualImportLocalError(
    "CLUTCHPACKS_IMPORT_CONFIGURATION_INVALID",
  );
}

function required(value: string | undefined): string {
  const normalized = value?.trim() ?? "";
  if (normalized.length === 0 || /[\r\n\0]/u.test(normalized)) {
    configurationError();
  }
  return normalized;
}

function databaseUrl(value: string | undefined): string {
  const raw = required(value);
  try {
    const parsed = new URL(raw);
    if (
      (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:")
      || parsed.hostname.length === 0
      || parsed.pathname.length < 2
    ) configurationError();
    return parsed.toString();
  } catch (error) {
    if (error instanceof ClutchpacksManualImportLocalError) throw error;
    return configurationError();
  }
}

function base64Key(value: string | undefined): Uint8Array {
  const raw = required(value);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(raw)) configurationError();
  const decoded = Buffer.from(raw, "base64");
  if (
    decoded.byteLength < 32
    || decoded.toString("base64").replace(/=+$/u, "")
      !== raw.replace(/=+$/u, "")
  ) configurationError();
  return new Uint8Array(decoded);
}

export function readClutchpacksManualImportLocalConfiguration(
  environment: NodeJS.ProcessEnv,
  fallbackWorkerId: string,
): ClutchpacksManualImportLocalConfiguration {
  const providerId = required(environment.PACKSCOUT_PROVIDER_ID);
  const providerKey = required(environment.PACKSCOUT_PROVIDER_KEY);
  const captureRoot = required(environment.PACKSCOUT_PROVIDER_CAPTURE_ROOT);
  const workerId = environment.PACKSCOUT_PROVIDER_WORKER_ID === undefined
    ? fallbackWorkerId
    : required(environment.PACKSCOUT_PROVIDER_WORKER_ID);
  if (
    !uuidPattern.test(providerId)
    || providerKey !== "clutchpacks"
    || !path.isAbsolute(captureRoot)
    || !workerIdPattern.test(workerId)
  ) configurationError();
  return Object.freeze({
    databaseUrl: databaseUrl(environment.PACKSCOUT_PROVIDER_DATABASE_URL),
    providerId,
    providerKey,
    captureRoot: path.normalize(captureRoot),
    actorHmacKey: base64Key(
      environment.PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64,
    ),
    workerId,
  });
}

export interface ClutchpacksManualImportLocalDependencies {
  createDatabaseLifecycle(input: Readonly<{
    databaseUrl: string;
    providerId: string;
    providerKey: "clutchpacks";
    connectionLimit: number;
  }>): Pick<ProviderDatabaseLifecycle, "client" | "start" | "close">;
  createExecutor(input: Readonly<{
    database: ProviderPrismaClient;
    captureRoot: string;
    actorHmacKey: Uint8Array;
    workerId: string;
  }>): Pick<ClutchpacksManualImportExecutor, "executeNext">;
  relayProviderActivity?(): Promise<void>;
  observeRelayFailure?(failureCode: "CENTRAL_ACTIVITY_UNAVAILABLE"): void;
}

/**
 * Executable one-command provider lane for local preview and controlled jobs.
 * It owns one provider connection, consumes at most one accepted command, and
 * always closes before returning.
 */
export async function runClutchpacksManualImportOnce(input: Readonly<{
  environment: NodeJS.ProcessEnv;
  fallbackWorkerId: string;
  signal?: AbortSignal;
  dependencies: ClutchpacksManualImportLocalDependencies;
}>): Promise<ClutchpacksManualImportExecutionResult> {
  const configuration = readClutchpacksManualImportLocalConfiguration(
    input.environment,
    input.fallbackWorkerId,
  );
  let lifecycle: ReturnType<
    ClutchpacksManualImportLocalDependencies["createDatabaseLifecycle"]
  >;
  try {
    lifecycle = input.dependencies.createDatabaseLifecycle({
      databaseUrl: configuration.databaseUrl,
      providerId: configuration.providerId,
      providerKey: configuration.providerKey,
      connectionLimit: 2,
    });
  } catch {
    throw new ClutchpacksManualImportLocalError(
      "CLUTCHPACKS_IMPORT_DATABASE_UNAVAILABLE",
    );
  }
  let result: ClutchpacksManualImportExecutionResult;
  try {
    try {
      await lifecycle.start();
    } catch {
      throw new ClutchpacksManualImportLocalError(
        "CLUTCHPACKS_IMPORT_DATABASE_UNAVAILABLE",
      );
    }
    const executor = input.dependencies.createExecutor({
      database: lifecycle.client,
      captureRoot: configuration.captureRoot,
      actorHmacKey: configuration.actorHmacKey,
      workerId: configuration.workerId,
    });
    result = await executor.executeNext(input.signal);
  } finally {
    await lifecycle.close();
  }
  if (input.dependencies.relayProviderActivity) {
    try {
      await input.dependencies.relayProviderActivity();
    } catch {
      try {
        input.dependencies.observeRelayFailure?.("CENTRAL_ACTIVITY_UNAVAILABLE");
      } catch {
        // Best-effort observer failures never change committed provider work.
      }
    }
  }
  return result;
}

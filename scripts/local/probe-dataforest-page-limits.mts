import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  DATAFORREST_EVENTS_V1_ENDPOINT,
  DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
  dataforrestEventsConnectionConfigurationV1Schema,
  dataforrestEventsPageV1Schema,
  launchProviderKeys,
  type LaunchProviderKey,
} from "@packscout/contracts";
import {
  AesGcmSourceConnectionConfigurationCipher,
  HardenedProviderRequestError,
  captureHardenedProviderResponse,
  type HardenedProviderRequestInput,
  type HardenedProviderResponseCapture,
} from "@packscout/services";
import dotenv from "dotenv";
import { Client, type QueryResultRow } from "pg";
import {
  ProviderSourceSupervisorConfigurationError,
  readProviderSourceSupervisorConfiguration,
} from "../../apps/worker/src/source-supervisor-runtime-config.ts";
import { isBoundedDataforrestEventsPageV1 } from
  "../../packages/services/src/dataforrest-events-page-interpreter.ts";

const ACTIVE_CONNECTION_PROFILE_ID =
  "bb2f4087-750e-4d67-8415-4bdf6c0efc7f";
const RUNTIME_ENVIRONMENT_PATH =
  "/Users/lains/Projects/packscout-import-runtime/.env";
const EXPECTED_RUNTIME_ENVIRONMENT_REALPATH =
  "/Users/lains/Projects/packscout-local-runtime/.env";

export const DATAFOREST_PAGE_PROBE_TARGETS = Object.freeze([
  500,
  1_000,
  2_500,
] as const);
export const DATAFOREST_PAGE_PROBE_PLATFORMS = Object.freeze([
  ...launchProviderKeys,
]);
export const DATAFOREST_PAGE_PROBE_BOUNDS = Object.freeze({
  maximumRequests: 12,
  maximumResponseBytesPerRequest: 8 * 1024 * 1024,
  maximumResponseBytesTotal: 12 * 8 * 1024 * 1024,
  requestTimeoutMilliseconds: 10_000,
  maximumWallClockMilliseconds: 125_000,
  concurrency: 1,
});

type PageProbeTarget = (typeof DATAFOREST_PAGE_PROBE_TARGETS)[number];

interface ActiveConnectionRevisionRow extends QueryResultRow {
  readonly organizationId: string;
  readonly connectionProfileId: string;
  readonly connectionRevisionId: string;
  readonly configurationCiphertext: Buffer;
  readonly configurationNonce: Buffer;
  readonly configurationAuthTag: Buffer;
  readonly encryptionKeyVersion: number;
}

export interface DataforestPageProbeMeasurement {
  readonly platform: LaunchProviderKey;
  readonly requestedRecords: PageProbeTarget;
  readonly returnedRecords: number | null;
  readonly responseBytes: number | null;
  readonly latencyMs: number;
  readonly outcome:
    | "safe"
    | "contract_invalid"
    | "structure_invalid"
    | "http_status"
    | "network_error"
    | "request_timeout"
    | "response_too_large"
    | "short_page"
    | "wrong_platform"
    | "probe_failure";
}

export interface DataforestPageProbeReport {
  readonly schemaVersion: 1;
  readonly kind: "sanitized_dataforest_page_limit_probe";
  readonly bounds: typeof DATAFOREST_PAGE_PROBE_BOUNDS;
  readonly measurements: readonly DataforestPageProbeMeasurement[];
  readonly largestViableTarget: PageProbeTarget | null;
}

interface LocalProbeEnvironment {
  readonly databaseUrl: string;
  readonly sourceConnectionKey: Uint8Array;
  readonly sourceConnectionKeyVersion: number;
}

type PageCapture = (
  input: HardenedProviderRequestInput,
) => Promise<HardenedProviderResponseCapture>;

export class DataforestPageProbeSafetyError extends Error {
  constructor(readonly code: string) {
    super("DataForrest page-limit probe failed a local safety check.");
    this.name = "DataforestPageProbeSafetyError";
  }
}

function safeProbeError(error: unknown): DataforestPageProbeSafetyError {
  if (error instanceof DataforestPageProbeSafetyError) return error;
  if (error instanceof ProviderSourceSupervisorConfigurationError) {
    return new DataforestPageProbeSafetyError(error.code);
  }
  return new DataforestPageProbeSafetyError("PROBE_FAILED");
}

function assertExactLocalDatabase(databaseUrl: string): void {
  const parsed = new URL(databaseUrl);
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) ||
    databaseName.length === 0 ||
    ["postgres", "template0", "template1"].includes(databaseName) ||
    parsed.hash.length > 0
  ) {
    throw new DataforestPageProbeSafetyError("DATABASE_TARGET_NOT_EXACT_LOCAL");
  }
}

function activeRevisionQuery(): string {
  return `
    select profile.organization_id::text as "organizationId",
           profile.id::text as "connectionProfileId",
           revision.id::text as "connectionRevisionId",
           revision.configuration_ciphertext as "configurationCiphertext",
           revision.configuration_nonce as "configurationNonce",
           revision.configuration_auth_tag as "configurationAuthTag",
           revision.encryption_key_version as "encryptionKeyVersion"
    from public.source_connection_profiles as profile
    join public.source_connection_revisions as revision
      on revision.id = profile.active_revision_id
     and revision.organization_id = profile.organization_id
     and revision.connection_profile_id = profile.id
    where profile.id = $1::uuid
      and profile.state = 'active'
      and profile.source_type_key = $2
      and revision.state = 'active'
      and revision.source_type_key = profile.source_type_key
      and revision.source_adapter_version = $3
  `;
}

export function assertNoPageProbeArguments(
  argumentsList: readonly string[],
): void {
  if (argumentsList.length !== 0) {
    throw new DataforestPageProbeSafetyError("COMMAND_ARGUMENTS_FORBIDDEN");
  }
}

export async function loadLocalProbeEnvironment(
  input: Readonly<{
    requestedPath?: string;
    expectedRealpath?: string;
  }> = {},
): Promise<LocalProbeEnvironment> {
  const requestedPath = input.requestedPath ?? RUNTIME_ENVIRONMENT_PATH;
  const expectedRealpath =
    input.expectedRealpath ?? EXPECTED_RUNTIME_ENVIRONMENT_REALPATH;
  try {
    const [requestedMetadata, canonicalPath] = await Promise.all([
      lstat(requestedPath),
      realpath(requestedPath),
    ]);
    const targetMetadata = await lstat(canonicalPath);
    const currentUserId =
      typeof process.getuid === "function" ? process.getuid() : null;
    if (
      !path.isAbsolute(requestedPath) ||
      !requestedMetadata.isSymbolicLink() ||
      canonicalPath !== expectedRealpath ||
      !targetMetadata.isFile() ||
      targetMetadata.isSymbolicLink() ||
      (currentUserId !== null && targetMetadata.uid !== currentUserId) ||
      (targetMetadata.mode & 0o077) !== 0 ||
      (targetMetadata.mode & 0o400) === 0
    ) {
      throw new Error("unsafe");
    }
    const parsed = dotenv.parse(await readFile(canonicalPath, "utf8"));
    const environment = readProviderSourceSupervisorConfiguration(
      parsed,
      "dataforest-page-limit-probe",
    );
    if (environment.environment !== "local") {
      throw new DataforestPageProbeSafetyError("LOCAL_ENVIRONMENT_REQUIRED");
    }
    assertExactLocalDatabase(environment.databaseUrl);
    const result = Object.freeze({
      databaseUrl: environment.databaseUrl,
      sourceConnectionKey: new Uint8Array(
        environment.sourceConnectionConfigurationKey,
      ),
      sourceConnectionKeyVersion:
        environment.sourceConnectionConfigurationKeyVersion,
    });
    for (const key of Object.keys(parsed)) delete parsed[key];
    return result;
  } catch (error) {
    if (
      error instanceof DataforestPageProbeSafetyError ||
      error instanceof ProviderSourceSupervisorConfigurationError
    ) {
      throw safeProbeError(error);
    }
    throw new DataforestPageProbeSafetyError(
      "RUNTIME_ENVIRONMENT_FILE_UNSAFE",
    );
  }
}

export async function loadActiveDataforestBearerToken(
  client: Client,
  environment: LocalProbeEnvironment,
): Promise<string> {
  await client.query("begin read only");
  try {
    await client.query("set local statement_timeout = '5s'");
    const result = await client.query<ActiveConnectionRevisionRow>(
      activeRevisionQuery(),
      [
        ACTIVE_CONNECTION_PROFILE_ID,
        DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
        DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
      ],
    );
    if (result.rows.length !== 1) {
      throw new DataforestPageProbeSafetyError(
        "ACTIVE_CONNECTION_REVISION_UNAVAILABLE",
      );
    }
    const row = result.rows[0]!;
    const cipher = new AesGcmSourceConnectionConfigurationCipher({
      primaryVersion: environment.sourceConnectionKeyVersion,
      keys: new Map([[
        environment.sourceConnectionKeyVersion,
        environment.sourceConnectionKey,
      ]]),
    });
    const plaintext = cipher.decrypt(
      {
        ciphertext: new Uint8Array(row.configurationCiphertext),
        nonce: new Uint8Array(row.configurationNonce),
        authTag: new Uint8Array(row.configurationAuthTag),
        keyVersion: row.encryptionKeyVersion,
      },
      {
        organizationId: row.organizationId,
        connectionProfileId: row.connectionProfileId,
        connectionRevisionId: row.connectionRevisionId,
      },
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext);
    } catch {
      throw new DataforestPageProbeSafetyError(
        "ACTIVE_CONNECTION_CONFIGURATION_INVALID",
      );
    }
    const configuration =
      dataforrestEventsConnectionConfigurationV1Schema.safeParse(parsed);
    if (
      !configuration.success ||
      configuration.data.endpoint !== DATAFORREST_EVENTS_V1_ENDPOINT
    ) {
      throw new DataforestPageProbeSafetyError(
        "ACTIVE_CONNECTION_CONFIGURATION_INVALID",
      );
    }
    await client.query("commit");
    return configuration.data.bearerToken;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw safeProbeError(error);
  }
}

function requestUrl(
  platform: LaunchProviderKey,
  target: PageProbeTarget,
): URL {
  const url = new URL(DATAFORREST_EVENTS_V1_ENDPOINT);
  url.searchParams.set("platform", platform);
  url.searchParams.set("limit", String(target));
  return url;
}

function failureOutcome(
  error: Readonly<{
    code: HardenedProviderRequestError["code"];
  }>,
): DataforestPageProbeMeasurement["outcome"] {
  if (error.code === "http_status") return "http_status";
  if (error.code === "request_timeout") return "request_timeout";
  if (error.code === "response_too_large") return "response_too_large";
  if (
    error.code === "network_error" ||
    error.code === "destination_resolution_failed" ||
    error.code === "tls_failed"
  ) {
    return "network_error";
  }
  return "probe_failure";
}

function hardenedFailure(error: unknown): Readonly<{
  code: HardenedProviderRequestError["code"];
  durationMilliseconds: number;
}> | null {
  const codes = new Set<HardenedProviderRequestError["code"]>([
    "cancelled",
    "destination_not_allowed",
    "destination_resolution_failed",
    "http_status",
    "invalid_configuration",
    "network_error",
    "redirect_rejected",
    "request_timeout",
    "response_too_large",
    "tls_failed",
  ]);
  if (
    !(error instanceof HardenedProviderRequestError) &&
    (
      typeof error !== "object" ||
      error === null ||
      !("name" in error) ||
      error.name !== "HardenedProviderRequestError"
    )
  ) {
    return null;
  }
  const candidate = error as Readonly<{
    code?: unknown;
    durationMilliseconds?: unknown;
  }>;
  if (
    typeof candidate.code !== "string" ||
    !codes.has(candidate.code as HardenedProviderRequestError["code"]) ||
    !Number.isSafeInteger(candidate.durationMilliseconds) ||
    Number(candidate.durationMilliseconds) < 0 ||
    Number(candidate.durationMilliseconds) >
      DATAFOREST_PAGE_PROBE_BOUNDS.requestTimeoutMilliseconds
  ) {
    return null;
  }
  return {
    code: candidate.code as HardenedProviderRequestError["code"],
    durationMilliseconds: Number(candidate.durationMilliseconds),
  };
}

async function measurePage(
  platform: LaunchProviderKey,
  target: PageProbeTarget,
  bearerToken: string,
  capture: PageCapture,
): Promise<DataforestPageProbeMeasurement> {
  let response: HardenedProviderResponseCapture;
  try {
    response = await capture({
      url: requestUrl(platform, target),
      allowedHosts: [new URL(DATAFORREST_EVENTS_V1_ENDPOINT).hostname],
      headers: {
        accept: "application/json",
        authorization: `Bearer ${bearerToken}`,
      },
      timeoutMilliseconds:
        DATAFOREST_PAGE_PROBE_BOUNDS.requestTimeoutMilliseconds,
      maximumResponseBytes:
        DATAFOREST_PAGE_PROBE_BOUNDS.maximumResponseBytesPerRequest,
      signal: new AbortController().signal,
    });
  } catch (error) {
    const hardened = hardenedFailure(error);
    return Object.freeze({
      platform,
      requestedRecords: target,
      returnedRecords: null,
      responseBytes: null,
      latencyMs: hardened?.durationMilliseconds ?? 0,
      outcome: hardened === null ? "probe_failure" : failureOutcome(hardened),
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      response.protectedBody,
    ));
  } catch {
    response.protectedBody.fill(0);
    return Object.freeze({
      platform,
      requestedRecords: target,
      returnedRecords: null,
      responseBytes: response.responseBytes,
      latencyMs: response.durationMilliseconds,
      outcome: "contract_invalid",
    });
  }
  response.protectedBody.fill(0);
  const page = dataforrestEventsPageV1Schema.safeParse(parsed);
  if (!page.success) {
    return Object.freeze({
      platform,
      requestedRecords: target,
      returnedRecords: null,
      responseBytes: response.responseBytes,
      latencyMs: response.durationMilliseconds,
      outcome: "contract_invalid",
    });
  }
  if (!isBoundedDataforrestEventsPageV1(parsed, target)) {
    return Object.freeze({
      platform,
      requestedRecords: target,
      returnedRecords: null,
      responseBytes: response.responseBytes,
      latencyMs: response.durationMilliseconds,
      outcome: "structure_invalid",
    });
  }
  const returnedRecords = page.data.records.length;
  const allPlatformRecords = page.data.records.every(
    (record) => record.platform === platform,
  );
  const outcome: DataforestPageProbeMeasurement["outcome"] =
    !allPlatformRecords
      ? "wrong_platform"
      : returnedRecords !== target
        ? "short_page"
        : "safe";
  return Object.freeze({
    platform,
    requestedRecords: target,
    returnedRecords,
    responseBytes: response.responseBytes,
    latencyMs: response.durationMilliseconds,
    outcome,
  });
}

export async function probeDataforestPageLimits(
  input: Readonly<{
    bearerToken: string;
    capture?: PageCapture;
  }>,
): Promise<DataforestPageProbeReport> {
  if (
    input.bearerToken.length === 0 ||
    input.bearerToken !== input.bearerToken.trim() ||
    /[\r\n\0]/u.test(input.bearerToken)
  ) {
    throw new DataforestPageProbeSafetyError("BEARER_TOKEN_INVALID");
  }
  const capture = input.capture ?? ((request) =>
    captureHardenedProviderResponse(request));
  const measurements: DataforestPageProbeMeasurement[] = [];
  const startedAt = Date.now();
  for (const target of DATAFOREST_PAGE_PROBE_TARGETS) {
    for (const platform of DATAFOREST_PAGE_PROBE_PLATFORMS) {
      if (
        Date.now() - startedAt >
          DATAFOREST_PAGE_PROBE_BOUNDS.maximumWallClockMilliseconds
      ) {
        throw new DataforestPageProbeSafetyError("WALL_CLOCK_BUDGET_EXCEEDED");
      }
      measurements.push(
        await measurePage(platform, target, input.bearerToken, capture),
      );
    }
  }
  const viable = DATAFOREST_PAGE_PROBE_TARGETS.filter((target) =>
    DATAFOREST_PAGE_PROBE_PLATFORMS.every((platform) =>
      measurements.some(
        (measurement) =>
          measurement.platform === platform &&
          measurement.requestedRecords === target &&
          measurement.outcome === "safe",
      )
    )
  );
  const report = Object.freeze({
    schemaVersion: 1 as const,
    kind: "sanitized_dataforest_page_limit_probe" as const,
    bounds: DATAFOREST_PAGE_PROBE_BOUNDS,
    measurements: Object.freeze(measurements),
    largestViableTarget: viable.at(-1) ?? null,
  });
  if (JSON.stringify(report).includes(input.bearerToken)) {
    throw new DataforestPageProbeSafetyError("SANITIZATION_FAILED");
  }
  return report;
}

export async function runDataforestPageProbeCli(
  input: Readonly<{
    argumentsList?: readonly string[];
    write?: (value: string) => void;
  }> = {},
): Promise<void> {
  assertNoPageProbeArguments(input.argumentsList ?? process.argv.slice(2));
  const environment = await loadLocalProbeEnvironment();
  const client = new Client({ connectionString: environment.databaseUrl });
  let bearerToken = "";
  try {
    await client.connect();
    bearerToken = await loadActiveDataforestBearerToken(client, environment);
  } catch (error) {
    throw safeProbeError(error);
  } finally {
    environment.sourceConnectionKey.fill(0);
    await client.end().catch(() => undefined);
  }
  const report = await probeDataforestPageLimits({ bearerToken });
  (input.write ?? ((value) => process.stdout.write(value)))(
    `${JSON.stringify(report, null, 2)}\n`,
  );
  bearerToken = "";
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMain) {
  runDataforestPageProbeCli().catch((error: unknown) => {
    const safe = safeProbeError(error);
    console.error(`DataForrest page-limit probe failed: ${safe.code}`);
    process.exitCode = 1;
  });
}

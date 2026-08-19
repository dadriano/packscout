#!/usr/bin/env node

import { Prisma } from "@prisma/client";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { ProviderConfigurationSummary } from "@packscout/contracts";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  PipelineSetupRepository,
  PrismaProviderConfigurationRepository,
  PrismaProviderHealthRepository,
  createPrismaClientLifecycle,
  type PackscoutPrismaClient,
  type PackscoutQueryClient,
} from "@packscout/database";
import {
  AesGcmProviderCredentialCipher,
  createDataForrestProviderTransportRegistry,
} from "@packscout/services";
import { createAdminImportOperationsRuntime } from "../../apps/admin/server/import-operations-runtime.ts";
import { createProviderAdminRuntime } from "../../apps/admin/server/provider-runtime.ts";

const databaseName = "packscout_dev";
const organizationSlug = "packscout";
const organizationName = "PackScout";
const platformKey = "collector_crypt";
const providerName = "Collector Crypt";
const adapterKey = "http-cursor-v2";
const endpoint = "https://198.204.245.26.sslip.io/v1/events";
const scheduleSeconds = 300;
const staleAfterSeconds = 900;
const localDatabaseHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const canonicalBase64Pattern =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const applicationTablePattern = /^[a-z_][a-z0-9_]{0,62}$/;
const maximumBootstrapConnectionAttempts = 8;
const boundedBatchCommand = "npm run import:collector-crypt-live-batch:local";

export type CollectorCryptLiveMode =
  | "bootstrap"
  | "resume-bootstrap"
  | "request-only";

export type CollectorCryptBootstrapDisposition =
  | "initialized"
  | "recovered"
  | "already-ready";

export type CollectorCryptLiveBootstrapErrorCode =
  | "ARGUMENTS_INVALID"
  | "CONFIGURATION_MISMATCH"
  | "CONNECTION_TEST_FAILED"
  | "DATABASE_TARGET_INVALID"
  | "ENVIRONMENT_INVALID";

export class CollectorCryptLiveBootstrapError extends Error {
  constructor(readonly code: CollectorCryptLiveBootstrapErrorCode) {
    super("Collector Crypt live bootstrap could not continue safely.");
    this.name = "CollectorCryptLiveBootstrapError";
  }
}

export interface CollectorCryptLiveEnvironment {
  readonly actorPseudonymKey: Uint8Array;
  readonly bearerToken: string | null;
  readonly credentialKey: Uint8Array;
  readonly credentialKeyVersion: 1;
  readonly databaseUrl: string;
  readonly mode: CollectorCryptLiveMode;
}

export interface CollectorCryptLiveSummary {
  readonly mode: CollectorCryptLiveMode;
  readonly bootstrapDisposition: CollectorCryptBootstrapDisposition;
  readonly organizationId: string;
  readonly providerId: string;
  readonly configurationRevisionId: string;
  readonly providerState: "active";
  readonly runId: string;
  readonly runState: "queued" | "running";
  readonly coalesced: boolean;
  readonly importExecution: "queued-only";
  readonly nextCommand: typeof boundedBatchCommand;
}

export interface CollectorCryptBootstrapConnectionEvidence {
  readonly verdict: string;
  readonly responseStatus: number | null;
  readonly sanitizedCode: string | null;
  readonly detailsMatch: boolean;
  readonly actorMatches: boolean;
  readonly auditMatches: boolean;
}

export interface CollectorCryptBootstrapRecoveryEvidence {
  readonly organizationCount: number;
  readonly organizationId: string;
  readonly organizationSlug: string;
  readonly organizationName: string;
  readonly providerCount: number;
  readonly providerId: string;
  readonly providerPlatformKey: string;
  readonly providerDisplayName: string;
  readonly providerState: string;
  readonly providerActiveRevisionId: string | null;
  readonly providerNextRunPresent: boolean;
  readonly revisionCount: number;
  readonly revisionId: string;
  readonly revisionScopeMatches: boolean;
  readonly revisionCreatedActorMatches: boolean;
  readonly revisionVersion: number;
  readonly revisionSourceMode: string;
  readonly revisionAdapterKey: string;
  readonly revisionEndpoint: string;
  readonly revisionAuthMode: string;
  readonly revisionScheduleSeconds: number;
  readonly revisionStaleAfterSeconds: number;
  readonly revisionTested: boolean;
  readonly revisionTestActorMatches: boolean;
  readonly secretCount: number;
  readonly secretScopeMatches: boolean;
  readonly secretKeyVersion: number;
  readonly secretRetired: boolean;
  readonly secretMatchesBearerToken: boolean;
  readonly connectionTests: readonly CollectorCryptBootstrapConnectionEvidence[];
  readonly createAuditMatches: boolean;
  readonly activationAuditMatches: boolean;
  readonly importAuditMatches: boolean;
  readonly checkpointMatches: boolean;
  readonly lifecycleEvidenceMatches: boolean;
  readonly importRun:
    | null
    | Readonly<{
        id: string;
        exactQueuedControlledRun: boolean;
      }>;
  readonly nonEmptyTables: readonly string[];
}

export type CollectorCryptBootstrapPreparation =
  | Readonly<{ kind: "empty" }>
  | Readonly<{
      kind: "draft";
      organizationId: string;
      providerId: string;
      revisionId: string;
      connectionAlreadyTested: boolean;
    }>
  | Readonly<{
      kind: "active";
      organizationId: string;
      providerId: string;
      revisionId: string;
      existingRunId: string | null;
    }>;

export interface ExistingCollectorCryptLiveEvidence {
  readonly organizationCount: number;
  readonly organizationId: string;
  readonly organizationSlug: string;
  readonly organizationName: string;
  readonly providerCount: number;
  readonly providerId: string;
  readonly providerPlatformKey: string;
  readonly providerDisplayName: string;
  readonly providerState: string;
  readonly activeRevisionId: string | null;
  readonly revisionCount: number;
  readonly revisionId: string;
  readonly revisionVersion: number;
  readonly revisionSourceMode: string;
  readonly revisionAdapterKey: string;
  readonly revisionEndpoint: string;
  readonly revisionAuthMode: string;
  readonly revisionScheduleSeconds: number;
  readonly revisionStaleAfterSeconds: number;
  readonly revisionTested: boolean;
  readonly secretCount: number;
  readonly secretKeyVersion: number;
  readonly secretRetired: boolean;
  readonly secretDecryptable: boolean;
  readonly checkpointCount: number;
}

export interface CollectorCryptLiveRuntime {
  prepareBootstrap(
    credentialKeyVersion: number,
    bearerToken: string,
  ): Promise<CollectorCryptBootstrapPreparation>;
  createOrganization(): Promise<string>;
  createProvider(
    organizationId: string,
    bearerToken: string,
  ): Promise<ProviderConfigurationSummary>;
  testConnection(
    organizationId: string,
    providerId: string,
    revisionId: string,
  ): Promise<{ readonly verdict: string }>;
  activateProvider(
    organizationId: string,
    providerId: string,
    revisionId: string,
  ): Promise<ProviderConfigurationSummary>;
  requireExistingConfiguration(
    credentialKeyVersion: number,
  ): Promise<{ organizationId: string; providerId: string; revisionId: string }>;
  requestImport(
    organizationId: string,
    providerId: string,
    revisionId: string,
    expectedExistingRunId: string | null,
  ): Promise<{
    readonly runId: string;
    readonly runState: "queued" | "running";
    readonly coalesced: boolean;
  }>;
}

function configurationError(): never {
  throw new CollectorCryptLiveBootstrapError("CONFIGURATION_MISMATCH");
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

function exactStrings(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  const left = sorted(actual);
  const right = sorted(expected);
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function isExpectedTransientConnectionFailure(
  evidence: CollectorCryptBootstrapConnectionEvidence,
): boolean {
  if (
    !evidence.detailsMatch ||
    !evidence.actorMatches ||
    !evidence.auditMatches
  ) return false;
  if (evidence.verdict === "timeout") {
    return evidence.sanitizedCode === "timeout" && evidence.responseStatus === null;
  }
  if (evidence.verdict !== "unreachable") return false;
  if (
    ["network_error", "destination_resolution_failed"].includes(
      evidence.sanitizedCode ?? "",
    )
  ) {
    return evidence.responseStatus === null;
  }
  if (evidence.sanitizedCode !== "http_error") return false;
  const status = evidence.responseStatus;
  return (
    status !== null &&
    (status === 408 || status === 429 || status >= 500) &&
    status <= 599
  );
}

function isExpectedSuccessfulConnection(
  evidence: CollectorCryptBootstrapConnectionEvidence,
): boolean {
  return (
    evidence.verdict === "success" &&
    evidence.responseStatus === 200 &&
    evidence.sanitizedCode === null &&
    evidence.detailsMatch &&
    evidence.actorMatches &&
    evidence.auditMatches
  );
}

function expectedBootstrapTables(input: {
  readonly active: boolean;
  readonly hasConnectionTests: boolean;
  readonly hasImportRun: boolean;
}): readonly string[] {
  return [
    "audit_events",
    ...(input.active ? ["catalog_manifest_lifecycle_checkpoints"] : []),
    ...(input.hasImportRun ? ["import_runs"] : []),
    "organizations",
    ...(input.active ? ["provider_catalog_checkpoints"] : []),
    "provider_config_revisions",
    ...(input.hasConnectionTests ? ["provider_connection_tests"] : []),
    ...(input.active ? ["provider_cursor_checkpoints"] : []),
    "provider_secret_versions",
    "provider_sources",
    ...(input.active
      ? [
          "public_change_catalog_impacts",
          "public_change_causes",
          "settled_public_watermarks",
        ]
      : []),
  ];
}

export function validateCollectorCryptBootstrapRecoveryEvidence(
  evidence: CollectorCryptBootstrapRecoveryEvidence,
  expectedCredentialKeyVersion: number,
): Exclude<CollectorCryptBootstrapPreparation, { kind: "empty" }> {
  const identityExact =
    evidence.organizationCount === 1 &&
    evidence.organizationSlug === organizationSlug &&
    evidence.organizationName === organizationName &&
    evidence.providerCount === 1 &&
    evidence.providerPlatformKey === platformKey &&
    evidence.providerDisplayName === providerName &&
    evidence.revisionCount === 1 &&
    evidence.revisionScopeMatches &&
    evidence.revisionCreatedActorMatches &&
    evidence.revisionVersion === 1 &&
    evidence.revisionSourceMode === "http" &&
    evidence.revisionAdapterKey === adapterKey &&
    evidence.revisionEndpoint === endpoint &&
    evidence.revisionAuthMode === "bearer" &&
    evidence.revisionScheduleSeconds === scheduleSeconds &&
    evidence.revisionStaleAfterSeconds === staleAfterSeconds &&
    evidence.secretCount === 1 &&
    evidence.secretScopeMatches &&
    evidence.secretKeyVersion === expectedCredentialKeyVersion &&
    expectedCredentialKeyVersion === 1 &&
    !evidence.secretRetired &&
    evidence.secretMatchesBearerToken &&
    evidence.createAuditMatches;
  if (!identityExact) configurationError();

  const tests = evidence.connectionTests;
  if (tests.length > maximumBootstrapConnectionAttempts) configurationError();
  const successfulTestIndex = tests.findIndex(isExpectedSuccessfulConnection);
  const connectionHistoryExact = tests.every((test, index) =>
    index === successfulTestIndex
      ? isExpectedSuccessfulConnection(test)
      : isExpectedTransientConnectionFailure(test),
  );
  if (
    !connectionHistoryExact ||
    (successfulTestIndex !== -1 && successfulTestIndex !== tests.length - 1)
  ) {
    configurationError();
  }
  const connectionAlreadyTested = successfulTestIndex === tests.length - 1 &&
    successfulTestIndex !== -1;
  if (
    evidence.revisionTested !== connectionAlreadyTested ||
    (evidence.revisionTested && !evidence.revisionTestActorMatches) ||
    (!connectionAlreadyTested &&
      tests.length >= maximumBootstrapConnectionAttempts)
  ) {
    configurationError();
  }

  const active = evidence.providerState === "active";
  const draft = evidence.providerState === "draft";
  if (!active && !draft) configurationError();
  if (
    !exactStrings(
      evidence.nonEmptyTables,
      expectedBootstrapTables({
        active,
        hasConnectionTests: tests.length > 0,
        hasImportRun: evidence.importRun !== null,
      }),
    )
  ) {
    configurationError();
  }

  if (draft) {
    if (
      evidence.providerActiveRevisionId !== null ||
      evidence.providerNextRunPresent ||
      evidence.activationAuditMatches ||
      evidence.importAuditMatches ||
      evidence.checkpointMatches ||
      evidence.lifecycleEvidenceMatches ||
      evidence.importRun !== null
    ) {
      configurationError();
    }
    return {
      kind: "draft",
      organizationId: evidence.organizationId,
      providerId: evidence.providerId,
      revisionId: evidence.revisionId,
      connectionAlreadyTested,
    };
  }

  if (
    !connectionAlreadyTested ||
    evidence.providerActiveRevisionId !== evidence.revisionId ||
    !evidence.providerNextRunPresent ||
    !evidence.activationAuditMatches ||
    !evidence.checkpointMatches ||
    !evidence.lifecycleEvidenceMatches ||
    (evidence.importRun === null
      ? evidence.importAuditMatches
      : !evidence.importRun.exactQueuedControlledRun ||
        !evidence.importAuditMatches)
  ) {
    configurationError();
  }
  return {
    kind: "active",
    organizationId: evidence.organizationId,
    providerId: evidence.providerId,
    revisionId: evidence.revisionId,
    existingRunId: evidence.importRun?.id ?? null,
  };
}

export function parseCollectorCryptLiveMode(
  argumentsList: readonly string[],
): CollectorCryptLiveMode {
  if (argumentsList.length === 0) return "bootstrap";
  if (argumentsList.length === 1 && argumentsList[0] === "--resume-bootstrap") {
    return "resume-bootstrap";
  }
  if (argumentsList.length === 1 && argumentsList[0] === "--request-only") {
    return "request-only";
  }
  throw new CollectorCryptLiveBootstrapError("ARGUMENTS_INVALID");
}

export function validateCollectorCryptDatabaseUrl(value: string | undefined): string {
  if (!value || value.length > 2_048 || /[\r\n]/.test(value)) {
    throw new CollectorCryptLiveBootstrapError("DATABASE_TARGET_INVALID");
  }
  try {
    const parsed = new URL(value);
    const resolvedDatabaseName = decodeURIComponent(parsed.pathname.slice(1));
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      !localDatabaseHosts.has(parsed.hostname) ||
      resolvedDatabaseName !== databaseName ||
      parsed.pathname.split("/").length !== 2 ||
      (parsed.port !== "" && parsed.port !== "5432") ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      throw new Error("invalid");
    }
  } catch {
    throw new CollectorCryptLiveBootstrapError("DATABASE_TARGET_INVALID");
  }
  return value;
}

function canonicalKey(value: string | undefined): Uint8Array {
  if (!value || !canonicalBase64Pattern.test(value)) {
    throw new CollectorCryptLiveBootstrapError("ENVIRONMENT_INVALID");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== 32 || decoded.toString("base64") !== value) {
    throw new CollectorCryptLiveBootstrapError("ENVIRONMENT_INVALID");
  }
  return new Uint8Array(decoded);
}

function credentialKeyVersion(value: string | undefined): 1 {
  if (value !== "1") {
    throw new CollectorCryptLiveBootstrapError("ENVIRONMENT_INVALID");
  }
  return 1;
}

function bootstrapBearerToken(value: string | undefined): string {
  if (!value || Buffer.byteLength(value, "utf8") > 4_096 || /[\r\n]/.test(value)) {
    throw new CollectorCryptLiveBootstrapError("ENVIRONMENT_INVALID");
  }
  return value;
}

export function readCollectorCryptLiveEnvironment(
  environment: NodeJS.ProcessEnv,
  argumentsList: readonly string[],
): CollectorCryptLiveEnvironment {
  const mode = parseCollectorCryptLiveMode(argumentsList);
  return Object.freeze({
    mode,
    databaseUrl: validateCollectorCryptDatabaseUrl(
      environment.PACKSCOUT_DATABASE_URL,
    ),
    credentialKey: canonicalKey(
      environment.PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64,
    ),
    actorPseudonymKey: canonicalKey(
      environment.PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64,
    ),
    credentialKeyVersion: credentialKeyVersion(
      environment.PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION,
    ),
    bearerToken:
      mode !== "request-only"
        ? bootstrapBearerToken(
            environment.PACKSCOUT_COLLECTOR_CRYPT_BEARER_TOKEN,
          )
        : null,
  });
}

export function validateExistingCollectorCryptLiveConfiguration(
  evidence: ExistingCollectorCryptLiveEvidence,
  expectedCredentialKeyVersion: number,
): { organizationId: string; providerId: string; revisionId: string } {
  const exact =
    evidence.organizationCount === 1 &&
    evidence.organizationSlug === organizationSlug &&
    evidence.organizationName === organizationName &&
    evidence.providerCount === 1 &&
    evidence.providerPlatformKey === platformKey &&
    evidence.providerDisplayName === providerName &&
    evidence.providerState === "active" &&
    evidence.activeRevisionId === evidence.revisionId &&
    evidence.revisionCount === 1 &&
    evidence.revisionVersion === 1 &&
    evidence.revisionSourceMode === "http" &&
    evidence.revisionAdapterKey === adapterKey &&
    evidence.revisionEndpoint === endpoint &&
    evidence.revisionAuthMode === "bearer" &&
    evidence.revisionScheduleSeconds === scheduleSeconds &&
    evidence.revisionStaleAfterSeconds === staleAfterSeconds &&
    evidence.revisionTested &&
    evidence.secretCount === 1 &&
    evidence.secretKeyVersion === expectedCredentialKeyVersion &&
    !evidence.secretRetired &&
    evidence.secretDecryptable &&
    evidence.checkpointCount === 1;
  if (!exact) configurationError();
  return {
    organizationId: evidence.organizationId,
    providerId: evidence.providerId,
    revisionId: evidence.revisionId,
  };
}

export async function executeCollectorCryptLiveCommand(
  configuration: CollectorCryptLiveEnvironment,
  runtime: CollectorCryptLiveRuntime,
): Promise<CollectorCryptLiveSummary> {
  let identity: { organizationId: string; providerId: string; revisionId: string };
  let bootstrapDisposition: CollectorCryptBootstrapDisposition;
  let expectedExistingRunId: string | null = null;
  if (configuration.mode === "request-only") {
    identity = await runtime.requireExistingConfiguration(
      configuration.credentialKeyVersion,
    );
    bootstrapDisposition = "already-ready";
  } else {
    const prepared = await runtime.prepareBootstrap(
      configuration.credentialKeyVersion,
      configuration.bearerToken!,
    );
    let connectionAlreadyTested = false;
    if (prepared.kind === "empty") {
      const organizationId = await runtime.createOrganization();
      const provider = await runtime.createProvider(
        organizationId,
        configuration.bearerToken!,
      );
      identity = {
        organizationId,
        providerId: provider.id,
        revisionId: provider.latestRevision.id,
      };
      bootstrapDisposition = "initialized";
    } else {
      identity = {
        organizationId: prepared.organizationId,
        providerId: prepared.providerId,
        revisionId: prepared.revisionId,
      };
      connectionAlreadyTested =
        prepared.kind === "active" || prepared.connectionAlreadyTested;
      bootstrapDisposition =
        prepared.kind === "active" ? "already-ready" : "recovered";
      expectedExistingRunId =
        prepared.kind === "active" ? prepared.existingRunId : null;
    }

    if (prepared.kind !== "active") {
      if (!connectionAlreadyTested) {
        const connection = await runtime.testConnection(
          identity.organizationId,
          identity.providerId,
          identity.revisionId,
        );
        if (connection.verdict !== "success") {
          throw new CollectorCryptLiveBootstrapError("CONNECTION_TEST_FAILED");
        }
      }
      const active = await runtime.activateProvider(
        identity.organizationId,
        identity.providerId,
        identity.revisionId,
      );
      if (
        active.state !== "active" ||
        active.activeRevisionId !== identity.revisionId
      ) {
        configurationError();
      }
    }
  }

  const requested = await runtime.requestImport(
    identity.organizationId,
    identity.providerId,
    identity.revisionId,
    expectedExistingRunId,
  );
  if (
    expectedExistingRunId !== null &&
    (requested.runId !== expectedExistingRunId ||
      requested.runState !== "queued" ||
      !requested.coalesced)
  ) {
    configurationError();
  }
  return Object.freeze({
    mode: configuration.mode,
    bootstrapDisposition,
    organizationId: identity.organizationId,
    providerId: identity.providerId,
    configurationRevisionId: identity.revisionId,
    providerState: "active",
    runId: requested.runId,
    runState: requested.runState,
    coalesced: requested.coalesced,
    importExecution: "queued-only",
    nextCommand: boundedBatchCommand,
  });
}

export function collectorCryptLiveSummaryJson(
  summary: CollectorCryptLiveSummary,
): string {
  return JSON.stringify({
    mode: summary.mode,
    bootstrapDisposition: summary.bootstrapDisposition,
    organizationId: summary.organizationId,
    providerId: summary.providerId,
    configurationRevisionId: summary.configurationRevisionId,
    providerState: summary.providerState,
    runId: summary.runId,
    runState: summary.runState,
    coalesced: summary.coalesced,
    importExecution: summary.importExecution,
    nextCommand: summary.nextCommand,
  });
}

export function collectorCryptLiveHelpText(): string {
  return [
    "Usage:",
    "  npm run bootstrap:collector-crypt-live:local",
    "  npm run bootstrap:collector-crypt-live:resume:local",
    "",
    "The default command safely initializes an empty local packscout_dev database or",
    "resumes only the exact Collector Crypt bootstrap state it previously created.",
    "--resume-bootstrap is an explicit alias for the same fail-closed behavior.",
    "",
    "Bootstrap validates configuration, activates the provider, and queues/coalesces",
    "one controlled manual run. It does not execute or supervise provider pages.",
    `Run bounded import work separately with: ${boundedBatchCommand}`,
    "",
  ].join("\n");
}

function scopedActor(organizationId: string) {
  return {
    organizationId,
    operatorId: "collector-crypt-live-bootstrap",
    role: "admin" as const,
  };
}

async function nonEmptyApplicationTables(
  database: PackscoutQueryClient,
): Promise<readonly string[]> {
  const tables = await database.$queryRaw<Array<{ tableName: string }>>(Prisma.sql`
    select table_class.relname as "tableName"
    from pg_class as table_class
    join pg_namespace as table_schema
      on table_schema.oid = table_class.relnamespace
    where table_schema.nspname = 'public'
      and table_class.relkind = 'r'
      and table_class.relname <> '_prisma_migrations'
    order by table_class.relname
  `);
  const nonEmpty: string[] = [];
  for (const { tableName } of tables) {
    if (!applicationTablePattern.test(tableName)) {
      throw new CollectorCryptLiveBootstrapError("CONFIGURATION_MISMATCH");
    }
    const qualifiedTable = Prisma.raw(`"public"."${tableName}"`);
    const rows = await database.$queryRaw<Array<{ present: boolean }>>(Prisma.sql`
      select exists(select 1 from ${qualifiedTable} limit 1) as present
    `);
    if (rows[0]?.present === true) nonEmpty.push(tableName);
  }
  return Object.freeze(nonEmpty);
}

function bootstrapProviderActorKey(
  organizationId: string,
  actorPseudonymKey: Uint8Array,
): string {
  return `actor:v1:${createHmac(
    "sha256",
    Buffer.from(actorPseudonymKey),
  )
    .update(`${organizationId}\u0000collector-crypt-live-bootstrap`)
    .digest("hex")}`;
}

function bootstrapImportActorKey(
  organizationId: string,
  actorPseudonymKey: Uint8Array,
): string {
  return `actor:v1:${createHmac(
    "sha256",
    Buffer.from(actorPseudonymKey),
  )
    .update(
      `packscout-provider-request:v1\u0000${organizationId}\u0000collector-crypt-live-bootstrap`,
    )
    .digest("hex")}`;
}

function bearerTokensMatch(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function exactJsonObject(
  value: Prisma.JsonValue,
  expected: Readonly<Record<string, string>>,
): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const actualKeys = sorted(Object.keys(value));
  const expectedKeys = sorted(Object.keys(expected));
  return (
    exactStrings(actualKeys, expectedKeys) &&
    expectedKeys.every((key) => value[key] === expected[key])
  );
}

function exactCounterObject(value: Prisma.JsonValue): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const expectedKeys = [
    "accepted",
    "duplicate",
    "pages",
    "quarantined",
    "records",
    "requestAttempts",
    "transientRetries",
  ];
  return (
    exactStrings(Object.keys(value), expectedKeys) &&
    expectedKeys.every((key) => value[key] === 0)
  );
}

async function prepareCollectorCryptBootstrap(
  database: PackscoutQueryClient,
  configuration: CollectorCryptLiveEnvironment,
): Promise<CollectorCryptBootstrapPreparation> {
  const nonEmptyTables = await nonEmptyApplicationTables(database);
  if (nonEmptyTables.length === 0) return Object.freeze({ kind: "empty" });

  const [
    organizations,
    sources,
    revisions,
    secrets,
    connectionTestCount,
    connectionTests,
    auditCount,
    audits,
    checkpoints,
    importRuns,
    causes,
    impacts,
    providerCatalogCheckpoints,
    manifestCheckpoints,
    watermarks,
  ] = await Promise.all([
    database.organizations.findMany({ take: 2, orderBy: { id: "asc" } }),
    database.provider_sources.findMany({ take: 2, orderBy: { id: "asc" } }),
    database.provider_config_revisions.findMany({
      take: 2,
      orderBy: { id: "asc" },
    }),
    database.provider_secret_versions.findMany({
      take: 2,
      orderBy: { id: "asc" },
    }),
    database.provider_connection_tests.count(),
    database.provider_connection_tests.findMany({
      take: maximumBootstrapConnectionAttempts + 1,
      orderBy: [{ tested_at: "asc" }, { id: "asc" }],
    }),
    database.audit_events.count(),
    database.audit_events.findMany({
      take: maximumBootstrapConnectionAttempts + 5,
      orderBy: [{ occurred_at: "asc" }, { id: "asc" }],
    }),
    database.provider_cursor_checkpoints.findMany({ take: 2 }),
    database.import_runs.findMany({ take: 2, orderBy: { id: "asc" } }),
    database.public_change_causes.findMany({ take: 2 }),
    database.public_change_catalog_impacts.findMany({ take: 2 }),
    database.provider_catalog_checkpoints.findMany({ take: 2 }),
    database.catalog_manifest_lifecycle_checkpoints.findMany({ take: 2 }),
    database.settled_public_watermarks.findMany({ take: 2 }),
  ]);
  if (
    connectionTestCount !== connectionTests.length ||
    auditCount !== audits.length
  ) {
    configurationError();
  }
  const organization = organizations[0];
  const source = sources[0];
  const revision = revisions[0];
  const secret = secrets[0];
  if (!organization || !source || !revision || !secret) configurationError();

  const expectedProviderActorKey = bootstrapProviderActorKey(
    organization.id,
    configuration.actorPseudonymKey,
  );
  const expectedImportActorKey = bootstrapImportActorKey(
    organization.id,
    configuration.actorPseudonymKey,
  );
  let secretMatchesBearerToken = false;
  try {
    const plaintext = new AesGcmProviderCredentialCipher({
      primaryVersion: configuration.credentialKeyVersion,
      keys: new Map([
        [configuration.credentialKeyVersion, configuration.credentialKey],
      ]),
    }).decrypt(
      {
        ciphertext: secret.ciphertext,
        nonce: secret.nonce,
        authTag: secret.auth_tag,
        keyVersion: secret.key_version,
      },
      {
        organizationId: organization.id,
        providerId: source.id,
        revisionId: revision.id,
      },
    );
    secretMatchesBearerToken =
      plaintext.length > 0 &&
      Buffer.byteLength(plaintext, "utf8") <= 4_096 &&
      !/[\r\n]/.test(plaintext) &&
      bearerTokensMatch(plaintext, configuration.bearerToken!);
  } catch {
    secretMatchesBearerToken = false;
  }

  const remainingAudits = [...audits];
  const takeAudit = (
    predicate: (audit: (typeof audits)[number]) => boolean,
  ): boolean => {
    const index = remainingAudits.findIndex(predicate);
    if (index === -1) return false;
    remainingAudits.splice(index, 1);
    return true;
  };
  const baseAudit = (audit: (typeof audits)[number]) =>
    audit.organization_id === organization.id &&
    audit.actor_key === expectedProviderActorKey &&
    audit.subject_type === "provider" &&
    audit.subject_id === source.id;
  const createAuditMatches = takeAudit(
    (audit) =>
      baseAudit(audit) &&
      audit.action === "provider.create" &&
      audit.outcome === "success" &&
      audit.occurred_at.getTime() === revision.created_at.getTime() &&
      exactJsonObject(audit.metadata_json, {
        adapterKey,
        revisionId: revision.id,
      }),
  );
  const connectionEvidence = connectionTests.map((test) => {
    const auditOutcome = test.outcome === "success" ? "success" : "failure";
    const recordCounts = test.record_counts_json;
    const successfulDetails =
      typeof recordCounts === "object" &&
      recordCounts !== null &&
      !Array.isArray(recordCounts) &&
      exactStrings(Object.keys(recordCounts), ["catalog", "pulls", "trades"]) &&
      [recordCounts.catalog, recordCounts.pulls, recordCounts.trades].every(
        (count) =>
          typeof count === "number" &&
          Number.isSafeInteger(count) &&
          count >= 0,
      ) &&
      Number(recordCounts.catalog) +
          Number(recordCounts.pulls) +
          Number(recordCounts.trades) ===
        500 &&
      test.has_more === true &&
      test.next_cursor_present === true;
    const failureDetails =
      recordCounts === null &&
      test.has_more === null &&
      test.next_cursor_present === null;
    const expectedMetadata = {
      revisionId: revision.id,
      verdict: test.outcome,
      ...(test.sanitized_code ? { sanitizedCode: test.sanitized_code } : {}),
    };
    return {
      verdict: test.outcome,
      responseStatus: test.response_status,
      sanitizedCode: test.sanitized_code,
      detailsMatch:
        test.outcome === "success" ? successfulDetails : failureDetails,
      actorMatches:
        test.organization_id === organization.id &&
        test.provider_id === source.id &&
        test.revision_id === revision.id &&
        test.tested_by_actor_key === expectedProviderActorKey,
      auditMatches: takeAudit(
        (audit) =>
          baseAudit(audit) &&
          audit.action === "provider.connection_test" &&
          audit.outcome === auditOutcome &&
          audit.occurred_at.getTime() === test.tested_at.getTime() &&
          exactJsonObject(audit.metadata_json, expectedMetadata),
      ),
    } satisfies CollectorCryptBootstrapConnectionEvidence;
  });

  const activationAuditMatches = takeAudit(
    (audit) =>
      baseAudit(audit) &&
      audit.action === "provider.activate" &&
      audit.outcome === "success" &&
      audit.occurred_at.getTime() === source.updated_at.getTime() &&
      exactJsonObject(audit.metadata_json, { revisionId: revision.id }),
  );
  const importRun = importRuns[0] ?? null;
  const importAuditMatches = importRun
    ? takeAudit(
        (audit) =>
          audit.organization_id === organization.id &&
          audit.actor_key === expectedImportActorKey &&
          audit.action === "provider.import.request" &&
          audit.subject_type === "import_run" &&
          audit.subject_id === importRun.id &&
          audit.outcome === "success" &&
          audit.occurred_at.getTime() === importRun.created_at.getTime() &&
          exactJsonObject(audit.metadata_json, {
            configRevisionId: revision.id,
            providerId: source.id,
            trigger: "manual",
            workerLane: "controlled",
          }),
      )
    : false;

  const checkpoint = checkpoints[0];
  const checkpointMatches =
    checkpoints.length === 1 &&
    checkpoint?.config_revision_id === revision.id &&
    checkpoint.organization_id === organization.id &&
    checkpoint.provider_id === source.id &&
    checkpoint.cursor === null &&
    checkpoint.advanced_by_run_id === null &&
    checkpoint.updated_at.getTime() === source.updated_at.getTime();

  const cause = causes[0];
  const impact = impacts[0];
  const providerCatalogCheckpoint = providerCatalogCheckpoints[0];
  const manifestCheckpoint = manifestCheckpoints[0];
  const watermark = watermarks[0];
  const activationTime = source.updated_at.getTime();
  const lifecycleEvidenceMatches =
    causes.length === 1 &&
    cause?.organization_id === organization.id &&
    cause.sequence === 1n &&
    cause.change_kind === "provider_lifecycle" &&
    cause.entity_key === `provider:v1:${source.id}` &&
    cause.source_key === platformKey &&
    cause.source_revision_key === revision.id &&
    /^\d+$/.test(cause.authoritative_transaction_id) &&
    cause.occurred_at.getTime() === activationTime &&
    exactJsonObject(cause.metadata_json, {
      configurationRevisionId: revision.id,
      platformKey,
      providerId: source.id,
      state: "active",
    }) &&
    impacts.length === 1 &&
    impact?.organization_id === organization.id &&
    impact.cause_sequence === 1n &&
    exactStrings(impact.provider_platform_keys, [platformKey]) &&
    impact.shared_configuration_key === null &&
    impact.shared_configuration_revision === null &&
    impact.shared_configuration_hash === null &&
    impact.lifecycle_platform_key === platformKey &&
    impact.lifecycle_state === "active" &&
    providerCatalogCheckpoints.length === 1 &&
    providerCatalogCheckpoint?.organization_id === organization.id &&
    providerCatalogCheckpoint.platform_key === platformKey &&
    providerCatalogCheckpoint.source_head_sequence === 1n &&
    providerCatalogCheckpoint.settled_sequence === 1n &&
    providerCatalogCheckpoint.source_head_at?.getTime() === activationTime &&
    providerCatalogCheckpoint.settled_at?.getTime() === activationTime &&
    manifestCheckpoints.length === 1 &&
    manifestCheckpoint?.organization_id === organization.id &&
    manifestCheckpoint.source_head_sequence === 1n &&
    manifestCheckpoint.settled_sequence === 1n &&
    manifestCheckpoint.source_head_at?.getTime() === activationTime &&
    manifestCheckpoint.settled_at?.getTime() === activationTime &&
    watermarks.length === 1 &&
    watermark?.organization_id === organization.id &&
    watermark.next_sequence === 2n &&
    watermark.source_head_sequence === 1n &&
    watermark.settled_sequence === 1n &&
    watermark.source_head_at?.getTime() === activationTime &&
    watermark.settled_at?.getTime() === activationTime;

  const exactQueuedControlledRun =
    importRuns.length === 1 &&
    importRun !== null &&
    importRun.organization_id === organization.id &&
    importRun.provider_id === source.id &&
    importRun.config_revision_id === revision.id &&
    importRun.trigger === "manual" &&
    importRun.worker_lane === "controlled" &&
    importRun.state === "queued" &&
    importRun.requested_by_actor_key === expectedImportActorKey &&
    importRun.requested_cursor === null &&
    importRun.final_cursor === null &&
    importRun.started_at === null &&
    importRun.finished_at === null &&
    importRun.heartbeat_at === null &&
    importRun.failure_code === null &&
    importRun.failure_summary === null &&
    importRun.lease_owner === null &&
    importRun.lease_expires_at === null &&
    importRun.attempt === 0 &&
    !importRun.reached_provider_head &&
    importRun.archive_sha256 === null &&
    exactCounterObject(importRun.counters_json);

  const evidence: CollectorCryptBootstrapRecoveryEvidence = {
    organizationCount: organizations.length,
    organizationId: organization.id,
    organizationSlug: organization.slug,
    organizationName: organization.name,
    providerCount: sources.length,
    providerId: source.id,
    providerPlatformKey: source.platform_key,
    providerDisplayName: source.display_name,
    providerState: source.state,
    providerActiveRevisionId: source.active_revision_id,
    providerNextRunPresent:
      source.next_run_at !== null &&
      source.next_run_at.getTime() - source.updated_at.getTime() ===
        scheduleSeconds * 1_000,
    revisionCount: revisions.length,
    revisionId: revision.id,
    revisionScopeMatches:
      revision.organization_id === organization.id &&
      revision.provider_id === source.id,
    revisionCreatedActorMatches:
      revision.created_by_actor_key === expectedProviderActorKey,
    revisionVersion: revision.version,
    revisionSourceMode: revision.source_mode,
    revisionAdapterKey: revision.adapter_key,
    revisionEndpoint: revision.endpoint_url,
    revisionAuthMode: revision.auth_mode,
    revisionScheduleSeconds: revision.schedule_seconds,
    revisionStaleAfterSeconds: revision.stale_after_seconds,
    revisionTested: revision.tested_at !== null,
    revisionTestActorMatches:
      revision.tested_by_actor_key === expectedProviderActorKey &&
      revision.tested_at?.getTime() === connectionTests.at(-1)?.tested_at.getTime(),
    secretCount: secrets.length,
    secretScopeMatches:
      secret.organization_id === organization.id &&
      secret.provider_id === source.id &&
      secret.revision_id === revision.id,
    secretKeyVersion: secret.key_version,
    secretRetired: secret.retired_at !== null,
    secretMatchesBearerToken,
    connectionTests: connectionEvidence,
    createAuditMatches: createAuditMatches && remainingAudits.length === 0,
    activationAuditMatches,
    importAuditMatches,
    checkpointMatches,
    lifecycleEvidenceMatches,
    importRun:
      importRun === null
        ? null
        : { id: importRun.id, exactQueuedControlledRun },
    nonEmptyTables,
  };
  return validateCollectorCryptBootstrapRecoveryEvidence(
    evidence,
    configuration.credentialKeyVersion,
  );
}

async function readCollectorCryptBootstrapSnapshot(
  database: PackscoutPrismaClient,
  configuration: CollectorCryptLiveEnvironment,
): Promise<CollectorCryptBootstrapPreparation> {
  return database.$transaction(
    async (transaction) => {
      await transaction.$executeRaw(Prisma.sql`set transaction read only`);
      return prepareCollectorCryptBootstrap(transaction, configuration);
    },
    {
      ...PACKSCOUT_TRANSACTION_OPTIONS,
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    },
  );
}

function createProductionRuntime(
  database: PackscoutPrismaClient,
  configuration: CollectorCryptLiveEnvironment,
): CollectorCryptLiveRuntime {
  const repository = new PrismaProviderConfigurationRepository(database);
  const transports = createDataForrestProviderTransportRegistry();
  const providerRuntime = createProviderAdminRuntime({
    repository,
    healthRepository: new PrismaProviderHealthRepository(database),
    credentialKey: configuration.credentialKey,
    actorPseudonymKey: configuration.actorPseudonymKey,
    environment: "local",
    transportAdapters: transports,
  });
  const importRuntime = createAdminImportOperationsRuntime({
    database,
    actorPseudonymKey: configuration.actorPseudonymKey,
    credentialKey: configuration.credentialKey,
    credentialKeyVersion: configuration.credentialKeyVersion,
    environment: "local",
    transportAdapters: transports,
  });
  return {
    prepareBootstrap: () =>
      readCollectorCryptBootstrapSnapshot(database, configuration),
    createOrganization: () =>
      new PipelineSetupRepository(database).createOrganization({
        slug: organizationSlug,
        name: organizationName,
      }),
    createProvider: (organizationId, bearerToken) =>
      providerRuntime.configuration.createProvider(scopedActor(organizationId), {
        platformKey,
        displayName: providerName,
        adapterKey,
        endpoint,
        auth: { mode: "bearer", bearerSecret: bearerToken },
        scheduleSeconds,
        staleAfterSeconds,
      }),
    testConnection: (organizationId, providerId, revisionId) =>
      providerRuntime.configuration.testConnection(
        scopedActor(organizationId),
        providerId,
        revisionId,
      ),
    activateProvider: (organizationId, providerId, revisionId) =>
      providerRuntime.configuration.activateRevision(
        scopedActor(organizationId),
        providerId,
        revisionId,
      ),
    requireExistingConfiguration: async (expectedKeyVersion) => {
      const [organizations, sources] = await Promise.all([
        database.organizations.findMany({ take: 2, orderBy: { id: "asc" } }),
        database.provider_sources.findMany({ take: 2, orderBy: { id: "asc" } }),
      ]);
      const organization = organizations[0];
      const source = sources[0];
      if (!organization || !source) configurationError();
      const [revisions, secrets, checkpointCount, summary, runtimeRevision] =
        await Promise.all([
          database.provider_config_revisions.findMany({
            where: { organization_id: organization.id, provider_id: source.id },
            take: 2,
            orderBy: { version: "asc" },
          }),
          database.provider_secret_versions.findMany({
            where: { organization_id: organization.id, provider_id: source.id },
            take: 2,
            orderBy: { created_at: "asc" },
          }),
          database.provider_cursor_checkpoints.count({
            where: { organization_id: organization.id, provider_id: source.id },
          }),
          repository.getProvider(organization.id, source.id),
          source.active_revision_id
            ? repository.getImmutableRevisionForRuntime({
                organizationId: organization.id,
                providerId: source.id,
                revisionId: source.active_revision_id,
              })
            : Promise.resolve(null),
        ]);
      const revision = revisions[0];
      const secret = secrets[0];
      if (!revision || !secret || !summary || !runtimeRevision?.encryptedCredential) {
        configurationError();
      }
      let secretDecryptable = false;
      try {
        const plaintext = new AesGcmProviderCredentialCipher({
          primaryVersion: expectedKeyVersion,
          keys: new Map([[expectedKeyVersion, configuration.credentialKey]]),
        }).decrypt(runtimeRevision.encryptedCredential, {
          organizationId: organization.id,
          providerId: source.id,
          revisionId: revision.id,
        });
        secretDecryptable =
          plaintext.length > 0 &&
          Buffer.byteLength(plaintext, "utf8") <= 4_096 &&
          !/[\r\n]/.test(plaintext);
      } catch {
        secretDecryptable = false;
      }
      return validateExistingCollectorCryptLiveConfiguration(
        {
          organizationCount: organizations.length,
          organizationId: organization.id,
          organizationSlug: organization.slug,
          organizationName: organization.name,
          providerCount: sources.length,
          providerId: source.id,
          providerPlatformKey: source.platform_key,
          providerDisplayName: source.display_name,
          providerState: source.state,
          activeRevisionId: source.active_revision_id,
          revisionCount: revisions.length,
          revisionId: revision.id,
          revisionVersion: revision.version,
          revisionSourceMode: revision.source_mode,
          revisionAdapterKey: revision.adapter_key,
          revisionEndpoint: revision.endpoint_url,
          revisionAuthMode: revision.auth_mode,
          revisionScheduleSeconds: revision.schedule_seconds,
          revisionStaleAfterSeconds: revision.stale_after_seconds,
          revisionTested: revision.tested_at !== null,
          secretCount: secrets.length,
          secretKeyVersion: secret.key_version,
          secretRetired: secret.retired_at !== null,
          secretDecryptable,
          checkpointCount,
        },
        expectedKeyVersion,
      );
    },
    requestImport: async (
      organizationId,
      providerId,
      revisionId,
      expectedExistingRunId,
    ) => {
      if (expectedExistingRunId !== null) {
        const prepared = await readCollectorCryptBootstrapSnapshot(
          database,
          configuration,
        );
        if (
          prepared.kind !== "active" ||
          prepared.organizationId !== organizationId ||
          prepared.providerId !== providerId ||
          prepared.revisionId !== revisionId ||
          prepared.existingRunId !== expectedExistingRunId
        ) {
          configurationError();
        }
        return {
          runId: expectedExistingRunId,
          runState: "queued",
          coalesced: true,
        };
      }
      const requested = await importRuntime.controlledImports.request({
        actor: scopedActor(organizationId),
        providerId,
        expectedConfigurationRevisionId: revisionId,
      });
      if (requested.run.state !== "queued" && requested.run.state !== "running") {
        configurationError();
      }
      return {
        runId: requested.run.id,
        runState: requested.run.state,
        coalesced: requested.deduplicated,
      };
    },
  };
}

export async function runCollectorCryptLiveBootstrap(
  argumentsList: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<CollectorCryptLiveSummary> {
  const configuration = readCollectorCryptLiveEnvironment(
    environment,
    argumentsList,
  );
  const lifecycle = createPrismaClientLifecycle({
    databaseUrl: configuration.databaseUrl,
  });
  try {
    await lifecycle.start();
    return await executeCollectorCryptLiveCommand(
      configuration,
      createProductionRuntime(lifecycle.client, configuration),
    );
  } finally {
    await lifecycle.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const argumentsList = process.argv.slice(2);
  const helpRequested = argumentsList.filter((argument) =>
    ["--help", "-h"].includes(argument)
  );
  const helpArgumentsValid = argumentsList.every((argument) =>
    ["--help", "-h", "--resume-bootstrap"].includes(argument)
  );
  if (helpRequested.length === 1 && helpArgumentsValid) {
    process.stdout.write(collectorCryptLiveHelpText());
  } else {
    runCollectorCryptLiveBootstrap(argumentsList)
      .then((summary) => {
        process.stdout.write(`${collectorCryptLiveSummaryJson(summary)}\n`);
      })
      .catch(() => {
        process.stderr.write("Collector Crypt live bootstrap failed.\n");
        process.exitCode = 1;
      });
  }
}

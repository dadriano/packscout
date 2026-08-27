#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  DATAFORREST_EVENTS_V1_CURSOR_CODEC_KEY,
} from "../../packages/contracts/src/dataforrest-events-v1.ts";
import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  providerIdentityNamespaceByLaunchProvider,
} from "../../packages/contracts/src/provider-source-contract-v1.ts";
import {
  approvedPublicCatalogConfigurationV1Schema,
  type ApprovedPublicCatalogConfigurationV1,
} from "../../packages/contracts/src/approved-public-catalog-configuration.ts";
import {
  canonicalJson,
  sha256CanonicalJson,
} from "../../packages/contracts/src/data-release-v2-canonical.ts";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  createPrismaClientLifecycle,
  type PackscoutPrismaClient,
} from "../../packages/database/src/database.ts";
import { Prisma } from "@prisma/client";

const WORKFLOW = "generate_clutchpacks_v2_public_catalog_candidate" as const;
const PLATFORM_KEY = "clutchpacks" as const;
const TARGET_DATABASE_NAME = "packscout_clutchpacks_v2_canary" as const;
const TARGET_ACKNOWLEDGEMENT =
  "I_UNDERSTAND_THE_TARGET_MUST_BE_A_FRESH_LOCAL_DATABASE" as const;
const CONFIRMATION_PREFIX = "WRITE CLUTCHPACKS V2 CATALOG LOCAL" as const;
const CANDIDATE_DIGEST_DOMAIN =
  "packscout.clutchpacks-v2-public-catalog-candidate.v1" as const;
const PUBLIC_CATALOG_CONFIGURATION_HASH_DOMAIN =
  "packscout.public-catalog.configuration.v1" as const;
const mapper = Object.freeze({
  mapperKey: "clutchpacks-provider-observation",
  mapperVersion: "1",
  identityNamespaceKey: providerIdentityNamespaceByLaunchProvider.clutchpacks,
});

export type ClutchpacksCatalogCandidateErrorCode =
  | "ARGUMENT_INVALID"
  | "CANDIDATE_CONFIGURATION_INVALID"
  | "CONFIRMATION_INVALID"
  | "DATABASE_READ_FAILED"
  | "ENVIRONMENT_INVALID"
  | "OUTPUT_ALREADY_EXISTS"
  | "OUTPUT_INVALID"
  | "OUTPUT_WRITE_FAILED"
  | "TARGET_NOT_QUALIFIED";

export class ClutchpacksCatalogCandidateError extends Error {
  readonly code: ClutchpacksCatalogCandidateErrorCode;

  constructor(code: ClutchpacksCatalogCandidateErrorCode) {
    super("The ClutchPacks catalog candidate operation failed safely.");
    this.name = "ClutchpacksCatalogCandidateError";
    this.code = code;
  }
}

function refuse(code: ClutchpacksCatalogCandidateErrorCode): never {
  throw new ClutchpacksCatalogCandidateError(code);
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) refuse("ENVIRONMENT_INVALID");
  return value;
}

function positiveInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  maximum: number,
): number {
  const value = required(environment, name);
  if (!/^[1-9][0-9]*$/u.test(value)) refuse("ENVIRONMENT_INVALID");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    refuse("ENVIRONMENT_INVALID");
  }
  return parsed;
}

function nonnegativeInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  maximum: number,
): number {
  const value = required(environment, name);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) refuse("ENVIRONMENT_INVALID");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    refuse("ENVIRONMENT_INVALID");
  }
  return parsed;
}

function canonicalLocalTarget(value: string): Readonly<{
  databaseUrl: string;
  target: string;
}> {
  try {
    const parsed = new URL(value);
    const port = parsed.port || "5432";
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      !["127.0.0.1", "::1", "localhost"].includes(
        parsed.hostname.toLowerCase(),
      ) ||
      !parsed.username ||
      parsed.password ||
      parsed.pathname !== `/${TARGET_DATABASE_NAME}` ||
      parsed.search ||
      parsed.hash ||
      /[\r\n]/u.test(value)
    ) {
      throw new Error("invalid");
    }
    return Object.freeze({
      databaseUrl: value,
      target:
        `${parsed.protocol}//${parsed.hostname.toLowerCase()}:${port}/${TARGET_DATABASE_NAME}`,
    });
  } catch {
    return refuse("ENVIRONMENT_INVALID");
  }
}

export interface ClutchpacksCatalogCandidatePolicy {
  readonly namespaceUuid: string;
  readonly configurationKey: string;
  readonly revision: number;
  readonly approvedAt: string;
  readonly staleAfterSeconds: number;
  readonly confidencePolicyVersion: string;
  readonly completeScoreBasisPoints: number;
  readonly partialScoreBasisPoints: number;
  readonly unknownScoreBasisPoints: number;
  readonly limitationPenaltyBasisPoints: number;
  readonly vendorDisplayName: string;
  readonly format: "repack";
}

export interface ClutchpacksCatalogCandidateEnvironment {
  readonly databaseUrl: string;
  readonly databaseTarget: string;
  readonly organizationId: string;
  readonly policy: ClutchpacksCatalogCandidatePolicy;
}

export function readClutchpacksCatalogCandidateEnvironment(
  environment: NodeJS.ProcessEnv,
): ClutchpacksCatalogCandidateEnvironment {
  if (
    environment.NODE_ENV !== "development" ||
    environment.PACKSCOUT_RUNTIME_ENVIRONMENT?.trim() !== "local" ||
    environment.PACKSCOUT_CLUTCHPACKS_V2_TARGET_ACK?.trim() !==
      TARGET_ACKNOWLEDGEMENT
  ) {
    refuse("ENVIRONMENT_INVALID");
  }
  const target = canonicalLocalTarget(required(environment, "PACKSCOUT_DATABASE_URL"));
  const organizationId = required(
    environment,
    "PACKSCOUT_CLUTCHPACKS_V2_CANARY_ORGANIZATION_ID",
  ).toLowerCase();
  const namespaceUuid = required(
    environment,
    "PACKSCOUT_CLUTCHPACKS_CATALOG_NAMESPACE_UUID",
  ).toLowerCase();
  const approvedAt = required(
    environment,
    "PACKSCOUT_CLUTCHPACKS_CATALOG_APPROVED_AT",
  );
  const format = required(environment, "PACKSCOUT_CLUTCHPACKS_CATALOG_FORMAT");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(organizationId) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(namespaceUuid) ||
    new Date(approvedAt).toISOString() !== approvedAt ||
    format !== "repack"
  ) {
    refuse("ENVIRONMENT_INVALID");
  }
  const policy = Object.freeze({
    namespaceUuid,
    configurationKey: required(
      environment,
      "PACKSCOUT_CLUTCHPACKS_CATALOG_CONFIGURATION_KEY",
    ),
    revision: positiveInteger(
      environment,
      "PACKSCOUT_CLUTCHPACKS_CATALOG_REVISION",
      Number.MAX_SAFE_INTEGER,
    ),
    approvedAt,
    staleAfterSeconds: positiveInteger(
      environment,
      "PACKSCOUT_CLUTCHPACKS_CATALOG_STALE_AFTER_SECONDS",
      31_536_000,
    ),
    confidencePolicyVersion: required(
      environment,
      "PACKSCOUT_CLUTCHPACKS_CATALOG_CONFIDENCE_POLICY_VERSION",
    ),
    completeScoreBasisPoints: nonnegativeInteger(
      environment,
      "PACKSCOUT_CLUTCHPACKS_CATALOG_COMPLETE_SCORE_BPS",
      10_000,
    ),
    partialScoreBasisPoints: nonnegativeInteger(
      environment,
      "PACKSCOUT_CLUTCHPACKS_CATALOG_PARTIAL_SCORE_BPS",
      10_000,
    ),
    unknownScoreBasisPoints: nonnegativeInteger(
      environment,
      "PACKSCOUT_CLUTCHPACKS_CATALOG_UNKNOWN_SCORE_BPS",
      10_000,
    ),
    limitationPenaltyBasisPoints: nonnegativeInteger(
      environment,
      "PACKSCOUT_CLUTCHPACKS_CATALOG_LIMITATION_PENALTY_BPS",
      10_000,
    ),
    vendorDisplayName: required(
      environment,
      "PACKSCOUT_CLUTCHPACKS_CATALOG_VENDOR_DISPLAY_NAME",
    ),
    format: "repack" as const,
  });
  if (
    policy.staleAfterSeconds < 60 ||
    policy.completeScoreBasisPoints < policy.partialScoreBasisPoints ||
    policy.partialScoreBasisPoints < policy.unknownScoreBasisPoints
  ) {
    refuse("ENVIRONMENT_INVALID");
  }
  return Object.freeze({
    databaseUrl: target.databaseUrl,
    databaseTarget: target.target,
    organizationId,
    policy,
  });
}

export type ClutchpacksCatalogCandidateCommand = Readonly<{
  execute: boolean;
  outputPath: string;
  confirmation: string | null;
}>;

function validOutputPath(value: string): string {
  if (
    !path.isAbsolute(value) ||
    path.parse(value).root === value ||
    value.includes("\0") ||
    path.basename(value) === "." ||
    path.basename(value) === ".."
  ) {
    refuse("OUTPUT_INVALID");
  }
  return path.normalize(value);
}

export function parseClutchpacksCatalogCandidateCommand(
  argv: readonly string[],
): ClutchpacksCatalogCandidateCommand {
  const tokens = [...argv];
  let execute = false;
  if (tokens[0] === "--dry-run") tokens.shift();
  else if (tokens[0] === "--execute") {
    execute = true;
    tokens.shift();
  }
  if (tokens[0] !== "--output" || !tokens[1]) refuse("ARGUMENT_INVALID");
  const outputPath = validOutputPath(tokens[1]);
  tokens.splice(0, 2);
  let confirmation: string | null = null;
  if (tokens.length > 0) {
    if (tokens.length !== 2 || tokens[0] !== "--confirmation" || !tokens[1]) {
      refuse("ARGUMENT_INVALID");
    }
    confirmation = tokens[1];
  }
  if ((!execute && confirmation !== null) || (execute && confirmation === null)) {
    refuse("ARGUMENT_INVALID");
  }
  return Object.freeze({ execute, outputPath, confirmation });
}

function uuidBytes(value: string): Buffer {
  return Buffer.from(value.replaceAll("-", ""), "hex");
}

export function uuidV5(namespaceUuid: string, name: string): string {
  const digest = createHash("sha1")
    .update(uuidBytes(namespaceUuid))
    .update(Buffer.from(name, "utf8"))
    .digest()
    .subarray(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)
  }-${hex.slice(20)}`;
}

export interface ClutchpacksCatalogEntityCandidate {
  readonly externalId: string;
  readonly content: unknown;
  readonly associated?: boolean;
}

export interface ClutchpacksCatalogQualificationEvidence {
  readonly organizationCount: number;
  readonly providerCount: number;
  readonly providerPlatformKey: string | null;
  readonly providerState: string | null;
  readonly sourceCount: number;
  readonly sourceState: string | null;
  readonly sourcePauseRequested: boolean | null;
  readonly sourceRevisionCount: number;
  readonly sourceRevisionId: string | null;
  readonly sourceAdapterVersion: string | null;
  readonly normalizedContractVersion: string | null;
  readonly mapperKey: string | null;
  readonly mapperVersion: string | null;
  readonly identityNamespaceKey: string | null;
  readonly cursorCodecVersion: string | null;
  readonly latestRunCount: number;
  readonly latestRunId: string | null;
  readonly latestRunState: string | null;
  readonly latestRunReachedProviderHead: boolean | null;
  readonly latestRunFinished: boolean;
  readonly latestRunFailureCode: string | null;
  readonly latestRunSourceRevisionId: string | null;
  readonly latestRunAdapterVersion: string | null;
  readonly latestRunNormalizedContractVersion: string | null;
  readonly latestRunMapperKey: string | null;
  readonly latestRunMapperVersion: string | null;
  readonly latestRunIdentityNamespaceKey: string | null;
  readonly latestRunCursorCodecVersion: string | null;
  readonly activeRunCount: number;
  readonly liveSupervisorCount: number;
  readonly wrongDeliveryLineageCount: number;
  readonly deliveryCount: number;
  readonly quarantineCount: number;
  readonly nonInfoDiagnosticCount: number;
  readonly nonInfoOperationalEventCount: number;
  readonly canonicalPackCount: number;
  readonly canonicalAssetCount: number;
  readonly canonicalPullCount: number;
  readonly canonicalMarketEventCount: number;
  readonly confirmationSetCount: number;
  readonly currentPullConfirmationSetCount: number;
  readonly confirmationItemCount: number;
  readonly declaredConfirmationItemCount: number;
  readonly confirmationSetSizeMismatchCount: number;
  readonly unresolvedConfirmationItemCount: number;
  readonly backfillCount: number;
  readonly completeBackfillCount: number;
  readonly globalSettledSequence: bigint | null;
  readonly globalSourceHeadSequence: bigint | null;
  readonly globalNextSequence: bigint | null;
  readonly providerSettledSequence: bigint | null;
  readonly providerSourceHeadSequence: bigint | null;
  readonly pendingObligationCount: number;
  readonly legacyProviderConfigurationCount: number;
  readonly legacyProviderSecretCount: number;
  readonly legacyProviderCursorCount: number;
  readonly packs: readonly ClutchpacksCatalogEntityCandidate[];
  readonly assets: readonly ClutchpacksCatalogEntityCandidate[];
}

export function assertClutchpacksCatalogCandidateTargetQualified(
  evidence: ClutchpacksCatalogQualificationEvidence,
): void {
  if (
    evidence.organizationCount !== 1 ||
    evidence.providerCount !== 1 ||
    evidence.providerPlatformKey !== PLATFORM_KEY ||
    evidence.providerState !== "active" ||
    evidence.sourceCount !== 1 ||
    evidence.sourceState !== "paused" ||
    evidence.sourcePauseRequested !== false ||
    evidence.sourceRevisionCount !== 1 ||
    !evidence.sourceRevisionId ||
    evidence.sourceAdapterVersion !== DATAFORREST_EVENTS_V1_ADAPTER_VERSION ||
    evidence.normalizedContractVersion !== PROVIDER_OBSERVATION_CONTRACT_VERSION ||
    evidence.mapperKey !== mapper.mapperKey ||
    evidence.mapperVersion !== mapper.mapperVersion ||
    evidence.identityNamespaceKey !== mapper.identityNamespaceKey ||
    evidence.cursorCodecVersion !== DATAFORREST_EVENTS_V1_CURSOR_CODEC_KEY ||
    evidence.latestRunCount !== 1 ||
    !evidence.latestRunId ||
    evidence.latestRunState !== "succeeded" ||
    evidence.latestRunReachedProviderHead !== true ||
    !evidence.latestRunFinished ||
    evidence.latestRunFailureCode !== null ||
    evidence.latestRunSourceRevisionId !== evidence.sourceRevisionId ||
    evidence.latestRunAdapterVersion !== DATAFORREST_EVENTS_V1_ADAPTER_VERSION ||
    evidence.latestRunNormalizedContractVersion !==
      PROVIDER_OBSERVATION_CONTRACT_VERSION ||
    evidence.latestRunMapperKey !== mapper.mapperKey ||
    evidence.latestRunMapperVersion !== mapper.mapperVersion ||
    evidence.latestRunIdentityNamespaceKey !== mapper.identityNamespaceKey ||
    evidence.latestRunCursorCodecVersion !== DATAFORREST_EVENTS_V1_CURSOR_CODEC_KEY ||
    evidence.activeRunCount !== 0 ||
    evidence.liveSupervisorCount !== 0 ||
    evidence.deliveryCount < 1 ||
    evidence.wrongDeliveryLineageCount !== 0 ||
    evidence.quarantineCount !== 0 ||
    evidence.nonInfoDiagnosticCount !== 0 ||
    evidence.nonInfoOperationalEventCount !== 0 ||
    evidence.canonicalPackCount < 1 ||
    evidence.canonicalAssetCount < 1 ||
    evidence.canonicalPullCount < 1 ||
    evidence.canonicalMarketEventCount < 1 ||
    evidence.packs.length !== evidence.canonicalPackCount ||
    evidence.assets.length !== evidence.canonicalAssetCount ||
    evidence.confirmationSetCount !== evidence.canonicalPullCount ||
    evidence.currentPullConfirmationSetCount !== evidence.canonicalPullCount ||
    evidence.confirmationItemCount !== evidence.declaredConfirmationItemCount ||
    evidence.confirmationSetSizeMismatchCount !== 0 ||
    evidence.unresolvedConfirmationItemCount !== 0 ||
    evidence.backfillCount !== 1 ||
    evidence.completeBackfillCount !== 1 ||
    evidence.globalSettledSequence === null ||
    evidence.globalSourceHeadSequence === null ||
    evidence.globalNextSequence === null ||
    evidence.providerSettledSequence === null ||
    evidence.providerSourceHeadSequence === null ||
    evidence.globalSettledSequence !== evidence.globalSourceHeadSequence ||
    evidence.providerSettledSequence !== evidence.providerSourceHeadSequence ||
    evidence.providerSettledSequence !== evidence.globalSettledSequence ||
    evidence.globalNextSequence !== evidence.globalSourceHeadSequence + 1n ||
    evidence.pendingObligationCount !== 0 ||
    evidence.legacyProviderConfigurationCount !== 0 ||
    evidence.legacyProviderSecretCount !== 0 ||
    evidence.legacyProviderCursorCount !== 0
  ) {
    refuse("TARGET_NOT_QUALIFIED");
  }
  const unnamedAssociated = evidence.assets.filter(({ associated, content }) => {
    if (!associated || typeof content !== "object" || content === null) return false;
    const name = (content as Readonly<Record<string, unknown>>).name;
    return typeof name !== "string" || name.trim().length === 0;
  });
  if (unnamedAssociated.length !== 0) refuse("TARGET_NOT_QUALIFIED");
}

function collectHttpsOrigins(value: unknown, origins: Set<string>): void {
  if (typeof value === "string") {
    try {
      const parsed = new URL(value);
      if (parsed.protocol === "https:" && parsed.username === "" && parsed.password === "") {
        origins.add(parsed.origin);
      }
    } catch {
      // Canonical content contains many ordinary strings; only URLs matter.
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectHttpsOrigins(item, origins);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) collectHttpsOrigins(item, origins);
  }
}

function compareExternalId(
  left: ClutchpacksCatalogEntityCandidate,
  right: ClutchpacksCatalogEntityCandidate,
): number {
  return left.externalId < right.externalId
    ? -1
    : left.externalId > right.externalId
      ? 1
      : 0;
}

export function buildClutchpacksCatalogCandidate(
  evidence: ClutchpacksCatalogQualificationEvidence,
  policy: ClutchpacksCatalogCandidatePolicy,
): ApprovedPublicCatalogConfigurationV1 {
  assertClutchpacksCatalogCandidateTargetQualified(evidence);
  const packs = [...evidence.packs].sort(compareExternalId);
  const assets = [...evidence.assets].sort(compareExternalId);
  if (
    new Set(packs.map(({ externalId }) => externalId)).size !== packs.length ||
    new Set(assets.map(({ externalId }) => externalId)).size !== assets.length
  ) {
    refuse("TARGET_NOT_QUALIFIED");
  }
  const origins = new Set<string>();
  for (const row of [...packs, ...assets]) collectHttpsOrigins(row.content, origins);
  const publicAssetOrigins = [...origins].sort();
  const candidate = {
    schemaVersion: "approved_public_catalog_v1" as const,
    configurationKey: policy.configurationKey,
    revision: policy.revision,
    approvedAt: policy.approvedAt,
    staleAfterSeconds: policy.staleAfterSeconds,
    confidencePolicy: {
      version: policy.confidencePolicyVersion,
      completeScoreBasisPoints: policy.completeScoreBasisPoints,
      partialScoreBasisPoints: policy.partialScoreBasisPoints,
      unknownScoreBasisPoints: policy.unknownScoreBasisPoints,
      limitationPenaltyBasisPoints: policy.limitationPenaltyBasisPoints,
    },
    publicAssetOrigins,
    verifiedUsdStablecoins: [],
    categories: [],
    platforms: [{
      platformKey: PLATFORM_KEY,
      vendor: {
        publicVendorId: uuidV5(
          policy.namespaceUuid,
          `vendor\0${PLATFORM_KEY}`,
        ),
        vendorKey: PLATFORM_KEY,
        displayName: policy.vendorDisplayName,
        logoUrl: null,
        websiteUrl: null,
        listingHosts: [],
        imageOrigins: publicAssetOrigins,
        referralParameters: [],
        publicPromo: null,
      },
      format: policy.format,
      defaultPublicCategoryIds: [],
      categoryMappings: [],
      collectibleTypeMappings: [],
    }],
    repacks: packs.map(({ externalId }) => ({
      platformKey: PLATFORM_KEY,
      packExternalId: externalId,
      publicRepackId: uuidV5(
        policy.namespaceUuid,
        `repack\0${PLATFORM_KEY}\0${externalId}`,
      ),
    })),
    collectibles: assets.map(({ externalId, associated }) => ({
      platformKey: PLATFORM_KEY,
      externalId,
      publicCollectibleId: uuidV5(
        policy.namespaceUuid,
        `collectible\0${PLATFORM_KEY}\0${externalId}`,
      ),
      aliases: [],
      collectibleType: "card" as const,
      publicCategoryIds: [],
      year: null,
      brand: null,
      setOrSeries: null,
      cardNumber: null,
      referenceNumber: null,
      subject: null,
      grade: null,
      grader: null,
      probabilityBucketId: null,
      matchConfidenceBasisPoints: 10_000,
      chaseEvidenceKinds: associated
        ? ["historical_pull_inference" as const, "packscout_resolved" as const]
        : ["packscout_resolved" as const],
    })),
  };
  const parsed = approvedPublicCatalogConfigurationV1Schema.safeParse(candidate);
  if (!parsed.success) refuse("CANDIDATE_CONFIGURATION_INVALID");
  return parsed.data;
}

function integer(value: bigint | number): number {
  const parsed = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 0) refuse("DATABASE_READ_FAILED");
  return parsed;
}

async function readQualificationEvidence(
  database: PackscoutPrismaClient,
  organizationId: string,
): Promise<ClutchpacksCatalogQualificationEvidence> {
  return database.$transaction(async (transaction) => {
    await transaction.$executeRaw(Prisma.sql`set transaction read only`);
    const [
      organizationCount,
      providers,
      sources,
      sourceRevisions,
      runs,
      activeRunCount,
      liveSupervisors,
      deliveryCount,
      wrongDeliveryLineageCount,
      quarantineCount,
      nonInfoDiagnosticCount,
      nonInfoOperationalEventCount,
      counts,
      confirmation,
      backfills,
      globalWatermark,
      providerCheckpoint,
      pendingObligationCount,
      legacyProviderConfigurationCount,
      legacyProviderSecretCount,
      legacyProviderCursorCount,
      packs,
      assets,
    ] = await Promise.all([
      transaction.organizations.count(),
      transaction.provider_sources.findMany({
        where: { organization_id: organizationId },
        select: { platform_key: true, state: true },
      }),
      transaction.provider_source_instances.findMany({
        where: { organization_id: organizationId },
        select: {
          id: true,
          state: true,
          pause_requested_at: true,
          active_revision_id: true,
        },
      }),
      transaction.provider_source_revisions.findMany({
        where: { organization_id: organizationId },
        select: {
          id: true,
          source_adapter_version: true,
          normalized_contract_version: true,
          mapper_key: true,
          mapper_version: true,
          identity_namespace_key: true,
          cursor_codec_version: true,
        },
      }),
      transaction.import_runs.findMany({
        where: { organization_id: organizationId },
        orderBy: [{ created_at: "desc" }, { id: "desc" }],
        select: {
          id: true,
          state: true,
          reached_provider_head: true,
          finished_at: true,
          failure_code: true,
          source_revision_id: true,
          source_adapter_version: true,
          normalized_contract_version: true,
          mapper_key: true,
          mapper_version: true,
          identity_namespace_key: true,
          cursor_codec_version: true,
        },
      }),
      transaction.import_runs.count({
        where: { organization_id: organizationId, state: { in: ["queued", "running"] } },
      }),
      transaction.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        select count(*)::bigint as count
        from public.source_supervisor_epochs
        where state in ('active', 'fenced_draining')
          and lease_expires_at > clock_timestamp()
      `),
      transaction.source_delivery_occurrences.count({
        where: { organization_id: organizationId },
      }),
      transaction.source_delivery_occurrences.count({
        where: {
          organization_id: organizationId,
          OR: [
            { source_adapter_version: { not: DATAFORREST_EVENTS_V1_ADAPTER_VERSION } },
            { normalized_contract_version: { not: PROVIDER_OBSERVATION_CONTRACT_VERSION } },
          ],
        },
      }),
      transaction.quarantine_records.count({ where: { organization_id: organizationId } }),
      transaction.source_processor_diagnostic_events.count({
        where: { organization_id: organizationId, severity: { in: ["warning", "critical"] } },
      }),
      transaction.operational_events.count({
        where: { organization_id: organizationId, severity: { in: ["warning", "critical"] } },
      }),
      transaction.$queryRaw<Array<{
        packCount: bigint;
        assetCount: bigint;
        pullCount: bigint;
        marketEventCount: bigint;
      }>>(Prisma.sql`
        select count(*) filter (where record_kind = 'pack')::bigint as "packCount",
               count(*) filter (where record_kind = 'catalog_asset')::bigint as "assetCount",
               count(*) filter (where record_kind = 'pull')::bigint as "pullCount",
               count(*) filter (where record_kind = 'market_event')::bigint as "marketEventCount"
        from public.canonical_entities
        where organization_id = ${organizationId}::uuid
          and platform_key = ${PLATFORM_KEY}
          and current_revision_id is not null
      `),
      transaction.$queryRaw<Array<{
        confirmationSetCount: bigint;
        currentPullConfirmationSetCount: bigint;
        confirmationItemCount: bigint;
        declaredConfirmationItemCount: bigint;
        confirmationSetSizeMismatchCount: bigint;
        unresolvedConfirmationItemCount: bigint;
      }>>(Prisma.sql`
        with set_sizes as (
          select confirmation_set.id,
                 confirmation_set.source_entity_id,
                 confirmation_set.source_canonical_revision_id,
                 confirmation_set.relationship_count,
                 count(confirmation.canonical_relationship_id)::integer as item_count
          from public.source_relationship_confirmation_sets confirmation_set
          left join public.source_relationship_confirmations confirmation
            on confirmation.organization_id = confirmation_set.organization_id
           and confirmation.confirmation_set_id = confirmation_set.id
          where confirmation_set.organization_id = ${organizationId}::uuid
          group by confirmation_set.id
        )
        select (select count(*) from set_sizes)::bigint as "confirmationSetCount",
               (
                 select count(*)
                 from set_sizes set_size
                 join public.canonical_entities pull
                   on pull.organization_id = ${organizationId}::uuid
                  and pull.id = set_size.source_entity_id
                  and pull.record_kind = 'pull'
                  and pull.current_revision_id = set_size.source_canonical_revision_id
               )::bigint as "currentPullConfirmationSetCount",
               (select coalesce(sum(item_count), 0) from set_sizes)::bigint
                 as "confirmationItemCount",
               (select coalesce(sum(relationship_count), 0) from set_sizes)::bigint
                 as "declaredConfirmationItemCount",
               (select count(*) from set_sizes where item_count <> relationship_count)::bigint
                 as "confirmationSetSizeMismatchCount",
               (
                 select count(*)
                 from public.source_relationship_confirmations confirmation
                 join public.canonical_relationships relationship
                   on relationship.organization_id = confirmation.organization_id
                  and relationship.id = confirmation.canonical_relationship_id
                 where confirmation.organization_id = ${organizationId}::uuid
                   and (
                     relationship.target_entity_id is null or
                     relationship.resolved_public_change_sequence is null or
                     relationship.resolved_at is null
                   )
               )::bigint as "unresolvedConfirmationItemCount"
      `),
      transaction.source_relationship_confirmation_backfills.findMany({
        where: { organization_id: organizationId },
        select: { phase: true, failure_code: true, completed_at: true },
      }),
      transaction.settled_public_watermarks.findUnique({
        where: { organization_id: organizationId },
        select: { settled_sequence: true, source_head_sequence: true, next_sequence: true },
      }),
      transaction.provider_catalog_checkpoints.findUnique({
        where: {
          organization_id_platform_key: {
            organization_id: organizationId,
            platform_key: PLATFORM_KEY,
          },
        },
        select: { settled_sequence: true, source_head_sequence: true },
      }),
      transaction.public_derivation_obligations.count({
        where: { organization_id: organizationId, state: { in: ["pending", "claimed"] } },
      }),
      transaction.provider_config_revisions.count(),
      transaction.provider_secret_versions.count(),
      transaction.provider_cursor_checkpoints.count(),
      transaction.$queryRaw<Array<{ externalId: string; content: unknown }>>(Prisma.sql`
        select entity.external_id as "externalId", revision.content_json as content
        from public.canonical_entities entity
        join public.canonical_revisions revision
          on revision.organization_id = entity.organization_id
         and revision.entity_id = entity.id
         and revision.id = entity.current_revision_id
        where entity.organization_id = ${organizationId}::uuid
          and entity.platform_key = ${PLATFORM_KEY}
          and entity.record_kind = 'pack'
        order by entity.external_id collate "C"
      `),
      transaction.$queryRaw<Array<{
        externalId: string;
        content: unknown;
        associated: boolean;
      }>>(Prisma.sql`
        select collectible.external_id as "externalId",
               revision.content_json as content,
               exists (
                 select 1
                 from public.canonical_entities pull
                 join public.canonical_relationships card_relationship
                   on card_relationship.organization_id = pull.organization_id
                  and card_relationship.source_entity_id = pull.id
                  and card_relationship.relationship_kind = 'card'
                  and card_relationship.target_platform_key = ${PLATFORM_KEY}
                  and card_relationship.target_record_kind = 'catalog_asset'
                  and card_relationship.target_entity_id = collectible.id
                  and card_relationship.resolved_public_change_sequence is not null
                  and card_relationship.resolved_at is not null
                 join public.canonical_relationships pack_relationship
                   on pack_relationship.organization_id = pull.organization_id
                  and pack_relationship.source_entity_id = pull.id
                  and pack_relationship.relationship_kind = 'pack'
                  and pack_relationship.target_platform_key = ${PLATFORM_KEY}
                  and pack_relationship.target_record_kind = 'pack'
                  and pack_relationship.target_entity_id is not null
                  and pack_relationship.resolved_public_change_sequence is not null
                  and pack_relationship.resolved_at is not null
                 where pull.organization_id = collectible.organization_id
                   and pull.platform_key = ${PLATFORM_KEY}
                   and pull.record_kind = 'pull'
               ) as associated
        from public.canonical_entities collectible
        join public.canonical_revisions revision
          on revision.organization_id = collectible.organization_id
         and revision.entity_id = collectible.id
         and revision.id = collectible.current_revision_id
        where collectible.organization_id = ${organizationId}::uuid
          and collectible.platform_key = ${PLATFORM_KEY}
          and collectible.record_kind = 'catalog_asset'
        order by collectible.external_id collate "C"
      `),
    ]);
    const source = sources[0];
    const sourceRevision = sourceRevisions[0];
    const latestRun = runs[0];
    const entityCounts = counts[0];
    const confirmationCounts = confirmation[0];
    if (!entityCounts || !confirmationCounts) refuse("DATABASE_READ_FAILED");
    return Object.freeze({
      organizationCount,
      providerCount: providers.length,
      providerPlatformKey: providers[0]?.platform_key ?? null,
      providerState: providers[0]?.state ?? null,
      sourceCount: sources.length,
      sourceState: source?.state ?? null,
      sourcePauseRequested: source ? source.pause_requested_at !== null : null,
      sourceRevisionCount: sourceRevisions.length,
      sourceRevisionId: sourceRevision?.id ?? null,
      sourceAdapterVersion: sourceRevision?.source_adapter_version ?? null,
      normalizedContractVersion: sourceRevision?.normalized_contract_version ?? null,
      mapperKey: sourceRevision?.mapper_key ?? null,
      mapperVersion: sourceRevision?.mapper_version ?? null,
      identityNamespaceKey: sourceRevision?.identity_namespace_key ?? null,
      cursorCodecVersion: sourceRevision?.cursor_codec_version ?? null,
      latestRunCount: runs.length,
      latestRunId: latestRun?.id ?? null,
      latestRunState: latestRun?.state ?? null,
      latestRunReachedProviderHead: latestRun?.reached_provider_head ?? null,
      latestRunFinished: latestRun?.finished_at !== null,
      latestRunFailureCode: latestRun?.failure_code ?? null,
      latestRunSourceRevisionId: latestRun?.source_revision_id ?? null,
      latestRunAdapterVersion: latestRun?.source_adapter_version ?? null,
      latestRunNormalizedContractVersion:
        latestRun?.normalized_contract_version ?? null,
      latestRunMapperKey: latestRun?.mapper_key ?? null,
      latestRunMapperVersion: latestRun?.mapper_version ?? null,
      latestRunIdentityNamespaceKey: latestRun?.identity_namespace_key ?? null,
      latestRunCursorCodecVersion: latestRun?.cursor_codec_version ?? null,
      activeRunCount,
      liveSupervisorCount: integer(liveSupervisors[0]?.count ?? 0n),
      deliveryCount,
      wrongDeliveryLineageCount,
      quarantineCount,
      nonInfoDiagnosticCount,
      nonInfoOperationalEventCount,
      canonicalPackCount: integer(entityCounts.packCount),
      canonicalAssetCount: integer(entityCounts.assetCount),
      canonicalPullCount: integer(entityCounts.pullCount),
      canonicalMarketEventCount: integer(entityCounts.marketEventCount),
      confirmationSetCount: integer(confirmationCounts.confirmationSetCount),
      currentPullConfirmationSetCount:
        integer(confirmationCounts.currentPullConfirmationSetCount),
      confirmationItemCount: integer(confirmationCounts.confirmationItemCount),
      declaredConfirmationItemCount:
        integer(confirmationCounts.declaredConfirmationItemCount),
      confirmationSetSizeMismatchCount:
        integer(confirmationCounts.confirmationSetSizeMismatchCount),
      unresolvedConfirmationItemCount:
        integer(confirmationCounts.unresolvedConfirmationItemCount),
      backfillCount: backfills.length,
      completeBackfillCount: backfills.filter(({ phase, failure_code, completed_at }) =>
        phase === "complete" && failure_code === null && completed_at !== null
      ).length,
      globalSettledSequence: globalWatermark?.settled_sequence ?? null,
      globalSourceHeadSequence: globalWatermark?.source_head_sequence ?? null,
      globalNextSequence: globalWatermark?.next_sequence ?? null,
      providerSettledSequence: providerCheckpoint?.settled_sequence ?? null,
      providerSourceHeadSequence: providerCheckpoint?.source_head_sequence ?? null,
      pendingObligationCount,
      legacyProviderConfigurationCount,
      legacyProviderSecretCount,
      legacyProviderCursorCount,
      packs: Object.freeze(packs),
      assets: Object.freeze(assets),
    });
  }, {
    ...PACKSCOUT_TRANSACTION_OPTIONS,
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  });
}

function candidateBinding(input: Readonly<{
  databaseTarget: string;
  organizationId: string;
  outputPath: string;
  latestRunId: string;
  configurationHash: string;
}>): Readonly<{ digest: string; confirmation: string }> {
  const digest = createHash("sha256").update([
    CANDIDATE_DIGEST_DOMAIN,
    input.databaseTarget,
    input.organizationId,
    input.outputPath,
    input.latestRunId,
    input.configurationHash,
  ].join("\n")).digest("hex");
  return Object.freeze({
    digest,
    confirmation: `${CONFIRMATION_PREFIX} ${digest.slice(0, 16)}`,
  });
}

async function writeCreateOnlyPrivateFile(
  outputPath: string,
  contents: string,
): Promise<void> {
  let handle;
  try {
    handle = await open(
      outputPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600,
    );
    await handle.writeFile(contents, { encoding: "utf8" });
    await handle.sync();
    await handle.chmod(0o600);
    await handle.close();
    handle = undefined;
    const metadata = await stat(outputPath);
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
      refuse("OUTPUT_WRITE_FAILED");
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      refuse("OUTPUT_ALREADY_EXISTS");
    }
    if (error instanceof ClutchpacksCatalogCandidateError) throw error;
    refuse("OUTPUT_WRITE_FAILED");
  }
}

export async function runClutchpacksCatalogCandidate(input: Readonly<{
  argv: readonly string[];
  environment: NodeJS.ProcessEnv;
  readEvidence?: (
    databaseUrl: string,
    organizationId: string,
  ) => Promise<ClutchpacksCatalogQualificationEvidence>;
  writeCandidate?: (outputPath: string, contents: string) => Promise<void>;
  writeOutput?: (value: string) => void;
}>): Promise<unknown> {
  const command = parseClutchpacksCatalogCandidateCommand(input.argv);
  const environment = readClutchpacksCatalogCandidateEnvironment(input.environment);
  let evidence: ClutchpacksCatalogQualificationEvidence;
  if (input.readEvidence) {
    evidence = await input.readEvidence(environment.databaseUrl, environment.organizationId);
  } else {
    const lifecycle = createPrismaClientLifecycle({
      databaseUrl: environment.databaseUrl,
    });
    try {
      await lifecycle.start();
      evidence = await readQualificationEvidence(
        lifecycle.client,
        environment.organizationId,
      );
    } catch (error) {
      if (error instanceof ClutchpacksCatalogCandidateError) throw error;
      return refuse("DATABASE_READ_FAILED");
    } finally {
      await lifecycle.close().catch(() => undefined);
    }
  }
  const configuration = buildClutchpacksCatalogCandidate(
    evidence,
    environment.policy,
  );
  const configurationHash = await sha256CanonicalJson(
    PUBLIC_CATALOG_CONFIGURATION_HASH_DOMAIN,
    configuration,
  );
  const serialized = `${canonicalJson(configuration)}\n`;
  const binding = candidateBinding({
    databaseTarget: environment.databaseTarget,
    organizationId: environment.organizationId,
    outputPath: command.outputPath,
    latestRunId: evidence.latestRunId!,
    configurationHash,
  });
  const associatedCollectibleCount = evidence.assets.filter(
    ({ associated }) => associated,
  ).length;
  const summary = Object.freeze({
    ok: true,
    operation: WORKFLOW,
    mode: command.execute ? "execute" : "dry_run",
    targetDatabase: TARGET_DATABASE_NAME,
    organizationId: environment.organizationId,
    latestRunId: evidence.latestRunId,
    packCount: evidence.packs.length,
    collectibleMappingCount: evidence.assets.length,
    associatedCollectibleCount,
    unassociatedCollectibleCount: evidence.assets.length - associatedCollectibleCount,
    publicAssetOriginCount: configuration.publicAssetOrigins.length,
    serializedBytes: Buffer.byteLength(serialized),
    configurationHash,
    candidateDigest: binding.digest,
    requiredConfirmation: binding.confirmation,
    outputPath: command.outputPath,
    written: command.execute,
  });
  if (command.execute) {
    if (command.confirmation !== binding.confirmation) refuse("CONFIRMATION_INVALID");
    await (input.writeCandidate ?? writeCreateOnlyPrivateFile)(
      command.outputPath,
      serialized,
    );
  }
  (input.writeOutput ?? ((value) => process.stdout.write(`${value}\n`)))(
    JSON.stringify(summary),
  );
  return summary;
}

export function clutchpacksCatalogCandidateUsage(): string {
  return `Usage:
  npm run generate:catalog-candidate:clutchpacks:local -- \\
    --output /absolute/private/path/clutchpacks-v2-catalog.json

  npm run generate:catalog-candidate:clutchpacks:local -- \\
    --execute --output /absolute/private/path/clutchpacks-v2-catalog.json \\
    --confirmation "${CONFIRMATION_PREFIX} <16hex>"

Default mode is read-only. Both modes re-read and qualify the exact paused,
provider-head, adapter-v2 ClutchPacks target. Execute creates one new 0600 file
and refuses an existing path. The required policy is supplied only through the
protected PACKSCOUT_CLUTCHPACKS_CATALOG_* environment variables.`;
}

function safeFailure(error: unknown): Readonly<{
  ok: false;
  operation: typeof WORKFLOW;
  code: ClutchpacksCatalogCandidateErrorCode | "UNEXPECTED_FAILURE";
}> {
  return Object.freeze({
    ok: false,
    operation: WORKFLOW,
    code: error instanceof ClutchpacksCatalogCandidateError
      ? error.code
      : "UNEXPECTED_FAILURE",
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.slice(2).includes("--help")) {
    process.stdout.write(`${clutchpacksCatalogCandidateUsage()}\n`);
  } else {
    runClutchpacksCatalogCandidate({
      argv: process.argv.slice(2),
      environment: process.env,
    }).catch((error: unknown) => {
      process.stderr.write(`${JSON.stringify(safeFailure(error))}\n`);
      process.exitCode = 1;
    });
  }
}

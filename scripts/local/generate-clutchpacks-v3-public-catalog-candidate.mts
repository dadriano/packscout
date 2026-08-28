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
  parsedHttpsUrl,
  publicHttpsOriginSchema,
} from "../../packages/contracts/src/data-release-v2.ts";
import {
  providerSourceCanonicalCatalogAssetContentV1Schema,
  providerSourceCanonicalPackContentV1Schema,
} from "../../packages/contracts/src/provider-source-canonical-content-v1.ts";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  createPrismaClientLifecycle,
  type PackscoutPrismaClient,
  type PackscoutTransactionClient,
} from "../../packages/database/src/database.ts";
import {
  loadProviderV1AssetPackAssociations,
  type ProviderV1AssetPackAssociationSnapshot,
} from "../../packages/database/src/provider-v1-asset-pack-association-reader.ts";
import { Prisma } from "@prisma/client";
import {
  assertSameConnectedPostgresIdentity,
  connectedPostgresIdentityBindingParts,
  readConnectedPostgresIdentity,
} from "./connected-postgres-identity.mjs";

const WORKFLOW = "generate_clutchpacks_v3_public_catalog_candidate" as const;
const PLATFORM_KEY = "clutchpacks" as const;
const TARGET_DATABASE_NAME = "packscout_clutchpacks_v3_canary" as const;
const TARGET_ACKNOWLEDGEMENT =
  "I_UNDERSTAND_THE_TARGET_MUST_BE_A_FRESH_LOCAL_DATABASE" as const;
const CONFIRMATION_PREFIX = "WRITE CLUTCHPACKS V3 CATALOG LOCAL" as const;
const CANDIDATE_DIGEST_DOMAIN =
  "packscout.clutchpacks-v3-public-catalog-candidate.v1" as const;
const PUBLIC_CATALOG_CONFIGURATION_HASH_DOMAIN =
  "packscout.public-catalog.configuration.v1" as const;
export const CLUTCHPACKS_CATALOG_QUALIFICATION_TRANSACTION_TIMEOUT_MS =
  120_000 as const;
const CLUTCHPACKS_CHECKOUT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CLUTCHPACKS_PUBLIC_ORIGIN = "https://clutchpacks.io" as const;
const PUBLIC_ASSET_ORIGIN_ALLOWLIST_ENVIRONMENT_VARIABLE =
  "PACKSCOUT_CLUTCHPACKS_CATALOG_PUBLIC_ASSET_ORIGINS_JSON" as const;
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

function publicAssetOriginAllowlist(
  environment: NodeJS.ProcessEnv,
): readonly string[] {
  const raw = environment[PUBLIC_ASSET_ORIGIN_ALLOWLIST_ENVIRONMENT_VARIABLE];
  if (
    raw === undefined || raw.length === 0 || raw.trim() !== raw ||
    Buffer.byteLength(raw, "utf8") > 131_072
  ) {
    refuse("ENVIRONMENT_INVALID");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return refuse("ENVIRONMENT_INVALID");
  }
  if (
    !Array.isArray(value) ||
    value.length > 64 ||
    JSON.stringify(value) !== raw
  ) {
    refuse("ENVIRONMENT_INVALID");
  }
  const origins = value.map((origin) => {
    const parsed = publicHttpsOriginSchema.safeParse(origin);
    if (!parsed.success) refuse("ENVIRONMENT_INVALID");
    return parsed.data;
  });
  if (origins.some((origin, index) =>
    index > 0 && origins[index - 1]! >= origin)) {
    refuse("ENVIRONMENT_INVALID");
  }
  return Object.freeze(origins);
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
  readonly publicAssetOriginAllowlist: readonly string[];
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
    environment.PACKSCOUT_CLUTCHPACKS_V3_TARGET_ACK?.trim() !==
      TARGET_ACKNOWLEDGEMENT
  ) {
    refuse("ENVIRONMENT_INVALID");
  }
  const target = canonicalLocalTarget(required(environment, "PACKSCOUT_DATABASE_URL"));
  const organizationId = required(
    environment,
    "PACKSCOUT_CLUTCHPACKS_V3_CANARY_ORGANIZATION_ID",
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
    publicAssetOriginAllowlist: publicAssetOriginAllowlist(environment),
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
    const confirmationFlag: string | undefined = tokens.at(0);
    if (
      tokens.length !== 2 || confirmationFlag !== "--confirmation" ||
      !tokens[1]
    ) {
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
  readonly databaseIdentity: ClutchpacksCatalogDatabaseIdentity;
  readonly organizationCount: number;
  readonly providerCount: number;
  readonly providerPlatformKey: string | null;
  readonly providerState: string | null;
  readonly sourceCount: number;
  readonly sourceInstanceId: string | null;
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
  readonly currentCursorCount: number;
  readonly currentCursorSourceInstanceId: string | null;
  readonly currentCursorSourceRevisionId: string | null;
  readonly currentCursorGeneration: bigint | null;
  readonly latestRunCount: number;
  readonly latestRunId: string | null;
  readonly latestRunState: string | null;
  readonly latestRunReachedProviderHead: boolean | null;
  readonly latestRunFinished: boolean;
  readonly latestRunFailureCode: string | null;
  readonly latestRunSourceInstanceId: string | null;
  readonly latestRunSourceRevisionId: string | null;
  readonly latestRunCursorGeneration: bigint | null;
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
  readonly unresolvedCurrentGenerationDiagnosticCount: number;
  readonly unresolvedCurrentGenerationOperationalEventCount: number;
  readonly unresolvedProviderHealthCount: number;
  readonly unresolvedSourceHealthCount: number;
  readonly openConnectionHealthEpisodeCount: number;
  readonly canonicalPackCount: number;
  readonly canonicalAssetCount: number;
  readonly canonicalPullCount: number;
  readonly canonicalMarketEventCount: number;
  readonly confirmationSetCount: number;
  readonly coveredCurrentPullCount: number;
  readonly confirmationItemCount: number;
  readonly declaredConfirmationItemCount: number;
  readonly confirmationSetSizeMismatchCount: number;
  readonly unresolvedConfirmationItemCount: number;
  readonly backfillCount: number;
  readonly completeBackfillCount: number;
  readonly globalSettledSequence: bigint | null;
  readonly globalSourceHeadSequence: bigint | null;
  readonly globalNextSequence: bigint | null;
  readonly globalSettledAt: Date | null;
  readonly globalSourceHeadAt: Date | null;
  readonly providerSettledSequence: bigint | null;
  readonly providerSourceHeadSequence: bigint | null;
  readonly providerSettledAt: Date | null;
  readonly providerSourceHeadAt: Date | null;
  readonly pendingObligationCount: number;
  readonly legacyProviderConfigurationCount: number;
  readonly legacyProviderSecretCount: number;
  readonly legacyProviderCursorCount: number;
  readonly packs: readonly ClutchpacksCatalogEntityCandidate[];
  readonly assets: readonly ClutchpacksCatalogEntityCandidate[];
}

export interface ClutchpacksCatalogDatabaseIdentity {
  readonly databaseName: string;
  readonly databaseOid: string;
  readonly systemIdentifier: string;
}

export function clutchpacksAssetHasPublicName(
  asset: ClutchpacksCatalogEntityCandidate,
): boolean {
  if (typeof asset.content !== "object" || asset.content === null) return false;
  const name = (asset.content as Readonly<Record<string, unknown>>).name;
  return typeof name === "string" && name.trim().length > 0 &&
    name.trim().length <= 240;
}

export function clutchpacksAssetIsOmittablePublicShell(
  asset: ClutchpacksCatalogEntityCandidate,
): boolean {
  return asset.associated === false && !clutchpacksAssetHasPublicName(asset);
}

/**
 * Marks current catalog assets from one set-oriented settled-association read.
 * The iterable is consumed exactly once so qualification never performs a
 * relationship lookup (or scan) per asset.
 */
export function attachClutchpacksCatalogAssetAssociationEvidence(
  assets: readonly ClutchpacksCatalogEntityCandidate[],
  associations: Iterable<
    Pick<ProviderV1AssetPackAssociationSnapshot, "assetExternalId">
  >,
): readonly ClutchpacksCatalogEntityCandidate[] {
  const associatedExternalIds = new Set<string>();
  for (const association of associations) {
    associatedExternalIds.add(association.assetExternalId);
  }
  return Object.freeze(assets.map((asset) => Object.freeze({
    ...asset,
    associated: associatedExternalIds.has(asset.externalId),
  })));
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
    !evidence.sourceInstanceId ||
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
    evidence.currentCursorCount !== 1 ||
    evidence.currentCursorSourceInstanceId !== evidence.sourceInstanceId ||
    evidence.currentCursorSourceRevisionId !== evidence.sourceRevisionId ||
    evidence.currentCursorGeneration === null ||
    evidence.currentCursorGeneration < 1n ||
    evidence.latestRunCount !== 1 ||
    !evidence.latestRunId ||
    evidence.latestRunState !== "succeeded" ||
    evidence.latestRunReachedProviderHead !== true ||
    !evidence.latestRunFinished ||
    evidence.latestRunFailureCode !== null ||
    evidence.latestRunSourceInstanceId !== evidence.sourceInstanceId ||
    evidence.latestRunSourceRevisionId !== evidence.sourceRevisionId ||
    evidence.latestRunCursorGeneration !== evidence.currentCursorGeneration ||
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
    evidence.unresolvedCurrentGenerationDiagnosticCount !== 0 ||
    evidence.unresolvedCurrentGenerationOperationalEventCount !== 0 ||
    evidence.unresolvedProviderHealthCount !== 0 ||
    evidence.unresolvedSourceHealthCount !== 0 ||
    evidence.openConnectionHealthEpisodeCount !== 0 ||
    evidence.canonicalPackCount < 1 ||
    evidence.canonicalAssetCount < 1 ||
    evidence.canonicalPullCount < 1 ||
    evidence.canonicalMarketEventCount < 1 ||
    evidence.packs.length !== evidence.canonicalPackCount ||
    evidence.assets.length !== evidence.canonicalAssetCount ||
    evidence.coveredCurrentPullCount !== evidence.canonicalPullCount ||
    evidence.confirmationSetCount < evidence.coveredCurrentPullCount ||
    evidence.confirmationItemCount !== evidence.declaredConfirmationItemCount ||
    evidence.confirmationSetSizeMismatchCount !== 0 ||
    evidence.unresolvedConfirmationItemCount !== 0 ||
    evidence.backfillCount !== 1 ||
    evidence.completeBackfillCount !== 1 ||
    evidence.globalSettledSequence === null ||
    evidence.globalSourceHeadSequence === null ||
    evidence.globalNextSequence === null ||
    evidence.globalSettledAt === null ||
    evidence.globalSourceHeadAt === null ||
    evidence.providerSettledSequence === null ||
    evidence.providerSourceHeadSequence === null ||
    evidence.providerSettledAt === null ||
    evidence.providerSourceHeadAt === null ||
    evidence.globalSettledSequence !== evidence.globalSourceHeadSequence ||
    evidence.providerSettledSequence !== evidence.providerSourceHeadSequence ||
    evidence.providerSettledSequence !== evidence.globalSettledSequence ||
    evidence.globalSettledAt.getTime() !==
      evidence.globalSourceHeadAt.getTime() ||
    evidence.providerSettledAt.getTime() !==
      evidence.providerSourceHeadAt.getTime() ||
    evidence.providerSettledAt.getTime() !==
      evidence.globalSettledAt.getTime() ||
    evidence.globalNextSequence !== evidence.globalSourceHeadSequence + 1n ||
    evidence.pendingObligationCount !== 0 ||
    evidence.legacyProviderConfigurationCount !== 0 ||
    evidence.legacyProviderSecretCount !== 0 ||
    evidence.legacyProviderCursorCount !== 0
  ) {
    refuse("TARGET_NOT_QUALIFIED");
  }
  const unnamedAssociated = evidence.assets.filter((asset) =>
    asset.associated === true && !clutchpacksAssetHasPublicName(asset));
  if (unnamedAssociated.length !== 0) refuse("TARGET_NOT_QUALIFIED");
}

function canonicalPackEntity(entity: ClutchpacksCatalogEntityCandidate) {
  const parsed = providerSourceCanonicalPackContentV1Schema.safeParse(
    entity.content,
  );
  if (!parsed.success) refuse("TARGET_NOT_QUALIFIED");
  return Object.freeze({ ...entity, content: parsed.data });
}

function canonicalCatalogAssetEntity(
  entity: ClutchpacksCatalogEntityCandidate,
) {
  const parsed = providerSourceCanonicalCatalogAssetContentV1Schema.safeParse(
    entity.content,
  );
  if (!parsed.success) refuse("TARGET_NOT_QUALIFIED");
  return Object.freeze({ ...entity, content: parsed.data });
}

function observedPublicAssetOrigins(
  entities: readonly Readonly<{
    content: Readonly<{ imageUrls: readonly string[] }>;
  }>[],
  allowedOrigins: readonly string[],
): readonly string[] {
  const allowed = new Set(allowedOrigins);
  const observed = new Set<string>();
  for (const { content } of entities) {
    for (const imageUrl of content.imageUrls) {
      const parsed = parsedHttpsUrl(imageUrl);
      if (parsed === null || !allowed.has(parsed.origin)) {
        refuse("TARGET_NOT_QUALIFIED");
      }
      observed.add(parsed.origin);
    }
  }
  return Object.freeze([...observed].sort());
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

function clutchpacksListingUrl(externalId: string): string {
  if (!CLUTCHPACKS_CHECKOUT_ID_PATTERN.test(externalId)) {
    refuse("TARGET_NOT_QUALIFIED");
  }
  return `${CLUTCHPACKS_PUBLIC_ORIGIN}/checkout/${externalId}/`;
}

type ClutchpacksPublicCategoryDefinition = Readonly<{
  sourceValue: string;
  categoryKey: string;
  name: string;
  kind: "vertical" | "sport" | "franchise" | "other";
  parentCategoryKey: string | null;
  displayOrder: number;
}>;

const clutchpacksPublicCategoryDefinitions = Object.freeze([
  Object.freeze({
    sourceValue: "Sports",
    categoryKey: "sports",
    name: "Sports",
    kind: "vertical" as const,
    parentCategoryKey: null,
    displayOrder: 0,
  }),
  Object.freeze({
    sourceValue: "TCG",
    categoryKey: "trading-card-games",
    name: "Trading card games",
    kind: "vertical" as const,
    parentCategoryKey: null,
    displayOrder: 1,
  }),
  Object.freeze({
    sourceValue: "Baseball",
    categoryKey: "baseball",
    name: "Baseball",
    kind: "sport" as const,
    parentCategoryKey: "sports",
    displayOrder: 10,
  }),
  Object.freeze({
    sourceValue: "Basketball",
    categoryKey: "basketball",
    name: "Basketball",
    kind: "sport" as const,
    parentCategoryKey: "sports",
    displayOrder: 11,
  }),
  Object.freeze({
    sourceValue: "Football",
    categoryKey: "football",
    name: "Football",
    kind: "sport" as const,
    parentCategoryKey: "sports",
    displayOrder: 12,
  }),
  Object.freeze({
    sourceValue: "Soccer",
    categoryKey: "soccer",
    name: "Soccer",
    kind: "sport" as const,
    parentCategoryKey: "sports",
    displayOrder: 13,
  }),
  Object.freeze({
    sourceValue: "Multisport",
    categoryKey: "multi-sport",
    name: "Multi-sport",
    kind: "other" as const,
    parentCategoryKey: "sports",
    displayOrder: 14,
  }),
  Object.freeze({
    sourceValue: "Marvel",
    categoryKey: "marvel",
    name: "Marvel",
    kind: "franchise" as const,
    parentCategoryKey: "trading-card-games",
    displayOrder: 20,
  }),
  Object.freeze({
    sourceValue: "One Piece",
    categoryKey: "one-piece",
    name: "One Piece",
    kind: "franchise" as const,
    parentCategoryKey: "trading-card-games",
    displayOrder: 21,
  }),
  Object.freeze({
    sourceValue: "Pokemon",
    categoryKey: "pokemon",
    name: "Pokémon",
    kind: "franchise" as const,
    parentCategoryKey: "trading-card-games",
    displayOrder: 22,
  }),
] satisfies readonly ClutchpacksPublicCategoryDefinition[]);

const clutchpacksCategoryBySourceValue = new Map<
  string,
  ClutchpacksPublicCategoryDefinition
>(
  clutchpacksPublicCategoryDefinitions.map((definition) => [
    definition.sourceValue,
    definition,
  ]),
);
const clutchpacksCategoryByKey = new Map<
  string,
  ClutchpacksPublicCategoryDefinition
>(
  clutchpacksPublicCategoryDefinitions.map((definition) => [
    definition.categoryKey,
    definition,
  ]),
);

function canonicalSourceCategory(content: unknown): string | null {
  if (typeof content !== "object" || content === null || Array.isArray(content)) {
    refuse("TARGET_NOT_QUALIFIED");
  }
  const category = (content as Readonly<Record<string, unknown>>).category;
  if (category === null || category === undefined) return null;
  if (
    typeof category !== "string" ||
    category.trim() !== category ||
    category.length === 0
  ) {
    refuse("TARGET_NOT_QUALIFIED");
  }
  return category;
}

function clutchpacksCategoryConfiguration(
  namespaceUuid: string,
  entities: readonly ClutchpacksCatalogEntityCandidate[],
) {
  const observedSourceValues = [...new Set(
    entities.map(({ content }) => canonicalSourceCategory(content)).filter(
      (value): value is string => value !== null,
    ),
  )].sort();
  const observedDefinitions = observedSourceValues.map((sourceValue) => {
    const definition = clutchpacksCategoryBySourceValue.get(sourceValue);
    if (!definition) refuse("TARGET_NOT_QUALIFIED");
    return definition;
  });
  const includedKeys = new Set<string>();
  for (const definition of observedDefinitions) {
    includedKeys.add(definition.categoryKey);
    if (definition.parentCategoryKey !== null) {
      includedKeys.add(definition.parentCategoryKey);
    }
  }
  const publicIdByKey = new Map(
    [...includedKeys].map((categoryKey) => [
      categoryKey,
      uuidV5(namespaceUuid, `category\0${categoryKey}`),
    ]),
  );
  const pathIds = (definition: ClutchpacksPublicCategoryDefinition) => {
    const ownId = publicIdByKey.get(definition.categoryKey);
    if (!ownId) refuse("TARGET_NOT_QUALIFIED");
    if (definition.parentCategoryKey === null) return [ownId];
    const parent = clutchpacksCategoryByKey.get(definition.parentCategoryKey);
    const parentId = publicIdByKey.get(definition.parentCategoryKey);
    if (!parent || !parentId || parent.parentCategoryKey !== null) {
      refuse("TARGET_NOT_QUALIFIED");
    }
    return [parentId, ownId];
  };
  const publicCategoryIdsForSourceValue = (sourceValue: string | null) => {
    if (sourceValue === null) return Object.freeze([] as string[]);
    const definition = clutchpacksCategoryBySourceValue.get(sourceValue);
    if (!definition) refuse("TARGET_NOT_QUALIFIED");
    return Object.freeze([...pathIds(definition)].sort());
  };
  const categories = clutchpacksPublicCategoryDefinitions
    .filter(({ categoryKey }) => includedKeys.has(categoryKey))
    .map((definition) => {
      const pathPublicCategoryIds = pathIds(definition);
      return Object.freeze({
        publicCategoryId: pathPublicCategoryIds.at(-1)!,
        parentPublicCategoryId: pathPublicCategoryIds.at(-2) ?? null,
        categoryKey: definition.categoryKey,
        name: definition.name,
        kind: definition.kind,
        depth: pathPublicCategoryIds.length - 1,
        pathPublicCategoryIds,
        displayOrder: definition.displayOrder,
      });
    })
    .sort((left, right) =>
      left.publicCategoryId.localeCompare(right.publicCategoryId)
    );
  const categoryMappings = observedDefinitions
    .map((definition) => Object.freeze({
      sourceValue: definition.sourceValue,
      publicCategoryIds: publicCategoryIdsForSourceValue(
        definition.sourceValue,
      ),
    }))
    .sort((left, right) => left.sourceValue.localeCompare(right.sourceValue));
  return Object.freeze({
    categories: Object.freeze(categories),
    categoryMappings: Object.freeze(categoryMappings),
    publicCategoryIdsForSourceValue,
  });
}

export function buildClutchpacksCatalogCandidate(
  evidence: ClutchpacksCatalogQualificationEvidence,
  policy: ClutchpacksCatalogCandidatePolicy,
): ApprovedPublicCatalogConfigurationV1 {
  assertClutchpacksCatalogCandidateTargetQualified(evidence);
  const packs = evidence.packs.map(canonicalPackEntity).sort(compareExternalId);
  const assets = evidence.assets.map(canonicalCatalogAssetEntity)
    .sort(compareExternalId);
  const publicAssets = assets.filter(
    (asset) => !clutchpacksAssetIsOmittablePublicShell(asset),
  );
  if (
    new Set(packs.map(({ externalId }) => externalId)).size !== packs.length ||
    new Set(assets.map(({ externalId }) => externalId)).size !== assets.length
  ) {
    refuse("TARGET_NOT_QUALIFIED");
  }
  const publicAssetOrigins = observedPublicAssetOrigins(
    [...packs, ...assets],
    policy.publicAssetOriginAllowlist,
  );
  const categoryConfiguration = clutchpacksCategoryConfiguration(
    policy.namespaceUuid,
    [...packs, ...publicAssets],
  );
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
    categories: categoryConfiguration.categories,
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
        websiteUrl: `${CLUTCHPACKS_PUBLIC_ORIGIN}/`,
        listingHosts: ["clutchpacks.io"],
        imageOrigins: publicAssetOrigins,
        referralParameters: [],
        publicPromo: null,
      },
      format: policy.format,
      defaultPublicCategoryIds: [],
      categoryMappings: categoryConfiguration.categoryMappings,
      collectibleTypeMappings: [],
    }],
    repacks: packs.map(({ externalId }) => ({
      platformKey: PLATFORM_KEY,
      packExternalId: externalId,
      publicRepackId: uuidV5(
        policy.namespaceUuid,
        `repack\0${PLATFORM_KEY}\0${externalId}`,
      ),
      listingUrl: clutchpacksListingUrl(externalId),
    })),
    collectibles: publicAssets.map(({ externalId, associated, content }) => ({
      platformKey: PLATFORM_KEY,
      externalId,
      publicCollectibleId: uuidV5(
        policy.namespaceUuid,
        `collectible\0${PLATFORM_KEY}\0${externalId}`,
      ),
      aliases: [],
      collectibleType: "card" as const,
      publicCategoryIds: categoryConfiguration.publicCategoryIdsForSourceValue(
        canonicalSourceCategory(content),
      ),
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

export async function applyClutchpacksCatalogQualificationTransactionGuards(
  transaction: Pick<PackscoutTransactionClient, "$executeRaw" | "$queryRaw">,
): Promise<void> {
  await transaction.$executeRaw(Prisma.sql`set transaction read only`);
  await transaction.$queryRaw(Prisma.sql`
    select set_config(
      'statement_timeout',
      ${`${CLUTCHPACKS_CATALOG_QUALIFICATION_TRANSACTION_TIMEOUT_MS}ms`},
      true
    )
  `);
}

export async function readClutchpacksCatalogDatabaseIdentity(
  database: Pick<PackscoutPrismaClient, "$queryRawUnsafe">,
): Promise<ClutchpacksCatalogDatabaseIdentity> {
  try {
    return await readConnectedPostgresIdentity(
      (sql: string) => database.$queryRawUnsafe<
        ClutchpacksCatalogDatabaseIdentity[]
      >(sql),
      TARGET_DATABASE_NAME,
    ) as ClutchpacksCatalogDatabaseIdentity;
  } catch {
    return refuse("DATABASE_READ_FAILED");
  }
}

export async function readClutchpacksCatalogQualificationEvidence(
  database: PackscoutPrismaClient,
  organizationId: string,
): Promise<ClutchpacksCatalogQualificationEvidence> {
  return database.$transaction(async (transaction) => {
    await applyClutchpacksCatalogQualificationTransactionGuards(transaction);
    const databaseIdentity = await readClutchpacksCatalogDatabaseIdentity(
      transaction,
    );
    const associationScopes = await transaction.$queryRaw<Array<{
      sourceRevisionId: string | null;
      settledSequence: bigint;
      settledAt: Date;
    }>>(Prisma.sql`
      select source.active_revision_id::text as "sourceRevisionId",
             watermark.settled_sequence as "settledSequence",
             watermark.settled_at as "settledAt"
      from public.provider_sources provider
      join public.provider_source_instances source
        on source.organization_id = provider.organization_id
       and source.provider_id = provider.id
      join public.settled_public_watermarks watermark
        on watermark.organization_id = provider.organization_id
      where provider.organization_id = ${organizationId}::uuid
        and provider.platform_key = ${PLATFORM_KEY}
      order by source.id
    `);
    const associationScope = associationScopes.length === 1
      ? associationScopes[0]
      : undefined;
    const associationRead = associationScope?.sourceRevisionId
      ? loadProviderV1AssetPackAssociations(transaction, {
        organizationId,
        platformKey: PLATFORM_KEY,
        sourceRevisionId: associationScope.sourceRevisionId,
        throughSequence: associationScope.settledSequence,
        throughOccurredAt: associationScope.settledAt,
      })
      : Promise.resolve([]);
    const [
      organizationCount,
      providers,
      sources,
      sourceRevisions,
      currentCursorRuns,
      activeRunCount,
      liveSupervisors,
      deliveryCount,
      wrongDeliveryLineageCount,
      quarantineCount,
      unresolvedCurrentGenerationDiagnostics,
      unresolvedCurrentGenerationOperationalEvents,
      unresolvedProviderHealthCount,
      unresolvedSourceHealthCount,
      openConnectionHealthEpisodeCount,
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
      rawAssets,
      assetPackAssociations,
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
      transaction.$queryRaw<Array<{
        sourceInstanceId: string;
        sourceRevisionId: string;
        cursorGeneration: bigint;
        runId: string | null;
        runState: string | null;
        runReachedProviderHead: boolean | null;
        runFinishedAt: Date | null;
        runFailureCode: string | null;
        runSourceInstanceId: string | null;
        runSourceRevisionId: string | null;
        runCursorGeneration: bigint | null;
        runSourceAdapterVersion: string | null;
        runNormalizedContractVersion: string | null;
        runMapperKey: string | null;
        runMapperVersion: string | null;
        runIdentityNamespaceKey: string | null;
        runCursorCodecVersion: string | null;
      }>>(Prisma.sql`
        select source.id::text as "sourceInstanceId",
               source.active_revision_id::text as "sourceRevisionId",
               cursor.cursor_generation as "cursorGeneration",
               latest_run.id::text as "runId",
               latest_run.state::text as "runState",
               latest_run.reached_provider_head as "runReachedProviderHead",
               latest_run.finished_at as "runFinishedAt",
               latest_run.failure_code as "runFailureCode",
               latest_run.source_instance_id::text as "runSourceInstanceId",
               latest_run.source_revision_id::text as "runSourceRevisionId",
               latest_run.cursor_generation as "runCursorGeneration",
               latest_run.source_adapter_version as "runSourceAdapterVersion",
               latest_run.normalized_contract_version
                 as "runNormalizedContractVersion",
               latest_run.mapper_key as "runMapperKey",
               latest_run.mapper_version as "runMapperVersion",
               latest_run.identity_namespace_key as "runIdentityNamespaceKey",
               latest_run.cursor_codec_version as "runCursorCodecVersion"
        from public.provider_sources provider
        join public.provider_source_instances source
          on source.organization_id = provider.organization_id
         and source.provider_id = provider.id
        join public.provider_source_cursors cursor
          on cursor.organization_id = source.organization_id
         and cursor.provider_id = source.provider_id
         and cursor.source_instance_id = source.id
         and cursor.source_revision_id = source.active_revision_id
        left join lateral (
          select run.*
          from public.import_runs run
          where run.organization_id = source.organization_id
            and run.provider_id = source.provider_id
            and run.source_instance_id = source.id
            and run.source_revision_id = source.active_revision_id
            and run.cursor_generation = cursor.cursor_generation
          order by run.created_at desc, run.id desc
          limit 1
        ) latest_run on true
        where provider.organization_id = ${organizationId}::uuid
          and provider.platform_key = ${PLATFORM_KEY}
      `),
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
      transaction.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        with current_source as (
          select source.id as source_instance_id,
                 source.provider_id,
                 source.connection_profile_id,
                 source.active_revision_id as source_revision_id,
                 cursor.cursor_generation,
                 (
                   select min(run.created_at)
                   from public.import_runs run
                   where run.organization_id = source.organization_id
                     and run.provider_id = source.provider_id
                     and run.source_instance_id = source.id
                     and run.source_revision_id = source.active_revision_id
                     and run.cursor_generation = cursor.cursor_generation
                 ) as generation_started_at
          from public.provider_source_instances source
          join public.provider_sources provider
            on provider.organization_id = source.organization_id
           and provider.id = source.provider_id
           and provider.platform_key = ${PLATFORM_KEY}
          join public.provider_source_cursors cursor
            on cursor.organization_id = source.organization_id
           and cursor.provider_id = source.provider_id
           and cursor.source_instance_id = source.id
           and cursor.source_revision_id = source.active_revision_id
          where source.organization_id = ${organizationId}::uuid
        )
        select count(*)::bigint as count
        from public.source_processor_diagnostic_events diagnostic
        join current_source current
          on current.connection_profile_id = diagnostic.connection_profile_id
        left join public.import_runs run
          on run.organization_id = diagnostic.organization_id
         and run.id = diagnostic.run_id
        where diagnostic.organization_id = ${organizationId}::uuid
          and diagnostic.severity in ('warning', 'critical')
          and (
            (
              diagnostic.run_id is not null
              and run.cursor_generation = current.cursor_generation
              and (
                diagnostic.severity = 'critical'
                or run.state <> 'succeeded'
                or run.reached_provider_head is distinct from true
                or run.finished_at is null
                or run.failure_code is not null
                or run.source_instance_id is distinct from current.source_instance_id
                or run.source_revision_id is distinct from current.source_revision_id
              )
            )
            or (
              diagnostic.run_id is null
              and current.generation_started_at is not null
              and diagnostic.occurred_at >= current.generation_started_at
            )
          )
      `),
      transaction.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        with current_source as (
          select source.id as source_instance_id,
                 source.provider_id,
                 source.active_revision_id as source_revision_id,
                 cursor.cursor_generation,
                 (
                   select min(run.created_at)
                   from public.import_runs run
                   where run.organization_id = source.organization_id
                     and run.provider_id = source.provider_id
                     and run.source_instance_id = source.id
                     and run.source_revision_id = source.active_revision_id
                     and run.cursor_generation = cursor.cursor_generation
                 ) as generation_started_at
          from public.provider_source_instances source
          join public.provider_sources provider
            on provider.organization_id = source.organization_id
           and provider.id = source.provider_id
           and provider.platform_key = ${PLATFORM_KEY}
          join public.provider_source_cursors cursor
            on cursor.organization_id = source.organization_id
           and cursor.provider_id = source.provider_id
           and cursor.source_instance_id = source.id
           and cursor.source_revision_id = source.active_revision_id
          where source.organization_id = ${organizationId}::uuid
        )
        select count(*)::bigint as count
        from public.operational_events event
        join current_source current on current.provider_id = event.provider_id
        left join public.import_runs run
          on run.organization_id = event.organization_id
         and run.id = event.run_id
        where event.organization_id = ${organizationId}::uuid
          and event.severity in ('warning', 'critical')
          and (
            (
              event.run_id is not null
              and run.cursor_generation = current.cursor_generation
              and (
                event.severity = 'critical'
                or run.state <> 'succeeded'
                or run.reached_provider_head is distinct from true
                or run.finished_at is null
                or run.failure_code is not null
                or run.source_instance_id is distinct from current.source_instance_id
                or run.source_revision_id is distinct from current.source_revision_id
              )
            )
            or (
              event.run_id is null
              and current.generation_started_at is not null
              and event.occurred_at >= current.generation_started_at
            )
          )
      `),
      transaction.provider_health_states.count({
        where: {
          organization_id: organizationId,
          OR: [
            { consecutive_failures: { gt: 0 } },
            { latest_failure_code: { not: null } },
            { mapping_warning_active: true },
            { calculation_warning_active: true },
          ],
        },
      }),
      transaction.provider_source_health_states.count({
        where: {
          organization_id: organizationId,
          OR: [
            { consecutive_failures: { gt: 0 } },
            { latest_failure_code: { not: null } },
          ],
        },
      }),
      transaction.source_connection_health_episodes.count({
        where: { organization_id: organizationId, closed_at: null },
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
        coveredCurrentPullCount: bigint;
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
                 select count(distinct pull.id)
                 from set_sizes set_size
                 join public.canonical_entities pull
                   on pull.organization_id = ${organizationId}::uuid
                  and pull.id = set_size.source_entity_id
                  and pull.record_kind = 'pull'
                  and pull.current_revision_id = set_size.source_canonical_revision_id
               )::bigint as "coveredCurrentPullCount",
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
        select: {
          settled_sequence: true,
          source_head_sequence: true,
          next_sequence: true,
          settled_at: true,
          source_head_at: true,
        },
      }),
      transaction.provider_catalog_checkpoints.findUnique({
        where: {
          organization_id_platform_key: {
            organization_id: organizationId,
            platform_key: PLATFORM_KEY,
          },
        },
        select: {
          settled_sequence: true,
          source_head_sequence: true,
          settled_at: true,
          source_head_at: true,
        },
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
      }>>(Prisma.sql`
        select collectible.external_id as "externalId",
               revision.content_json as content
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
      associationRead,
    ]);
    const assets = attachClutchpacksCatalogAssetAssociationEvidence(
      rawAssets,
      assetPackAssociations,
    );
    const source = sources[0];
    const sourceRevision = sourceRevisions[0];
    const currentCursorRun = currentCursorRuns[0];
    const entityCounts = counts[0];
    const confirmationCounts = confirmation[0];
    if (!entityCounts || !confirmationCounts) refuse("DATABASE_READ_FAILED");
    return Object.freeze({
      databaseIdentity,
      organizationCount,
      providerCount: providers.length,
      providerPlatformKey: providers[0]?.platform_key ?? null,
      providerState: providers[0]?.state ?? null,
      sourceCount: sources.length,
      sourceInstanceId: source?.id ?? null,
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
      currentCursorCount: currentCursorRuns.length,
      currentCursorSourceInstanceId:
        currentCursorRun?.sourceInstanceId ?? null,
      currentCursorSourceRevisionId:
        currentCursorRun?.sourceRevisionId ?? null,
      currentCursorGeneration: currentCursorRun?.cursorGeneration ?? null,
      latestRunCount: currentCursorRun?.runId === null ||
          currentCursorRun?.runId === undefined ? 0 : 1,
      latestRunId: currentCursorRun?.runId ?? null,
      latestRunState: currentCursorRun?.runState ?? null,
      latestRunReachedProviderHead:
        currentCursorRun?.runReachedProviderHead ?? null,
      latestRunFinished: currentCursorRun?.runFinishedAt !== null &&
        currentCursorRun?.runFinishedAt !== undefined,
      latestRunFailureCode: currentCursorRun?.runFailureCode ?? null,
      latestRunSourceInstanceId:
        currentCursorRun?.runSourceInstanceId ?? null,
      latestRunSourceRevisionId:
        currentCursorRun?.runSourceRevisionId ?? null,
      latestRunCursorGeneration:
        currentCursorRun?.runCursorGeneration ?? null,
      latestRunAdapterVersion:
        currentCursorRun?.runSourceAdapterVersion ?? null,
      latestRunNormalizedContractVersion:
        currentCursorRun?.runNormalizedContractVersion ?? null,
      latestRunMapperKey: currentCursorRun?.runMapperKey ?? null,
      latestRunMapperVersion: currentCursorRun?.runMapperVersion ?? null,
      latestRunIdentityNamespaceKey:
        currentCursorRun?.runIdentityNamespaceKey ?? null,
      latestRunCursorCodecVersion:
        currentCursorRun?.runCursorCodecVersion ?? null,
      activeRunCount,
      liveSupervisorCount: integer(liveSupervisors[0]?.count ?? 0n),
      deliveryCount,
      wrongDeliveryLineageCount,
      quarantineCount,
      unresolvedCurrentGenerationDiagnosticCount: integer(
        unresolvedCurrentGenerationDiagnostics[0]?.count ?? 0n,
      ),
      unresolvedCurrentGenerationOperationalEventCount: integer(
        unresolvedCurrentGenerationOperationalEvents[0]?.count ?? 0n,
      ),
      unresolvedProviderHealthCount,
      unresolvedSourceHealthCount,
      openConnectionHealthEpisodeCount,
      canonicalPackCount: integer(entityCounts.packCount),
      canonicalAssetCount: integer(entityCounts.assetCount),
      canonicalPullCount: integer(entityCounts.pullCount),
      canonicalMarketEventCount: integer(entityCounts.marketEventCount),
      confirmationSetCount: integer(confirmationCounts.confirmationSetCount),
      coveredCurrentPullCount:
        integer(confirmationCounts.coveredCurrentPullCount),
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
      globalSettledAt: globalWatermark?.settled_at ?? null,
      globalSourceHeadAt: globalWatermark?.source_head_at ?? null,
      providerSettledSequence: providerCheckpoint?.settled_sequence ?? null,
      providerSourceHeadSequence: providerCheckpoint?.source_head_sequence ?? null,
      providerSettledAt: providerCheckpoint?.settled_at ?? null,
      providerSourceHeadAt: providerCheckpoint?.source_head_at ?? null,
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
    timeout: CLUTCHPACKS_CATALOG_QUALIFICATION_TRANSACTION_TIMEOUT_MS,
  });
}

function candidateBinding(input: Readonly<{
  databaseTarget: string;
  databaseIdentity: ClutchpacksCatalogDatabaseIdentity;
  organizationId: string;
  outputPath: string;
  latestRunId: string;
  configurationHash: string;
}>): Readonly<{ digest: string; confirmation: string }> {
  const digest = createHash("sha256").update([
    CANDIDATE_DIGEST_DOMAIN,
    input.databaseTarget,
    ...connectedPostgresIdentityBindingParts(input.databaseIdentity),
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

async function readProductionDatabaseIdentity(
  databaseUrl: string,
): Promise<ClutchpacksCatalogDatabaseIdentity> {
  const lifecycle = createPrismaClientLifecycle({ databaseUrl });
  try {
    await lifecycle.start();
    return await readClutchpacksCatalogDatabaseIdentity(lifecycle.client);
  } finally {
    await lifecycle.close().catch(() => undefined);
  }
}

export async function runClutchpacksCatalogCandidate(input: Readonly<{
  argv: readonly string[];
  environment: NodeJS.ProcessEnv;
  readEvidence?: (
    databaseUrl: string,
    organizationId: string,
  ) => Promise<ClutchpacksCatalogQualificationEvidence>;
  readDatabaseIdentity?: (
    databaseUrl: string,
  ) => Promise<ClutchpacksCatalogDatabaseIdentity>;
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
      evidence = await readClutchpacksCatalogQualificationEvidence(
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
    databaseIdentity: evidence.databaseIdentity,
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
    databaseIdentity: evidence.databaseIdentity,
    organizationId: environment.organizationId,
    latestRunId: evidence.latestRunId,
    packCount: evidence.packs.length,
    collectibleMappingCount: configuration.collectibles.length,
    associatedCollectibleCount,
    unassociatedCollectibleCount: evidence.assets.length - associatedCollectibleCount,
    publicAssetOriginCount: configuration.publicAssetOrigins.length,
    observedPublicAssetOrigins: configuration.publicAssetOrigins,
    serializedBytes: Buffer.byteLength(serialized),
    configurationHash,
    candidateDigest: binding.digest,
    requiredConfirmation: binding.confirmation,
    outputPath: command.outputPath,
    written: command.execute,
  });
  if (command.execute) {
    if (command.confirmation !== binding.confirmation) refuse("CONFIRMATION_INVALID");
    try {
      const currentIdentity = await (
        input.readDatabaseIdentity ?? readProductionDatabaseIdentity
      )(environment.databaseUrl);
      assertSameConnectedPostgresIdentity(
        currentIdentity,
        evidence.databaseIdentity,
      );
    } catch (error) {
      if (error instanceof ClutchpacksCatalogCandidateError) throw error;
      return refuse("DATABASE_READ_FAILED");
    }
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
    --output /absolute/private/path/clutchpacks-v3-catalog.json

  npm run generate:catalog-candidate:clutchpacks:local -- \\
    --execute --output /absolute/private/path/clutchpacks-v3-catalog.json \\
    --confirmation "${CONFIRMATION_PREFIX} <16hex>"

Default mode is read-only. Both modes re-read and qualify the exact paused,
provider-head, adapter-v3 ClutchPacks target. Execute creates one new 0600 file
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

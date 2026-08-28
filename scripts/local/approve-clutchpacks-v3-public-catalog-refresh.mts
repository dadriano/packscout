#!/usr/bin/env node

import { createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  approvedPublicCatalogConfigurationV1Schema,
  canonicalJson,
  sha256CanonicalJson,
  type ApprovedPublicCatalogConfigurationV1,
  type ApprovedPublicCollectibleMapping,
} from "@packscout/contracts";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  PUBLIC_CATALOG_CONFIGURATION_HASH_DOMAIN,
  PrismaCatalogReleaseSourceRepository,
  createPrismaClientLifecycle,
  prismaApprovedPublicRepackIdentityMaterializer,
  type ApprovedPublicCatalogConfigurationPredecessor,
  type ApprovedPublicCatalogConfigurationSourcePrecondition,
  type PackscoutPrismaClient,
} from "@packscout/database";
import { Prisma } from "@prisma/client";
import {
  buildClutchpacksCatalogCandidate,
  clutchpacksAssetIsOmittablePublicShell,
  readClutchpacksCatalogDatabaseIdentity,
  readClutchpacksCatalogCandidateEnvironment,
  readClutchpacksCatalogQualificationEvidence,
  type ClutchpacksCatalogDatabaseIdentity,
  type ClutchpacksCatalogQualificationEvidence,
} from "./generate-clutchpacks-v3-public-catalog-candidate.mts";
import {
  assertSameConnectedPostgresIdentity,
  connectedPostgresIdentityBindingParts,
} from "./connected-postgres-identity.mjs";

const WORKFLOW = "approve_clutchpacks_v3_public_catalog_refresh" as const;
const PLATFORM_KEY = "clutchpacks" as const;
const CONFIRMATION_PREFIX = "APPROVE CLUTCHPACKS V3 CATALOG LOCAL" as const;
const SCOPE_DOMAIN = "packscout.clutchpacks-v3-catalog-refresh.v1" as const;
const APPROVAL_MAXIMUM_AGE_MS = 60 * 60 * 1_000;
const APPROVAL_FUTURE_TOLERANCE_MS = 30 * 1_000;

export type ClutchpacksCatalogRefreshErrorCode =
  | "ARGUMENT_INVALID"
  | "APPROVAL_TIME_INVALID"
  | "CONFIRMATION_INVALID"
  | "DATABASE_READ_FAILED"
  | "GROWTH_POLICY_VIOLATION"
  | "PERSISTENCE_FAILED"
  | "PREDECESSOR_INVALID"
  | "PROMOTION_WORK_ACTIVE"
  | "RESULT_INVALID";

export class ClutchpacksCatalogRefreshError extends Error {
  constructor(readonly code: ClutchpacksCatalogRefreshErrorCode) {
    super("The local ClutchPacks catalog refresh failed safely.");
    this.name = "ClutchpacksCatalogRefreshError";
  }
}

function refuse(code: ClutchpacksCatalogRefreshErrorCode): never {
  throw new ClutchpacksCatalogRefreshError(code);
}

export type ClutchpacksCatalogRefreshCommand = Readonly<{
  execute: boolean;
  approvedAt: string | null;
  confirmation: string | null;
}>;

export function parseClutchpacksCatalogRefreshCommand(
  argv: readonly string[],
): ClutchpacksCatalogRefreshCommand {
  const tokens = [...argv];
  let execute = false;
  let modeSeen = false;
  let approvedAt: string | null = null;
  let confirmation: string | null = null;
  while (tokens.length > 0) {
    const token = tokens.shift();
    if (token === "--dry-run" || token === "--execute") {
      if (modeSeen) refuse("ARGUMENT_INVALID");
      modeSeen = true;
      execute = token === "--execute";
    } else if (token === "--approved-at") {
      if (approvedAt !== null || !tokens[0]) refuse("ARGUMENT_INVALID");
      approvedAt = tokens.shift()!;
    } else if (token === "--confirmation") {
      if (confirmation !== null || !tokens[0]) refuse("ARGUMENT_INVALID");
      confirmation = tokens.shift()!;
    } else {
      refuse("ARGUMENT_INVALID");
    }
  }
  if ((execute && (approvedAt === null || confirmation === null)) ||
      (!execute && confirmation !== null)) {
    refuse("ARGUMENT_INVALID");
  }
  return Object.freeze({ execute, approvedAt, confirmation });
}

export interface ClutchpacksCatalogApprovalContext {
  readonly configurationCount: number;
  readonly latest: Readonly<{
    configuration: ApprovedPublicCatalogConfigurationV1;
    configurationHash: string;
    publicChangeSequence: bigint;
  }>;
  readonly activePromotionWorkCount: number;
}

export async function readClutchpacksCatalogApprovalContext(
  database: PackscoutPrismaClient,
  organizationId: string,
): Promise<ClutchpacksCatalogApprovalContext> {
  const result = await database.$transaction(async (transaction) => {
    await transaction.$executeRaw(Prisma.sql`set transaction read only`);
    const [configurationCount, rows, promotionRows] = await Promise.all([
      transaction.approved_public_catalog_configurations.count({
        where: { organization_id: organizationId },
      }),
      transaction.approved_public_catalog_configurations.findMany({
        where: { organization_id: organizationId },
        orderBy: [{ public_change_sequence: "desc" }, { revision: "desc" }],
        take: 1,
        select: {
          configuration_json: true,
          configuration_hash: true,
          public_change_sequence: true,
        },
      }),
      transaction.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        select (
          select count(*)
          from public.provider_promotion_attempts
          where organization_id = ${organizationId}::uuid
            and state in ('assembling', 'ready', 'in_progress', 'retry_wait')
        ) + (
          select count(*)
          from public.manifest_promotion_attempts
          where organization_id = ${organizationId}::uuid
            and state in ('assembling', 'ready', 'in_progress', 'retry_wait')
        ) as count
      `),
    ]);
    return { configurationCount, row: rows[0], promotionRows };
  }, {
    ...PACKSCOUT_TRANSACTION_OPTIONS,
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  });
  const parsed = approvedPublicCatalogConfigurationV1Schema.safeParse(
    result.row?.configuration_json,
  );
  if (!parsed.success || !result.row || result.configurationCount < 1) {
    refuse("PREDECESSOR_INVALID");
  }
  const recomputedHash = await sha256CanonicalJson(
    PUBLIC_CATALOG_CONFIGURATION_HASH_DOMAIN,
    parsed.data,
  );
  if (recomputedHash !== result.row.configuration_hash) {
    refuse("PREDECESSOR_INVALID");
  }
  const activePromotionWorkCount = Number(result.promotionRows[0]?.count ?? 0n);
  if (!Number.isSafeInteger(activePromotionWorkCount) ||
      activePromotionWorkCount < 0) {
    refuse("DATABASE_READ_FAILED");
  }
  return Object.freeze({
    configurationCount: result.configurationCount,
    latest: Object.freeze({
      configuration: parsed.data,
      configurationHash: recomputedHash,
      publicChangeSequence: result.row.public_change_sequence,
    }),
    activePromotionWorkCount,
  });
}

function nextConfigurationKey(previous: ApprovedPublicCatalogConfigurationV1): string {
  const match = /^(.*)-v([1-9][0-9]*)$/u.exec(previous.configurationKey);
  if (!match || Number(match[2]) !== previous.revision) {
    return refuse("PREDECESSOR_INVALID");
  }
  const key = `${match[1]}-v${previous.revision + 1}`;
  if (key.length > 128) refuse("PREDECESSOR_INVALID");
  return key;
}

function exactValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function assertStableSubset<T>(
  previous: readonly T[],
  candidate: readonly T[],
  key: (value: T) => string,
): void {
  const candidateByKey = new Map(candidate.map((value) => [key(value), value]));
  if (candidateByKey.size !== candidate.length ||
      previous.some((value) =>
        !candidateByKey.has(key(value)) ||
        !exactValue(value, candidateByKey.get(key(value))))) {
    refuse("GROWTH_POLICY_VIOLATION");
  }
}

const COLLECTIBLE_ENRICHABLE_SCALAR_KEYS = [
  "year",
  "brand",
  "setOrSeries",
  "cardNumber",
  "referenceNumber",
  "subject",
  "grade",
  "grader",
  "probabilityBucketId",
] as const satisfies readonly (keyof ApprovedPublicCollectibleMapping)[];

function retainsEvery(
  previous: readonly string[],
  candidate: readonly string[],
): boolean {
  const candidateValues = new Set(candidate);
  return previous.every((value) => candidateValues.has(value));
}

function collectibleEnrichmentIsMonotonic(
  previous: ApprovedPublicCollectibleMapping,
  candidate: ApprovedPublicCollectibleMapping,
): boolean {
  return previous.platformKey === candidate.platformKey &&
    previous.externalId === candidate.externalId &&
    previous.publicCollectibleId === candidate.publicCollectibleId &&
    previous.collectibleType === candidate.collectibleType &&
    COLLECTIBLE_ENRICHABLE_SCALAR_KEYS.every((key) =>
      previous[key] === null || candidate[key] === previous[key]) &&
    retainsEvery(previous.aliases, candidate.aliases) &&
    retainsEvery(previous.publicCategoryIds, candidate.publicCategoryIds) &&
    retainsEvery(previous.chaseEvidenceKinds, candidate.chaseEvidenceKinds) &&
    candidate.matchConfidenceBasisPoints >=
      previous.matchConfidenceBasisPoints;
}

function assertCollectibleEnrichment(
  previous: readonly ApprovedPublicCollectibleMapping[],
  candidate: readonly ApprovedPublicCollectibleMapping[],
  removableKeys: ReadonlySet<string>,
): void {
  const key = ({ platformKey, externalId }: ApprovedPublicCollectibleMapping) =>
    `${platformKey}\0${externalId}`;
  const candidateByKey = new Map(candidate.map((value) => [key(value), value]));
  if (candidateByKey.size !== candidate.length || previous.some((value) => {
    const next = candidateByKey.get(key(value));
    return next === undefined
      ? !removableKeys.has(key(value))
      : !collectibleEnrichmentIsMonotonic(value, next);
  })) {
    refuse("GROWTH_POLICY_VIOLATION");
  }
}

export function assertClutchpacksCatalogGrowthOnly(
  previous: ApprovedPublicCatalogConfigurationV1,
  candidate: ApprovedPublicCatalogConfigurationV1,
  evidence?: ClutchpacksCatalogQualificationEvidence,
): void {
  const previousPlatform = previous.platforms[0];
  const candidatePlatform = candidate.platforms[0];
  if (
    previous.platforms.length !== 1 || candidate.platforms.length !== 1 ||
    previousPlatform?.platformKey !== PLATFORM_KEY ||
    candidatePlatform?.platformKey !== PLATFORM_KEY ||
    previous.schemaVersion !== candidate.schemaVersion ||
    previous.staleAfterSeconds !== candidate.staleAfterSeconds ||
    !exactValue(previous.confidencePolicy, candidate.confidencePolicy) ||
    !exactValue(previous.verifiedUsdStablecoins, candidate.verifiedUsdStablecoins) ||
    previousPlatform.format !== candidatePlatform.format ||
    !exactValue(previousPlatform.defaultPublicCategoryIds,
      candidatePlatform.defaultPublicCategoryIds) ||
    !exactValue(previousPlatform.collectibleTypeMappings,
      candidatePlatform.collectibleTypeMappings)
  ) {
    refuse("GROWTH_POLICY_VIOLATION");
  }
  const { imageOrigins: previousImageOrigins, ...previousVendor } =
    previousPlatform.vendor;
  const { imageOrigins: candidateImageOrigins, ...candidateVendor } =
    candidatePlatform.vendor;
  if (!exactValue(previousVendor, candidateVendor)) {
    refuse("GROWTH_POLICY_VIOLATION");
  }
  if (
    !exactValue(previous.publicAssetOrigins, previousImageOrigins) ||
    !exactValue(candidate.publicAssetOrigins, candidateImageOrigins)
  ) {
    refuse("GROWTH_POLICY_VIOLATION");
  }
  assertStableSubset(previous.categories, candidate.categories,
    ({ publicCategoryId }) => publicCategoryId);
  assertStableSubset(previousPlatform.categoryMappings,
    candidatePlatform.categoryMappings, ({ sourceValue }) => sourceValue);
  assertStableSubset(previous.repacks, candidate.repacks,
    ({ platformKey, packExternalId }) => `${platformKey}\0${packExternalId}`);
  const removableKeys = new Set((evidence?.assets ?? [])
    .filter(clutchpacksAssetIsOmittablePublicShell)
    .map(({ externalId }) => `${PLATFORM_KEY}\0${externalId}`));
  // Immutable identity normally grows monotonically. The sole removal case is
  // a previously mapped source shell whose exact current, settled evidence is
  // both unassociated and unable to satisfy the public name contract. The
  // caller binds this candidate hash and evidence watermark into confirmation,
  // then the persistence transaction rechecks the source and predecessor CAS.
  assertCollectibleEnrichment(
    previous.collectibles,
    candidate.collectibles,
    removableKeys,
  );
}

function assertBaselineEnvironment(
  previous: ApprovedPublicCatalogConfigurationV1,
  policy: ReturnType<typeof readClutchpacksCatalogCandidateEnvironment>["policy"],
): void {
  const platform = previous.platforms[0];
  if (
    previous.configurationKey !== policy.configurationKey ||
    previous.revision !== policy.revision ||
    previous.approvedAt !== policy.approvedAt ||
    previous.staleAfterSeconds !== policy.staleAfterSeconds ||
    !exactValue(previous.confidencePolicy, {
      version: policy.confidencePolicyVersion,
      completeScoreBasisPoints: policy.completeScoreBasisPoints,
      partialScoreBasisPoints: policy.partialScoreBasisPoints,
      unknownScoreBasisPoints: policy.unknownScoreBasisPoints,
      limitationPenaltyBasisPoints: policy.limitationPenaltyBasisPoints,
    }) ||
    platform?.vendor.displayName !== policy.vendorDisplayName ||
    platform.format !== policy.format
  ) {
    refuse("PREDECESSOR_INVALID");
  }
}

function approvalTime(
  supplied: string | null,
  now: Date,
  evidence: ClutchpacksCatalogQualificationEvidence,
  previous: ApprovedPublicCatalogConfigurationV1,
): string {
  const value = supplied ?? now.toISOString();
  const parsed = new Date(value);
  const settledAt = evidence.globalSettledAt;
  if (
    !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value ||
    settledAt === null ||
    parsed.getTime() <= settledAt.getTime() ||
    parsed.getTime() <= new Date(previous.approvedAt).getTime() ||
    parsed.getTime() < now.getTime() - APPROVAL_MAXIMUM_AGE_MS ||
    parsed.getTime() > now.getTime() + APPROVAL_FUTURE_TOLERANCE_MS
  ) {
    refuse("APPROVAL_TIME_INVALID");
  }
  return value;
}

function confirmationMatches(actual: string | null, expected: string): boolean {
  if (actual === null) return false;
  const left = Buffer.from(actual, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function refreshBinding(input: Readonly<{
  databaseTarget: string;
  databaseIdentity: ClutchpacksCatalogDatabaseIdentity;
  organizationId: string;
  latestRunId: string;
  cursorGeneration: bigint;
  settledSequence: bigint;
  previous: ApprovedPublicCatalogConfigurationPredecessor;
  candidateHash: string;
}>): Readonly<{ digest: string; confirmation: string }> {
  const digest = createHash("sha256").update([
    SCOPE_DOMAIN,
    input.databaseTarget,
    ...connectedPostgresIdentityBindingParts(input.databaseIdentity),
    input.organizationId,
    input.latestRunId,
    input.cursorGeneration.toString(),
    input.settledSequence.toString(),
    input.previous.configurationKey,
    String(input.previous.revision),
    input.previous.configurationHash,
    input.previous.publicChangeSequence.toString(),
    input.candidateHash,
  ].join("\n")).digest("hex");
  return Object.freeze({
    digest,
    confirmation: `${CONFIRMATION_PREFIX} ${digest.slice(0, 16)}`,
  });
}

type RefreshState = Readonly<{
  evidence: ClutchpacksCatalogQualificationEvidence;
  context: ClutchpacksCatalogApprovalContext;
}>;

async function readProductionState(
  databaseUrl: string,
  organizationId: string,
): Promise<RefreshState> {
  const lifecycle = createPrismaClientLifecycle({ databaseUrl });
  try {
    await lifecycle.start();
    const [evidence, context] = await Promise.all([
      readClutchpacksCatalogQualificationEvidence(
        lifecycle.client, organizationId,
      ),
      readClutchpacksCatalogApprovalContext(lifecycle.client, organizationId),
    ]);
    return Object.freeze({ evidence, context });
  } finally {
    await lifecycle.close().catch(() => undefined);
  }
}

async function approveProductionConfiguration(input: Readonly<{
  databaseUrl: string;
  expectedDatabaseIdentity: ClutchpacksCatalogDatabaseIdentity;
  organizationId: string;
  configuration: ApprovedPublicCatalogConfigurationV1;
  expectedPrevious: ApprovedPublicCatalogConfigurationPredecessor;
  expectedSource: ApprovedPublicCatalogConfigurationSourcePrecondition;
}>) {
  const lifecycle = createPrismaClientLifecycle({ databaseUrl: input.databaseUrl });
  try {
    await lifecycle.start();
    assertSameConnectedPostgresIdentity(
      await readClutchpacksCatalogDatabaseIdentity(lifecycle.client),
      input.expectedDatabaseIdentity,
    );
    return await new PrismaCatalogReleaseSourceRepository(
      lifecycle.client,
      input.organizationId,
    ).approveConfiguration(
      input.configuration,
      prismaApprovedPublicRepackIdentityMaterializer,
      {
        expectedPrevious: input.expectedPrevious,
        expectedSource: input.expectedSource,
      },
    );
  } finally {
    await lifecycle.close().catch(() => undefined);
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

export async function runClutchpacksCatalogRefresh(input: Readonly<{
  argv: readonly string[];
  environment: NodeJS.ProcessEnv;
  clock?: () => Date;
  readState?: (databaseUrl: string, organizationId: string) => Promise<RefreshState>;
  readDatabaseIdentity?: (
    databaseUrl: string,
  ) => Promise<ClutchpacksCatalogDatabaseIdentity>;
  approveConfiguration?: typeof approveProductionConfiguration;
  writeOutput?: (value: string) => void;
}>): Promise<unknown> {
  const command = parseClutchpacksCatalogRefreshCommand(input.argv);
  const environment = readClutchpacksCatalogCandidateEnvironment(input.environment);
  let state: RefreshState;
  try {
    state = await (input.readState ?? readProductionState)(
      environment.databaseUrl,
      environment.organizationId,
    );
  } catch (error) {
    if (error instanceof ClutchpacksCatalogRefreshError) throw error;
    return refuse("DATABASE_READ_FAILED");
  }
  if (state.context.activePromotionWorkCount !== 0) {
    refuse("PROMOTION_WORK_ACTIVE");
  }
  const previous = state.context.latest.configuration;
  assertBaselineEnvironment(previous, environment.policy);
  const approvedAt = approvalTime(
    command.approvedAt,
    (input.clock ?? (() => new Date()))(),
    state.evidence,
    previous,
  );
  const candidate = buildClutchpacksCatalogCandidate(state.evidence, {
    ...environment.policy,
    configurationKey: nextConfigurationKey(previous),
    revision: previous.revision + 1,
    approvedAt,
  });
  assertClutchpacksCatalogGrowthOnly(previous, candidate, state.evidence);
  const candidateHash = await sha256CanonicalJson(
    PUBLIC_CATALOG_CONFIGURATION_HASH_DOMAIN,
    candidate,
  );
  const expectedPrevious = Object.freeze({
    configurationKey: previous.configurationKey,
    revision: previous.revision,
    configurationHash: state.context.latest.configurationHash,
    publicChangeSequence: state.context.latest.publicChangeSequence,
  });
  const settledSequence = state.evidence.globalSettledSequence;
  const sourceHeadSequence = state.evidence.globalSourceHeadSequence;
  const nextSequence = state.evidence.globalNextSequence;
  const providerSettledSequence = state.evidence.providerSettledSequence;
  const providerSourceHeadSequence =
    state.evidence.providerSourceHeadSequence;
  const sourceInstanceId = state.evidence.sourceInstanceId;
  const sourceRevisionId = state.evidence.sourceRevisionId;
  const latestRunId = state.evidence.latestRunId;
  const cursorGeneration = state.evidence.currentCursorGeneration;
  if (
    settledSequence === null || sourceHeadSequence === null ||
    nextSequence === null || providerSettledSequence === null ||
    providerSourceHeadSequence === null || sourceInstanceId === null ||
    sourceRevisionId === null || latestRunId === null ||
    cursorGeneration === null
  ) {
    refuse("DATABASE_READ_FAILED");
  }
  const expectedSource = Object.freeze({
    platformKey: PLATFORM_KEY,
    sourceInstanceId,
    sourceRevisionId,
    cursorGeneration,
    latestRunId,
    settledSequence,
    sourceHeadSequence,
    nextSequence,
    providerSettledSequence,
    providerSourceHeadSequence,
  });
  const binding = refreshBinding({
    databaseTarget: environment.databaseTarget,
    databaseIdentity: state.evidence.databaseIdentity,
    organizationId: environment.organizationId,
    latestRunId,
    cursorGeneration,
    settledSequence,
    previous: expectedPrevious,
    candidateHash,
  });
  if (command.execute &&
      !confirmationMatches(command.confirmation, binding.confirmation)) {
    refuse("CONFIRMATION_INVALID");
  }
  let publicChangeSequence: bigint | null = null;
  if (command.execute) {
    try {
      assertSameConnectedPostgresIdentity(
        await (
          input.readDatabaseIdentity ?? readProductionDatabaseIdentity
        )(environment.databaseUrl),
        state.evidence.databaseIdentity,
      );
      const approved = await (
        input.approveConfiguration ?? approveProductionConfiguration
      )({
        databaseUrl: environment.databaseUrl,
        expectedDatabaseIdentity: state.evidence.databaseIdentity,
        organizationId: environment.organizationId,
        configuration: candidate,
        expectedPrevious,
        expectedSource,
      });
      if (approved.configurationHash !== candidateHash ||
          approved.configuration.configurationKey !== candidate.configurationKey ||
          approved.configuration.revision !== candidate.revision ||
          approved.publicChangeSequence <= expectedPrevious.publicChangeSequence) {
        refuse("RESULT_INVALID");
      }
      publicChangeSequence = approved.publicChangeSequence;
    } catch (error) {
      if (error instanceof ClutchpacksCatalogRefreshError) throw error;
      return refuse("PERSISTENCE_FAILED");
    }
  }
  const summary = Object.freeze({
    ok: true,
    operation: WORKFLOW,
    mode: command.execute ? "execute" : "dry_run",
    targetDatabase: "packscout_clutchpacks_v3_canary",
    databaseIdentity: state.evidence.databaseIdentity,
    organizationId: environment.organizationId,
    latestRunId,
    cursorGeneration: cursorGeneration.toString(),
    settledSequence: settledSequence.toString(),
    previousConfigurationKey: previous.configurationKey,
    previousRevision: previous.revision,
    configurationKey: candidate.configurationKey,
    revision: candidate.revision,
    approvedAt: candidate.approvedAt,
    repackCount: candidate.repacks.length,
    collectibleMappingCount: candidate.collectibles.length,
    addedRepackCount: candidate.repacks.length - previous.repacks.length,
    addedCollectibleMappingCount: candidate.collectibles.filter((mapping) =>
      !previous.collectibles.some((previousMapping) =>
        previousMapping.platformKey === mapping.platformKey &&
        previousMapping.externalId === mapping.externalId)).length,
    removedCollectibleMappingCount: previous.collectibles.filter((mapping) =>
      !candidate.collectibles.some((candidateMapping) =>
        candidateMapping.platformKey === mapping.platformKey &&
        candidateMapping.externalId === mapping.externalId)).length,
    addedPublicAssetOrigins: candidate.publicAssetOrigins.filter((origin) =>
      !previous.publicAssetOrigins.includes(origin)),
    removedPublicAssetOrigins: previous.publicAssetOrigins.filter((origin) =>
      !candidate.publicAssetOrigins.includes(origin)),
    configurationHash: candidateHash,
    scopeDigest: binding.digest,
    requiredConfirmation: command.execute ? null : binding.confirmation,
    publicChangeSequence: publicChangeSequence?.toString() ?? null,
  });
  (input.writeOutput ?? ((value) => process.stdout.write(`${value}\n`)))(
    JSON.stringify(summary),
  );
  return summary;
}

export function clutchpacksCatalogRefreshUsage(): string {
  return `Usage:
  npm run approve:catalog-refresh:clutchpacks:local -- --dry-run

  npm run approve:catalog-refresh:clutchpacks:local -- \\
    --execute --approved-at <dry-run-approvedAt> \\
    --confirmation "${CONFIRMATION_PREFIX} <16hex>"

Dry-run derives the next immutable configuration key and revision from the
current approved local canary configuration. Execute requires the exact
approvedAt and target/snapshot/configuration-bound confirmation emitted by a
dry-run. Both modes require the exact local canary to be paused, drained, at
provider head, causally settled, healthy, and free of active promotion work.`;
}

if (process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).includes("--help")) {
    process.stdout.write(`${clutchpacksCatalogRefreshUsage()}\n`);
  } else {
    runClutchpacksCatalogRefresh({
      argv: process.argv.slice(2),
      environment: process.env,
    }).catch((error: unknown) => {
      process.stderr.write(`${JSON.stringify({
        ok: false,
        operation: WORKFLOW,
        code: error instanceof ClutchpacksCatalogRefreshError
          ? error.code
          : "UNEXPECTED_FAILURE",
      })}\n`);
      process.exitCode = 1;
    });
  }
}

#!/usr/bin/env node

import { createHash, timingSafeEqual } from "node:crypto";
import { open } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MAXIMUM_CONFIGURATION_BYTES = 16 * 1024 * 1024;
const CLUTCHPACKS_PLATFORM_KEY = "clutchpacks";
const CONFIRMATION_PREFIX = "APPROVE CLUTCHPACKS PREPRODUCTION";
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEPLOYMENT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;
const PRODUCTION_TOKEN_PATTERN =
  /(?:^|[./:_-])(?:prod|production|live)(?=$|[./:_-])/iu;

const ERROR_MESSAGES = Object.freeze({
  CATALOG_APPROVAL_ARGUMENT_INVALID:
    "Approved catalog configuration arguments are invalid.",
  CATALOG_APPROVAL_CONFIGURATION_FILE_INVALID:
    "The approved catalog configuration file could not be read safely.",
  CATALOG_APPROVAL_CONFIGURATION_INVALID:
    "The approved catalog configuration is invalid.",
  CATALOG_APPROVAL_CONFIRMATION_MISMATCH:
    "The target-bound approval confirmation does not match.",
  CATALOG_APPROVAL_CONFIRMATION_REQUIRED:
    "The target-bound approval confirmation is required for execution.",
  CATALOG_APPROVAL_DATABASE_TARGET_INVALID:
    "The preproduction database target is invalid.",
  CATALOG_APPROVAL_DATABASE_PREFLIGHT_FAILED:
    "The preproduction database did not pass the catalog approval preflight.",
  CATALOG_APPROVAL_DEPLOYMENT_INVALID:
    "The preproduction catalog deployment binding is invalid.",
  CATALOG_APPROVAL_ENVIRONMENT_FORBIDDEN:
    "Catalog configuration approval is restricted to preproduction.",
  CATALOG_APPROVAL_INTERNAL_FAILURE:
    "The approved catalog configuration command failed safely.",
  CATALOG_APPROVAL_ORGANIZATION_INVALID:
    "The public organization binding is invalid.",
  CATALOG_APPROVAL_ORGANIZATION_NOT_FOUND:
    "The public organization binding was not found in the preproduction database.",
  CATALOG_APPROVAL_MAPPING_COVERAGE_MISMATCH:
    "The ClutchPacks configuration does not exactly cover the current canonical catalog.",
  CATALOG_APPROVAL_PERSISTENCE_FAILED:
    "The approved catalog configuration was not persisted.",
  CATALOG_APPROVAL_PLATFORM_FORBIDDEN:
    "The ClutchPacks canary configuration may contain only clutchpacks.",
  CATALOG_APPROVAL_PLATFORM_UNREGISTERED:
    "The ClutchPacks platform is not registered for the public organization.",
  CATALOG_APPROVAL_PUBLIC_PROJECTION_NOT_READY:
    "The current ClutchPacks catalog is not ready for public projection.",
  CATALOG_APPROVAL_PROMOTION_RECOVERY_REQUIRED:
    "Existing promotion work must be reconciled before changing the configuration.",
  CATALOG_APPROVAL_RESULT_INVALID:
    "The approved catalog configuration receipt is invalid.",
  CATALOG_APPROVAL_SOURCE_NOT_READY:
    "ClutchPacks is not registered with exactly one current V1 source.",
});

const PERSISTENCE_ERROR_CODES = Object.freeze({
  PUBLIC_CONFIGURATION_INVALID: "CATALOG_APPROVAL_PERSISTENCE_FAILED",
  PUBLIC_CONFIGURATION_PLATFORM_LIMIT_EXCEEDED:
    "CATALOG_APPROVAL_PERSISTENCE_FAILED",
  PUBLIC_CONFIGURATION_PLATFORM_UNREGISTERED:
    "CATALOG_APPROVAL_PLATFORM_UNREGISTERED",
  PUBLIC_CONFIGURATION_PROMOTION_RECOVERY_REQUIRED:
    "CATALOG_APPROVAL_PROMOTION_RECOVERY_REQUIRED",
});

export class ClutchpacksCatalogApprovalError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code] ?? ERROR_MESSAGES.CATALOG_APPROVAL_INTERNAL_FAILURE);
    this.name = "ClutchpacksCatalogApprovalError";
    this.code = ERROR_MESSAGES[code]
      ? code
      : "CATALOG_APPROVAL_INTERNAL_FAILURE";
  }
}

function refuse(code) {
  throw new ClutchpacksCatalogApprovalError(code);
}

function requiredEnvironmentValue(environment, name, code) {
  const value = environment[name]?.trim();
  if (!value) refuse(code);
  return value;
}

function sha256(...parts) {
  const hash = createHash("sha256");
  for (const part of parts) {
    const value = String(part);
    hash.update(String(Buffer.byteLength(value, "utf8")));
    hash.update(":");
    hash.update(value);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function computeCatalogApprovalDatabaseTargetDigest(databaseUrl) {
  if (
    typeof databaseUrl !== "string" ||
    databaseUrl.length === 0 ||
    databaseUrl.length > 2_048 ||
    /[\r\n]/u.test(databaseUrl)
  ) {
    return refuse("CATALOG_APPROVAL_DATABASE_TARGET_INVALID");
  }
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return refuse("CATALOG_APPROVAL_DATABASE_TARGET_INVALID");
  }
  if (
    !new Set(["postgres:", "postgresql:"]).has(parsed.protocol) ||
    !parsed.hostname ||
    !parsed.username ||
    parsed.pathname.length <= 1 ||
    parsed.hash
  ) {
    return refuse("CATALOG_APPROVAL_DATABASE_TARGET_INVALID");
  }

  const target = new URL(parsed.href);
  target.password = "";
  target.hostname = target.hostname.toLowerCase();
  return sha256("packscout-clutchpacks-catalog-database-target-v1", target.href);
}

export function computeCatalogApprovalScopeDigest({
  organizationId,
  deploymentKey,
  databaseTargetDigest,
  configurationHash,
}) {
  if (
    !UUID_PATTERN.test(organizationId) ||
    !DEPLOYMENT_KEY_PATTERN.test(deploymentKey) ||
    !SHA256_PATTERN.test(databaseTargetDigest) ||
    !SHA256_PATTERN.test(configurationHash)
  ) {
    return refuse("CATALOG_APPROVAL_INTERNAL_FAILURE");
  }
  return sha256(
    "packscout-clutchpacks-catalog-approval-scope-v1",
    organizationId.toLowerCase(),
    deploymentKey,
    databaseTargetDigest,
    configurationHash,
  );
}

export function buildCatalogApprovalConfirmation(scopeDigest) {
  if (!SHA256_PATTERN.test(scopeDigest)) {
    return refuse("CATALOG_APPROVAL_INTERNAL_FAILURE");
  }
  return `${CONFIRMATION_PREFIX} ${scopeDigest.slice(0, 16)}`;
}

function exactConfirmationMatches(actual, expected) {
  if (typeof actual !== "string") return false;
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes);
}

export function parseClutchpacksCatalogApprovalCommand({ argv, environment }) {
  let mode = null;
  let configurationFile = null;
  let confirmation = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run" || argument === "--execute") {
      if (mode !== null) refuse("CATALOG_APPROVAL_ARGUMENT_INVALID");
      mode = argument;
      continue;
    }
    if (argument === "--confirmation") {
      if (confirmation !== null) refuse("CATALOG_APPROVAL_ARGUMENT_INVALID");
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        refuse("CATALOG_APPROVAL_ARGUMENT_INVALID");
      }
      confirmation = value;
      index += 1;
      continue;
    }
    if (!argument || argument.startsWith("--") || configurationFile !== null) {
      refuse("CATALOG_APPROVAL_ARGUMENT_INVALID");
    }
    configurationFile = argument;
  }

  if (!configurationFile || !path.isAbsolute(configurationFile)) {
    refuse("CATALOG_APPROVAL_ARGUMENT_INVALID");
  }
  const dryRun = mode !== "--execute";
  if (dryRun && confirmation !== null) {
    refuse("CATALOG_APPROVAL_ARGUMENT_INVALID");
  }
  if (!dryRun && confirmation === null) {
    refuse("CATALOG_APPROVAL_CONFIRMATION_REQUIRED");
  }

  if (environment.PACKSCOUT_RUNTIME_ENVIRONMENT?.trim() !== "preproduction") {
    refuse("CATALOG_APPROVAL_ENVIRONMENT_FORBIDDEN");
  }
  const organizationId = requiredEnvironmentValue(
    environment,
    "PACKSCOUT_PUBLIC_ORGANIZATION_ID",
    "CATALOG_APPROVAL_ORGANIZATION_INVALID",
  ).toLowerCase();
  if (!UUID_PATTERN.test(organizationId)) {
    refuse("CATALOG_APPROVAL_ORGANIZATION_INVALID");
  }
  const deploymentKey = requiredEnvironmentValue(
    environment,
    "PACKSCOUT_CATALOG_DEPLOYMENT_KEY",
    "CATALOG_APPROVAL_DEPLOYMENT_INVALID",
  );
  if (
    !DEPLOYMENT_KEY_PATTERN.test(deploymentKey) ||
    PRODUCTION_TOKEN_PATTERN.test(deploymentKey)
  ) {
    refuse("CATALOG_APPROVAL_DEPLOYMENT_INVALID");
  }
  const databaseUrl = requiredEnvironmentValue(
    environment,
    "PACKSCOUT_DATABASE_URL",
    "CATALOG_APPROVAL_DATABASE_TARGET_INVALID",
  );
  const databaseTargetDigest = computeCatalogApprovalDatabaseTargetDigest(
    databaseUrl,
  );

  return Object.freeze({
    confirmation,
    configurationFile: path.resolve(configurationFile),
    databaseTargetDigest,
    databaseUrl,
    deploymentKey,
    dryRun,
    organizationId,
  });
}

async function readConfigurationFile(configurationFile) {
  let handle;
  try {
    handle = await open(configurationFile, "r");
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size <= 0 ||
      metadata.size > MAXIMUM_CONFIGURATION_BYTES
    ) {
      refuse("CATALOG_APPROVAL_CONFIGURATION_FILE_INVALID");
    }
    const body = await handle.readFile({ encoding: "utf8" });
    if (Buffer.byteLength(body, "utf8") > MAXIMUM_CONFIGURATION_BYTES) {
      refuse("CATALOG_APPROVAL_CONFIGURATION_FILE_INVALID");
    }
    return JSON.parse(body);
  } catch (error) {
    if (error instanceof ClutchpacksCatalogApprovalError) throw error;
    return refuse("CATALOG_APPROVAL_CONFIGURATION_FILE_INVALID");
  } finally {
    try {
      await handle?.close();
    } catch {
      // Reading and validation do not become unsafe because descriptor cleanup
      // failed. No database connection exists in this path.
    }
  }
}

function assertClutchpacksOnly(configuration) {
  if (
    configuration.platforms.length !== 1 ||
    configuration.platforms[0]?.platformKey !== CLUTCHPACKS_PLATFORM_KEY ||
    configuration.repacks.some(
      ({ platformKey }) => platformKey !== CLUTCHPACKS_PLATFORM_KEY,
    ) ||
    configuration.collectibles.some(
      ({ platformKey }) => platformKey !== CLUTCHPACKS_PLATFORM_KEY,
    )
  ) {
    refuse("CATALOG_APPROVAL_PLATFORM_FORBIDDEN");
  }
}

const PREFLIGHT_COUNT_KEYS = Object.freeze([
  "organizationCount",
  "registeredProviderCount",
  "currentV1SourceCount",
  "canonicalPackCount",
  "configuredRepackCount",
  "unconfiguredCanonicalPackCount",
  "unmatchedConfiguredRepackCount",
  "canonicalCollectibleCount",
  "associatedCanonicalCollectibleCount",
  "unnamedAssociatedCanonicalCollectibleCount",
  "configuredCollectibleCount",
  "unconfiguredCanonicalCollectibleCount",
  "unmatchedConfiguredCollectibleCount",
]);

function validatedPreflight(configuration, value) {
  if (
    value === null ||
    typeof value !== "object" ||
    value.migrationReady !== true ||
    value.readOnly !== true ||
    PREFLIGHT_COUNT_KEYS.some(
      (key) => !Number.isInteger(value[key]) || value[key] < 0,
    )
  ) {
    refuse("CATALOG_APPROVAL_DATABASE_PREFLIGHT_FAILED");
  }
  if (value.organizationCount !== 1) {
    refuse("CATALOG_APPROVAL_ORGANIZATION_NOT_FOUND");
  }
  if (
    value.registeredProviderCount !== 1 ||
    value.currentV1SourceCount !== 1
  ) {
    refuse("CATALOG_APPROVAL_SOURCE_NOT_READY");
  }
  if (
    value.associatedCanonicalCollectibleCount >
      value.canonicalCollectibleCount ||
    value.unnamedAssociatedCanonicalCollectibleCount >
      value.associatedCanonicalCollectibleCount
  ) {
    refuse("CATALOG_APPROVAL_DATABASE_PREFLIGHT_FAILED");
  }
  if (
    value.configuredRepackCount !== configuration.repacks.length ||
    value.configuredCollectibleCount !== configuration.collectibles.length ||
    value.unconfiguredCanonicalPackCount !== 0 ||
    value.unmatchedConfiguredRepackCount !== 0 ||
    value.unconfiguredCanonicalCollectibleCount !== 0 ||
    value.unmatchedConfiguredCollectibleCount !== 0
  ) {
    refuse("CATALOG_APPROVAL_MAPPING_COVERAGE_MISMATCH");
  }
  if (value.unnamedAssociatedCanonicalCollectibleCount !== 0) {
    refuse("CATALOG_APPROVAL_PUBLIC_PROJECTION_NOT_READY");
  }
  return Object.freeze({
    migrationReady: true,
    readOnly: true,
    counts: Object.freeze({
      organizations: value.organizationCount,
      registeredProviders: value.registeredProviderCount,
      currentV1Sources: value.currentV1SourceCount,
      canonicalPacks: value.canonicalPackCount,
      configuredRepacks: value.configuredRepackCount,
      canonicalCollectibles: value.canonicalCollectibleCount,
      associatedCanonicalCollectibles:
        value.associatedCanonicalCollectibleCount,
      unnamedAssociatedCanonicalCollectibles:
        value.unnamedAssociatedCanonicalCollectibleCount,
      configuredCollectibles: value.configuredCollectibleCount,
    }),
  });
}

function planSummary(plan) {
  return Object.freeze({
    schemaVersion: "packscout.clutchpacks-catalog-approval-plan.v1",
    status: "dry_run",
    environment: "preproduction",
    platformKeys: Object.freeze([CLUTCHPACKS_PLATFORM_KEY]),
    revision: plan.configuration.revision,
    counts: Object.freeze({
      categories: plan.configuration.categories.length,
      collectibles: plan.configuration.collectibles.length,
      repacks: plan.configuration.repacks.length,
    }),
    configurationSha256: plan.configurationHash,
    databaseTargetSha256: plan.command.databaseTargetDigest,
    targetScopeSha256: plan.scopeDigest,
    executeConfirmation: plan.confirmation,
    preflight: plan.preflight,
  });
}

function approvalSummary(plan, approved) {
  if (
    approved?.configurationHash !== plan.configurationHash ||
    typeof approved.publicChangeSequence !== "bigint" ||
    approved.publicChangeSequence <= 0n
  ) {
    refuse("CATALOG_APPROVAL_RESULT_INVALID");
  }
  return Object.freeze({
    schemaVersion: "packscout.clutchpacks-catalog-approval-result.v1",
    status: "approved",
    environment: "preproduction",
    platformKeys: Object.freeze([CLUTCHPACKS_PLATFORM_KEY]),
    revision: plan.configuration.revision,
    counts: Object.freeze({
      categories: plan.configuration.categories.length,
      collectibles: plan.configuration.collectibles.length,
      repacks: plan.configuration.repacks.length,
    }),
    configurationSha256: plan.configurationHash,
    databaseTargetSha256: plan.command.databaseTargetDigest,
    targetScopeSha256: plan.scopeDigest,
    publicChangeSequence: approved.publicChangeSequence.toString(),
    preflight: plan.preflight,
  });
}

export async function createProductionDependencies() {
  const [contracts, database, prismaClient] = await Promise.all([
    import("@packscout/contracts"),
    import("@packscout/database"),
    import("@prisma/client"),
  ]);
  const { Prisma } = prismaClient;
  return Object.freeze({
    async readConfiguration(configurationFile) {
      return readConfigurationFile(configurationFile);
    },
    validateConfiguration(value) {
      const parsed = contracts.approvedPublicCatalogConfigurationV1Schema.safeParse(
        value,
      );
      return parsed.success ? parsed.data : null;
    },
    hashConfiguration(configuration) {
      return contracts.sha256CanonicalJson(
        database.PUBLIC_CATALOG_CONFIGURATION_HASH_DOMAIN,
        configuration,
      );
    },
    async preflightConfiguration({
      configuration,
      databaseUrl,
      organizationId,
    }) {
      const lifecycle = database.createPrismaClientLifecycle({ databaseUrl });
      let preflight;
      let failure;
      try {
        await lifecycle.start();
        const repackExternalIds = configuration.repacks.map(
          ({ packExternalId }) => packExternalId,
        );
        const collectibleExternalIds = configuration.collectibles.map(
          ({ externalId }) => externalId,
        );
        const rows = await lifecycle.client.$transaction(
          async (transaction) => {
            await transaction.$executeRaw(
              Prisma.sql`set transaction read only`,
            );
            return transaction.$queryRaw(Prisma.sql`
              with bound_organization as (
                select organization.id
                from public.organizations as organization
                where organization.id = cast(${organizationId} as uuid)
              ),
              registered_provider as (
                select provider.id,
                       provider.organization_id,
                       provider.state
                from public.provider_sources as provider
                join bound_organization as organization
                  on organization.id = provider.organization_id
                where provider.platform_key = ${CLUTCHPACKS_PLATFORM_KEY}
              ),
              current_v1_source as (
                select source.id
                from registered_provider as provider
                join public.provider_source_instances as source
                  on source.organization_id = provider.organization_id
                 and source.provider_id = provider.id
                join public.provider_source_revisions as revision
                  on revision.organization_id = source.organization_id
                 and revision.provider_id = source.provider_id
                 and revision.source_instance_id = source.id
                 and revision.id = source.active_revision_id
                where provider.state = 'active'
                  and source.state in ('active', 'paused')
                  and revision.normalized_contract_version =
                    ${contracts.PROVIDER_OBSERVATION_CONTRACT_VERSION}
              ),
              current_packs as (
                select entity.id,
                       entity.external_id
                from public.canonical_entities as entity
                join public.canonical_revisions as revision
                  on revision.id = entity.current_revision_id
                 and revision.organization_id = entity.organization_id
                 and revision.entity_id = entity.id
                where entity.organization_id = cast(${organizationId} as uuid)
                  and entity.platform_key = ${CLUTCHPACKS_PLATFORM_KEY}
                  and entity.record_kind = 'pack'
              ),
              configured_repacks as (
                select unnest(${repackExternalIds}::text[]) as external_id
              ),
              current_collectibles as (
                select entity.id,
                       entity.external_id,
                       revision.content_json
                from public.canonical_entities as entity
                join public.canonical_revisions as revision
                  on revision.id = entity.current_revision_id
                 and revision.organization_id = entity.organization_id
                 and revision.entity_id = entity.id
                where entity.organization_id = cast(${organizationId} as uuid)
                  and entity.platform_key = ${CLUTCHPACKS_PLATFORM_KEY}
                  and entity.record_kind = 'catalog_asset'
              ),
              associated_current_collectibles as (
                select distinct collectible.id,
                                collectible.content_json
                from public.canonical_entities as source
                join public.canonical_relationships as card_relationship
                  on card_relationship.organization_id = source.organization_id
                 and card_relationship.source_entity_id = source.id
                 and card_relationship.relationship_kind = 'card'
                 and card_relationship.target_platform_key =
                   ${CLUTCHPACKS_PLATFORM_KEY}
                 and card_relationship.target_record_kind = 'catalog_asset'
                 and card_relationship.target_entity_id is not null
                 and card_relationship.resolved_public_change_sequence is not null
                 and card_relationship.resolved_at is not null
                join current_collectibles as collectible
                  on collectible.id = card_relationship.target_entity_id
                 and collectible.external_id =
                   card_relationship.target_external_id
                join public.canonical_relationships as pack_relationship
                  on pack_relationship.organization_id = source.organization_id
                 and pack_relationship.source_entity_id = source.id
                 and pack_relationship.relationship_kind = 'pack'
                 and pack_relationship.target_platform_key =
                   ${CLUTCHPACKS_PLATFORM_KEY}
                 and pack_relationship.target_record_kind = 'pack'
                 and pack_relationship.target_entity_id is not null
                 and pack_relationship.resolved_public_change_sequence is not null
                 and pack_relationship.resolved_at is not null
                join current_packs as pack
                  on pack.id = pack_relationship.target_entity_id
                 and pack.external_id = pack_relationship.target_external_id
                where source.organization_id = cast(${organizationId} as uuid)
                  and source.platform_key = ${CLUTCHPACKS_PLATFORM_KEY}
                  and source.record_kind = 'pull'
              ),
              configured_collectibles as (
                select unnest(${collectibleExternalIds}::text[]) as external_id
              )
              select true as "migrationReady",
                     current_setting('transaction_read_only') = 'on'
                       as "readOnly",
                     (select count(*)::integer from bound_organization)
                       as "organizationCount",
                     (select count(*)::integer from registered_provider)
                       as "registeredProviderCount",
                     (select count(*)::integer from current_v1_source)
                       as "currentV1SourceCount",
                     (select count(*)::integer from current_packs)
                       as "canonicalPackCount",
                     (select count(*)::integer from configured_repacks)
                       as "configuredRepackCount",
                     (
                       select count(*)::integer
                       from current_packs as canonical
                       where not exists (
                         select 1
                         from configured_repacks as configured
                         where configured.external_id = canonical.external_id
                       )
                     ) as "unconfiguredCanonicalPackCount",
                     (
                       select count(*)::integer
                       from configured_repacks as configured
                       where not exists (
                         select 1
                         from current_packs as canonical
                         where canonical.external_id = configured.external_id
                       )
                     ) as "unmatchedConfiguredRepackCount",
                     (select count(*)::integer from current_collectibles)
                       as "canonicalCollectibleCount",
                     (
                       select count(*)::integer
                       from associated_current_collectibles
                     ) as "associatedCanonicalCollectibleCount",
                     (
                       select count(*)::integer
                       from associated_current_collectibles as collectible
                       where jsonb_typeof(collectible.content_json -> 'name')
                               is distinct from 'string'
                          or nullif(
                               btrim(collectible.content_json ->> 'name'),
                               ''
                             ) is null
                     ) as "unnamedAssociatedCanonicalCollectibleCount",
                     (select count(*)::integer from configured_collectibles)
                       as "configuredCollectibleCount",
                     (
                       select count(*)::integer
                       from current_collectibles as canonical
                       where not exists (
                         select 1
                         from configured_collectibles as configured
                         where configured.external_id = canonical.external_id
                       )
                     ) as "unconfiguredCanonicalCollectibleCount",
                     (
                       select count(*)::integer
                       from configured_collectibles as configured
                       where not exists (
                         select 1
                         from current_collectibles as canonical
                         where canonical.external_id = configured.external_id
                       )
                     ) as "unmatchedConfiguredCollectibleCount"
            `);
          },
          {
            ...database.PACKSCOUT_TRANSACTION_OPTIONS,
            isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
          },
        );
        preflight = rows.length === 1 ? rows[0] : undefined;
      } catch (error) {
        failure = error;
      }
      try {
        await lifecycle.close();
      } catch (error) {
        if (failure === undefined) failure = error;
      }
      if (failure !== undefined) throw failure;
      return preflight;
    },
    async approveConfiguration({ configuration, databaseUrl, organizationId }) {
      const lifecycle = database.createPrismaClientLifecycle({ databaseUrl });
      let approved;
      let failure;
      try {
        await lifecycle.start();
        approved = await new database.PrismaCatalogReleaseSourceRepository(
          lifecycle.client,
          organizationId,
        ).approveConfiguration(
          configuration,
          database.prismaApprovedPublicRepackIdentityMaterializer,
        );
      } catch (error) {
        failure = error;
      }
      try {
        await lifecycle.close();
      } catch (error) {
        if (failure === undefined && approved === undefined) failure = error;
      }
      if (failure !== undefined) throw failure;
      return approved;
    },
  });
}

function mapPersistenceError(error) {
  const code = PERSISTENCE_ERROR_CODES[error?.code];
  return new ClutchpacksCatalogApprovalError(
    code ?? "CATALOG_APPROVAL_PERSISTENCE_FAILED",
  );
}

export async function runClutchpacksCatalogApproval({
  argv,
  environment,
  dependencies,
  writeOutput = (value) => process.stdout.write(`${value}\n`),
}) {
  const command = parseClutchpacksCatalogApprovalCommand({ argv, environment });
  const runtime = dependencies ?? await createProductionDependencies();
  let rawConfiguration;
  try {
    rawConfiguration = await runtime.readConfiguration(command.configurationFile);
  } catch (error) {
    if (error instanceof ClutchpacksCatalogApprovalError) throw error;
    return refuse("CATALOG_APPROVAL_CONFIGURATION_FILE_INVALID");
  }

  let configuration;
  try {
    configuration = runtime.validateConfiguration(rawConfiguration);
  } catch {
    return refuse("CATALOG_APPROVAL_CONFIGURATION_INVALID");
  }
  if (configuration === null || configuration === undefined) {
    refuse("CATALOG_APPROVAL_CONFIGURATION_INVALID");
  }
  assertClutchpacksOnly(configuration);

  let configurationHash;
  try {
    configurationHash = await runtime.hashConfiguration(configuration);
  } catch {
    return refuse("CATALOG_APPROVAL_INTERNAL_FAILURE");
  }
  if (!SHA256_PATTERN.test(configurationHash)) {
    refuse("CATALOG_APPROVAL_INTERNAL_FAILURE");
  }
  const scopeDigest = computeCatalogApprovalScopeDigest({
    organizationId: command.organizationId,
    deploymentKey: command.deploymentKey,
    databaseTargetDigest: command.databaseTargetDigest,
    configurationHash,
  });
  const confirmation = buildCatalogApprovalConfirmation(scopeDigest);
  const basePlan = Object.freeze({
    command,
    configuration,
    configurationHash,
    confirmation,
    scopeDigest,
  });

  if (
    !command.dryRun &&
    !exactConfirmationMatches(command.confirmation, confirmation)
  ) {
    refuse("CATALOG_APPROVAL_CONFIRMATION_MISMATCH");
  }

  let rawPreflight;
  try {
    rawPreflight = await runtime.preflightConfiguration({
      configuration,
      databaseUrl: command.databaseUrl,
      deploymentKey: command.deploymentKey,
      organizationId: command.organizationId,
    });
  } catch (error) {
    if (error instanceof ClutchpacksCatalogApprovalError) throw error;
    return refuse("CATALOG_APPROVAL_DATABASE_PREFLIGHT_FAILED");
  }
  const preflight = validatedPreflight(configuration, rawPreflight);
  const plan = Object.freeze({ ...basePlan, preflight });

  if (command.dryRun) {
    const summary = planSummary(plan);
    writeOutput(JSON.stringify(summary));
    return summary;
  }

  let approved;
  try {
    approved = await runtime.approveConfiguration({
      configuration,
      databaseUrl: command.databaseUrl,
      deploymentKey: command.deploymentKey,
      organizationId: command.organizationId,
    });
  } catch (error) {
    throw mapPersistenceError(error);
  }
  const summary = approvalSummary(plan, approved);
  writeOutput(JSON.stringify(summary));
  return summary;
}

export function clutchpacksCatalogApprovalUsage() {
  return `Usage:
  npm run approve:catalog-configuration:clutchpacks:preproduction -- \\
    /absolute/private/path/approved-clutchpacks.json [--dry-run]

  npm run approve:catalog-configuration:clutchpacks:preproduction -- \\
    /absolute/private/path/approved-clutchpacks.json --execute \\
    --confirmation "${CONFIRMATION_PREFIX} <digest>"

Required protected environment:
  PACKSCOUT_RUNTIME_ENVIRONMENT=preproduction
  PACKSCOUT_PUBLIC_ORGANIZATION_ID
  PACKSCOUT_CATALOG_DEPLOYMENT_KEY
  PACKSCOUT_DATABASE_URL

Dry-run opens the bound database in a read-only transaction and verifies the
exact migration set, organization, current ClutchPacks V1 source, and complete
pack/collectible external-ID coverage. It also refuses associated catalog assets
whose current canonical content lacks a nonblank public name. Execute repeats
that preflight before persisting the approved configuration. Output contains
counts and digests only.`;
}

async function main() {
  if (process.argv.slice(2).includes("--help")) {
    process.stdout.write(`${clutchpacksCatalogApprovalUsage()}\n`);
    return;
  }
  try {
    await runClutchpacksCatalogApproval({
      argv: process.argv.slice(2),
      environment: process.env,
    });
  } catch (error) {
    const safeError = error instanceof ClutchpacksCatalogApprovalError
      ? error
      : new ClutchpacksCatalogApprovalError(
          "CATALOG_APPROVAL_INTERNAL_FAILURE",
        );
    process.stderr.write(`${JSON.stringify({
      error: safeError.message,
      code: safeError.code,
    })}\n`);
    process.exitCode = 1;
  }
}

const entryPoint = process.argv[1];
if (entryPoint && pathToFileURL(path.resolve(entryPoint)).href === import.meta.url) {
  await main();
}

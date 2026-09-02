#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import {
  PROVIDER_PUBLIC_PROFILE_HASH_DOMAIN,
  PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
  canonicalJson,
  globalCategoryPublicId,
  packscoutPublicIdentityUuid,
  providerReleaseApplyBatchRequestSchema,
  providerReleaseCatalogPinHash,
  providerReleaseCorrelationSnapshotHash,
  publicRepackViewDetailV3Schema,
  publicVendorSchema,
  recomputeProviderCatalogReleaseOriginSetHashV1,
  sha256CanonicalJson,
  type PublicCategory,
  type PublicCollectible,
  type PublicRepackChase,
  type PublicRepackDetail,
} from "@packscout/contracts";
import {
  PrismaProviderPromotionJobRepository,
  PrismaProviderRuntimeRepository,
  ProviderCanonicalRepository,
  type PinnedProviderReleaseInputs,
  type ProviderPrismaClient,
} from "@packscout/database";
import { createProviderHarness } from "@packscout/database/test-support";
import {
  DataReleaseV3ReleaseAssembler,
  DataReleaseV3ReleasePublisher,
  SignedConvexDataReleaseV3PublicationClient,
  SignedConvexProviderReleasePublicationClient,
  type DataReleaseV3CanonicalProduct,
  type DistributedProviderReleasePublicationTransport,
} from "@packscout/services";
import { api } from "../../convex/_generated/api";
import {
  readProviderPublicationJobAuthorityConfiguration,
} from "../../apps/worker/src/distributed-promotion-authority-config.ts";
import { createProviderPromotionJobRuntime } from
  "../../apps/worker/src/provider-promotion-job-runtime-composition.ts";
import { createLocalConvexEvMigrationClient } from
  "./local-convex-ev-migration-client.mts";
import { withLocalConvexEvReady } from
  "./local-convex-ev-migration.mts";
import {
  installOwnedLocalConvexPublicationAuthorities,
  runLocalConvexPublicationCommand,
  withVerifiedLocalConvexPublicationAuthorityCleanup,
} from "./local-convex-publication-authorities.mts";
import {
  parseEnvironmentFile,
  readLocalConvexConfiguration,
} from "./seed-convex-mock-data-release.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const providerConfigVersionId = "92000000-0000-4000-8000-000000000001";
const publicProfileVersionId = "92000000-0000-4000-8000-000000000002";
const catalogVersionId = "92000000-0000-4000-8000-000000000003";
const globalCategoryId = "92000000-0000-4000-8000-000000000004";
export const providerKeyId = "local.provider-worker.e2e.v1";
export const dataReleaseV3KeyId = "local.provider-worker.v3.e2e.v1";
const packKey = "provider-worker-frontend-e2e";
const displayName = "Promoted by the provider worker E2E";
const authorityEnvironmentKeys = Object.freeze([
  "PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS",
  "PACKSCOUT_PROVIDER_RELEASE_KEY_PLATFORMS",
  "PACKSCOUT_DATA_RELEASE_V3_PUBLICATION_KEY_IDS",
] as const);
const persistentEnvironmentKeys = new Set([
  "PACKSCOUT_RUNTIME_ENVIRONMENT",
  "PACKSCOUT_PUBLIC_ORIGIN_SET_HASH",
]);

class LocalProviderPromotionE2eError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "LocalProviderPromotionE2eError";
  }
}

function refuse(code: string): never {
  throw new LocalProviderPromotionE2eError(code);
}

export function loopbackSiteUrl(environment: NodeJS.ProcessEnv): string {
  const configured = environment.CONVEX_SITE_URL?.trim() ?? "";
  try {
    const parsed = new URL(configured);
    if (
      parsed.protocol !== "http:" ||
      (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) return refuse("LOCAL_CONVEX_SITE_URL_INVALID");
    return parsed.origin;
  } catch (error) {
    if (error instanceof LocalProviderPromotionE2eError) throw error;
    return refuse("LOCAL_CONVEX_SITE_URL_INVALID");
  }
}

function assertLocalPostgresTarget(): void {
  const configured = process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL?.trim();
  if (configured === undefined || configured === "") return;
  try {
    const parsed = new URL(configured);
    if (
      (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
      (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost")
    ) return refuse("LOCAL_POSTGRES_TARGET_INVALID");
  } catch (error) {
    if (error instanceof LocalProviderPromotionE2eError) throw error;
    return refuse("LOCAL_POSTGRES_TARGET_INVALID");
  }
}

async function runConvex(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  capture = false,
  standardInput?: string,
): Promise<string> {
  return await runLocalConvexPublicationCommand({
    args,
    environment,
    cwd: repositoryRoot,
    capture,
    ...(standardInput === undefined ? {} : { standardInput }),
  });
}

export async function installPublicationAuthorities(input: Readonly<{
  environment: NodeJS.ProcessEnv;
  providerKey: string;
  providerSecret: Uint8Array;
  dataReleaseV3Secret: Uint8Array;
  originSetHash: string;
}>): Promise<() => Promise<void>> {
  return await installOwnedLocalConvexPublicationAuthorities({
    authorityEnvironmentKeys,
    persistentEnvironmentKeys,
    commands: {
      async readEnvironment() {
        return parseEnvironmentFile(
          await runConvex(["env", "list"], input.environment, true),
        );
      },
      async setEnvironmentValue(name, value) {
        await runConvex(
          ["env", "set", name],
          input.environment,
          false,
          value,
        );
      },
      async removeEnvironmentValue(name) {
        await runConvex(["env", "remove", name], input.environment);
      },
    },
    async configure({ initialEnvironment, set }) {
      const runtimeEnvironment =
        initialEnvironment.PACKSCOUT_RUNTIME_ENVIRONMENT?.trim() ?? "";
      if (runtimeEnvironment !== "" && runtimeEnvironment !== "local") {
        return refuse("LOCAL_CONVEX_RUNTIME_ENVIRONMENT_CONFLICT");
      }
      const configuredOriginSetHash =
        initialEnvironment.PACKSCOUT_PUBLIC_ORIGIN_SET_HASH?.trim() ?? "";
      if (
        configuredOriginSetHash !== "" &&
        configuredOriginSetHash !== input.originSetHash
      ) return refuse("LOCAL_CONVEX_PUBLIC_ORIGIN_SET_CONFLICT");
      await set("PACKSCOUT_RUNTIME_ENVIRONMENT", "local");
      if (configuredOriginSetHash === "") {
        await set("PACKSCOUT_PUBLIC_ORIGIN_SET_HASH", input.originSetHash);
      }
      await set("PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS", canonicalJson({
        [providerKeyId]: Buffer.from(input.providerSecret).toString("base64"),
        [dataReleaseV3KeyId]: Buffer.from(input.dataReleaseV3Secret)
          .toString("base64"),
      }));
      await set("PACKSCOUT_PROVIDER_RELEASE_KEY_PLATFORMS", canonicalJson({
        [providerKeyId]: input.providerKey,
      }));
      await set(
        "PACKSCOUT_DATA_RELEASE_V3_PUBLICATION_KEY_IDS",
        canonicalJson([dataReleaseV3KeyId]),
      );
    },
  });
}

async function configureProviderRuntime(input: Readonly<{
  client: ProviderPrismaClient;
  providerId: string;
  providerKey: string;
  observedAt: Date;
}>): Promise<void> {
  await new PrismaProviderRuntimeRepository(input.client)
    .synchronizeConfiguration({
      centralProviderId: input.providerId,
      providerKey: input.providerKey,
      configVersionId: providerConfigVersionId,
      configVersionNumber: 1n,
      configuration: { adapterKey: "provider-worker-frontend-e2e" },
      expiresAt: null,
      scheduleSeconds: 300,
      nextDueAt: null,
      synchronizedAt: input.observedAt,
    });
  await input.client.provider_runtime.update({
    where: { singleton_key: true },
    data: {
      last_head_reached_at: input.observedAt,
      last_attempted_at: input.observedAt,
      freshness_state: "fresh",
      row_version: { increment: 1n },
    },
  });
}

async function releasePin(input: Readonly<{
  providerId: string;
  providerKey: string;
  categoryId: string;
  categoryRowVersion: bigint;
}>): Promise<PinnedProviderReleaseInputs> {
  const publicProvider = publicVendorSchema.parse({
    publicVendorId: packscoutPublicIdentityUuid(
      `provider:${input.providerId}`,
    ),
    vendorKey: input.providerKey,
    displayName: "Provider worker E2E",
    logoUrl: null,
    websiteUrl: "https://fixture.example",
    listingHosts: ["fixture.example"],
    imageOrigins: [],
    referralParameters: [],
    publicPromo: null,
  });
  const publicCategoryId = globalCategoryPublicId(globalCategoryId);
  const catalogCategories: PinnedProviderReleaseInputs["catalogCategories"] = [{
    publicCategoryId,
    parentPublicCategoryId: null,
    categoryKey: "cards",
    displayName: "Cards",
    categoryKind: "vertical",
    displayOrder: 0,
    depth: 0,
    pathPublicCategoryIds: [publicCategoryId],
    lifecycle: "active",
  }];
  const categoryCorrelations = [{
    localCategoryId: input.categoryId,
    localEntityVersion: input.categoryRowVersion,
    publicCategoryId,
  }];
  const catalogContentHash = "a".repeat(64);
  const catalogThroughChangeSequence = 1n;
  const correlationEventSequence = 1n;
  return {
    providerId: input.providerId,
    providerKey: input.providerKey,
    providerConfigVersionId,
    providerConfigExpiresAt: null,
    staleAfterSeconds: 900,
    centralSchemaVersion: "distributed-central-v1",
    catalogVersionId,
    catalogSchemaVersion: "catalog-v1",
    catalogContentHash,
    catalogThroughChangeSequence,
    catalogCategories,
    catalogCollectibles: [],
    catalogAliases: [],
    catalogArtifactVerificationHash: await providerReleaseCatalogPinHash({
      catalogVersionId,
      catalogSchemaVersion: "catalog-v1",
      catalogContentHash,
      catalogThroughChangeSequence: catalogThroughChangeSequence.toString(),
      categories: catalogCategories,
      collectibles: [],
      aliases: [],
    }),
    correlationEventSequence,
    correlationSnapshotHash: await providerReleaseCorrelationSnapshotHash({
      providerId: input.providerId,
      correlationEventSequence: correlationEventSequence.toString(),
      categories: categoryCorrelations.map((row) => ({
        ...row,
        localEntityVersion: row.localEntityVersion.toString(),
      })),
      collectibles: [],
    }),
    categoryCorrelations,
    collectibleCorrelations: [],
    publicProfileVersionId,
    publicProfileHash: await sha256CanonicalJson(
      PROVIDER_PUBLIC_PROFILE_HASH_DOMAIN,
      publicProvider,
    ),
    publicProvider,
  };
}

export type CapturedProviderRows = {
  categories: PublicCategory[];
  collectibles: PublicCollectible[];
  repacks: PublicRepackDetail[];
  chases: PublicRepackChase[];
};

export function captureProviderBatch(
  rows: CapturedProviderRows,
  canonicalRequestBody: string,
): void {
  const request = providerReleaseApplyBatchRequestSchema.parse(
    JSON.parse(canonicalRequestBody) as unknown,
  );
  switch (request.batch.kind) {
    case "categories":
      rows.categories.push(...request.batch.records);
      return;
    case "collectibles":
      rows.collectibles.push(...request.batch.records);
      return;
    case "repacks":
      rows.repacks.push(...request.batch.records);
      return;
    case "repack_chases":
      rows.chases.push(...request.batch.records);
      return;
    case "vendors":
    case "search_shards":
      return;
  }
}

function dataReleaseV3Product(
  detail: PublicRepackDetail,
  platformKey: string,
): DataReleaseV3CanonicalProduct {
  if (detail.availability !== "available") {
    return refuse("PROVIDER_WORKER_E2E_REPACK_NOT_AVAILABLE");
  }
  const vendorReported = detail.evEstimates.vendorReported;
  return {
    platformKey,
    productKey: packKey,
    publicRepackId: detail.publicRepackId,
    publicVendorId: detail.publicVendorId,
    vendorKey: detail.vendorKey,
    vendorDisplayName: detail.vendorDisplayName,
    vendorLogoUrl: detail.vendorLogoUrl,
    name: detail.name,
    format: detail.format,
    contentMode: detail.contentMode,
    categories: detail.categories,
    collectibleTypes: detail.collectibleTypes,
    availability: detail.availability,
    soldOutAt: null,
    price: detail.price,
    buyback: detail.buyback.status === "available"
      ? {
          kind: "uniform_rate",
          rateBasisPoints: detail.buyback.value.basisPoints,
        }
      : { kind: "unavailable" },
    vendorReportedEv: vendorReported.status === "available"
      ? {
          status: "available",
          sourceMoney: vendorReported.displayMoney,
          usdComparison: {
            status: "available",
            value: vendorReported.metrics.grossEv,
          },
          observedAt: vendorReported.observedAt,
        }
      : {
          status: "unavailable",
          sourceMoney: null,
          usdComparison: null,
          observedAt: null,
          reason: "NOT_REPORTED",
        },
    primaryImage: detail.primaryImage,
    topChase: detail.topChase,
    contentSummary: detail.contentSummary,
    actionAvailability: detail.actionAvailability,
    sourceUpdatedAt: detail.sourceUpdatedAt,
    description: detail.description,
    actions: detail.actions,
  };
}

async function verifyPublicRead(input: Readonly<{
  convexUrl: string;
  publicReleaseId: string;
  publicRepackId: string;
}>): Promise<void> {
  const result: unknown = await new ConvexHttpClient(input.convexUrl).action(
    api.publicRepacksV3.getPublicRepackV3,
    {
      publicReleaseId: input.publicReleaseId,
      publicRepackId: input.publicRepackId,
    },
  );
  if (
    typeof result !== "object" || result === null || Array.isArray(result) ||
    !("ok" in result) || result.ok !== true || !("data" in result)
  ) return refuse("FRONTEND_READ_MODEL_UNAVAILABLE");
  const detail = publicRepackViewDetailV3Schema.safeParse(result.data);
  if (
    !detail.success ||
    detail.data.publicRepackId !== input.publicRepackId ||
    detail.data.name !== displayName
  ) return refuse("FRONTEND_READ_MODEL_DIVERGENT");
}

export async function runProviderPromotionFrontendE2e(): Promise<void> {
  assertLocalPostgresTarget();
  const local = await readLocalConvexConfiguration();
  const siteUrl = loopbackSiteUrl(local.childEnvironment);
  const originSetHash = await recomputeProviderCatalogReleaseOriginSetHashV1([]);
  const providerSecret = new Uint8Array(randomBytes(32));
  const dataReleaseV3Secret = new Uint8Array(randomBytes(32));
  const migration = await createLocalConvexEvMigrationClient(local);
  let harness: Awaited<ReturnType<typeof createProviderHarness>> | undefined;
  let runtime: ReturnType<typeof createProviderPromotionJobRuntime>["runtime"]
    | undefined;
  let evidence: Record<string, unknown> | undefined;
  try {
    await withLocalConvexEvReady(migration, async () => {
      harness = await createProviderHarness();
      const observedAt = new Date();
      await configureProviderRuntime({
        client: harness.client,
        providerId: harness.providerId,
        providerKey: harness.providerKey,
        observedAt,
      });
      const canonical = new ProviderCanonicalRepository(harness.client);
      const category = await canonical.upsertCategory({
        categoryKey: "cards",
        parentCategoryId: null,
        displayName: "Cards",
      });
      await canonical.upsertPack({
        packKey,
        categoryId: category.id,
        familyKey: null,
        displayName,
        description: "Canonical PostgreSQL to worker to Convex to frontend proof",
        packFormat: "repack",
        availability: "available",
        contentEvidence: "complete",
        totalInventory: 10n,
        remainingInventory: 7n,
        priceAmount: "100",
        priceCurrency: "USD",
        priceUsdAmount: "100",
        priceUnavailableReason: null,
        buybackRate: null,
        buybackSourceKind: null,
        vendorEvAmount: "90",
        vendorEvCurrency: "USD",
        vendorEvObservedAt: observedAt,
        vendorEvUnavailableReason: null,
        packscoutEvAmount: null,
        packscoutEvCurrency: null,
        packscoutEvModelVersion: "model-v1",
        packscoutEvConfidencePolicyVersion: "policy-v1",
        packscoutEvConfidence: null,
        packscoutEvDataAsOf: null,
        packscoutEvCalculatedAt: null,
        packscoutEvUnavailableReason: "ESTIMATE_INPUT_INCOMPLETE",
        primaryImageUrl: null,
        primaryImageAlt: null,
        listingUrl: "https://fixture.example/provider-worker-frontend-e2e",
        attributes: { source: "provider-worker-frontend-e2e" },
        sourceUpdatedAt: observedAt,
      });
      const pin = await releasePin({
        providerId: harness.providerId,
        providerKey: harness.providerKey,
        categoryId: category.id,
        categoryRowVersion: category.rowVersion,
      });
      await withVerifiedLocalConvexPublicationAuthorityCleanup({
        install: async () => await installPublicationAuthorities({
          environment: local.childEnvironment,
          providerKey: harness!.providerKey,
          providerSecret,
          dataReleaseV3Secret,
          originSetHash,
        }),
        publish: async () => {
          const providerClient =
            new SignedConvexProviderReleasePublicationClient({
              baseUrl: siteUrl,
              keyId: providerKeyId,
              secret: providerSecret,
            });
          const captured: CapturedProviderRows = {
            categories: [],
            collectibles: [],
            repacks: [],
            chases: [],
          };
          const transport: DistributedProviderReleasePublicationTransport = {
            async sendExact(operation, signal) {
              if (operation.kind === "applyBatch") {
                captureProviderBatch(captured, operation.canonicalRequestBody);
              }
              return await providerClient.sendExact(operation, signal);
            },
            async status(request, signal) {
              return await providerClient.status(request, signal);
            },
          };
          const authority = readProviderPublicationJobAuthorityConfiguration({
            PACKSCOUT_CONVEX_PUBLICATION_BASE_URL: "https://convex.example",
            PACKSCOUT_CATALOG_DEPLOYMENT_KEY: "provider-worker-frontend-e2e",
            PACKSCOUT_PROMOTION_PROVIDER_ID: harness!.providerId,
            PACKSCOUT_PROMOTION_PROVIDER_KEY_ID: providerKeyId,
            PACKSCOUT_PROMOTION_PROVIDER_SECRET_BASE64:
              Buffer.from(providerSecret).toString("base64"),
            PACKSCOUT_PROMOTION_PROVIDER_AUTHORITY_VERSION: "e2e-v1",
          });
          const composed = createProviderPromotionJobRuntime({
            authority,
            provider: harness!.client,
            pin,
            loadPin: async () => pin,
            workerId: "provider-promotion:frontend-e2e",
            logger: { log() {} },
            manualCommands: {
              async verify() {
                return { state: "rejected", failureCode: "NOT_USED" };
              },
            },
            transport,
            now: () => observedAt,
          });
          runtime = composed.runtime;
          const wake = await new PrismaProviderPromotionJobRepository(
            harness!.client,
          ).loadWakeIntent();
          if (!wake.pending) return refuse("CANONICAL_DELTA_WAKE_NOT_OBSERVED");
          const cycle = await runtime.runCycle();
          const invocation = cycle.invocations[0];
          if (
            cycle.reconciliationFailures !== 0 ||
            cycle.stateReadFailures !== 0 ||
            cycle.invocations.length !== 1 ||
            invocation?.state !== "completed" ||
            invocation.outcome !== "caught_up"
          ) return refuse("PROVIDER_WORKER_DID_NOT_CATCH_UP");
          if (
            captured.repacks.length !== 1 ||
            captured.repacks[0]?.name !== displayName
          ) return refuse("PROVIDER_WORKER_RELEASE_ROWS_DIVERGENT");
          const [lane, publication] = await Promise.all([
            harness!.client.promotion_ledger.findUniqueOrThrow({
              where: { singleton_key: true },
            }),
            harness!.client.provider_publication_state.findUniqueOrThrow({
              where: { singleton_key: true },
            }),
          ]);
          if (
            publication.completed_through_change_sequence !==
              lane.last_sequence
          ) return refuse("PROVIDER_POSTGRES_CHECKPOINT_DIVERGENT");
          const providerHead = await providerClient.completedHead({
            schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
            operationId: "provider-worker-frontend-e2e-completed-head",
            platformKey: harness!.providerKey,
          });
          if (
            providerHead.receipt.details.head.release === null ||
            providerHead.receipt.details.head.providerCheckpoint
              .settledSequence !== lane.last_sequence.toString()
          ) return refuse("PROVIDER_CONVEX_HEAD_DIVERGENT");
          const providerDetail = captured.repacks[0]!;
          const assembler = new DataReleaseV3ReleaseAssembler(
            {
              async loadCatalogSnapshot() {
                return {
                  organizationId: harness!.providerId,
                  products: [dataReleaseV3Product(
                    providerDetail,
                    harness!.providerKey,
                  )],
                  categories: captured.categories,
                  collectibles: captured.collectibles,
                  chases: captured.chases,
                };
              },
            },
            {
              async getPublicationEligibleRevision() {
                return null;
              },
            },
          );
          const plan = await assembler.assemble({
            readAt: observedAt.toISOString(),
          });
          if (plan.classification !== "publish") {
            return refuse(`FRONTEND_RELEASE_BLOCKED_${plan.reason}`);
          }
          const v3Client = new SignedConvexDataReleaseV3PublicationClient({
            baseUrl: siteUrl,
            keyId: dataReleaseV3KeyId,
            secret: dataReleaseV3Secret,
          });
          const v3Outcome = await new DataReleaseV3ReleasePublisher(v3Client)
            .publish(plan);
          const active = await v3Client.activeState();
          if (
            active.activeRelease?.publicReleaseId !== plan.publicReleaseId ||
            active.activeRelease.releaseFingerprint !== plan.releaseFingerprint
          ) return refuse("FRONTEND_RELEASE_ACTIVATION_DIVERGENT");
          await verifyPublicRead({
            convexUrl: local.publicUrl,
            publicReleaseId: plan.publicReleaseId,
            publicRepackId: providerDetail.publicRepackId,
          });
          evidence = {
            status: "ready",
            source: {
              kind: "disposable_postgresql",
              deltaWakeObserved: true,
              settledSequence: lane.last_sequence.toString(),
            },
            worker: {
              triggerKind: invocation.triggerKind,
              outcome: invocation.outcome,
              platformKey: harness!.providerKey,
            },
            convex: {
              clientUrl: local.publicUrl,
              siteUrl,
              providerReleaseId:
                providerHead.receipt.details.head.release
                  .publicProviderReleaseId,
              frontendDataReleaseId: plan.publicReleaseId,
              frontendDataReleaseOutcome: v3Outcome.outcome,
            },
            frontendReadModel: {
              publicRepackId: providerDetail.publicRepackId,
              name: providerDetail.name,
              verified: true,
            },
          };
        },
      });
    });
  } finally {
    runtime?.stop();
    providerSecret.fill(0);
    dataReleaseV3Secret.fill(0);
    await harness?.close();
  }
  if (evidence === undefined) return refuse("LOCAL_PROVIDER_PROMOTION_E2E_FAILED");
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMain) {
  const operation = process.argv.length === 2
    ? runProviderPromotionFrontendE2e()
    : Promise.reject(new LocalProviderPromotionE2eError(
        "LOCAL_PROVIDER_PROMOTION_E2E_ARGUMENT_INVALID",
      ));
  operation.catch((error: unknown) => {
    const code = error instanceof LocalProviderPromotionE2eError
      ? error.code
      : "LOCAL_PROVIDER_PROMOTION_E2E_FAILED";
    process.stderr.write(`${JSON.stringify({ status: "refused", code })}\n`);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import dotenv from "dotenv";
import {
  CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
  PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
  buildGlobalCatalogAggregateObservationV1,
  canonicalJson,
  type ActiveCatalogManifestStateV1,
  type ProviderReleaseExpectedCompletedHeadV1,
  type ProviderReleaseImmutableProofV1,
} from "@packscout/contracts";
import {
  BoundedProviderDatabaseGateway,
  createCentralDatabaseLifecycle,
} from "@packscout/database";
import {
  AesGcmProviderCredentialCipher,
  CipherProviderDatabaseCredentialResolver,
  DataReleaseV3ReleasePublisher,
  PublicationClientError,
  SignedConvexCatalogManifestPublicationClient,
  SignedConvexDataReleaseV3PublicationClient,
  SignedConvexProviderReleasePublicationClient,
  composeGlobalCatalogManifest,
  prepareManifestPromotionOperation,
  prepareProviderPromotion,
  validateManifestPromotionReceipt,
  validateProviderPromotionReceipt,
} from "@packscout/services";
import { api } from "../../convex/_generated/api.js";
import { withLocalConvexEvReady } from "./local-convex-ev-migration.mts";
import { createLocalConvexEvMigrationClient } from "./local-convex-ev-migration-client.mts";
import {
  parseEnvironmentFile,
  readLocalConvexConfiguration,
} from "./seed-convex-mock-data-release.mjs";
import {
  DISTRIBUTED_CLUTCHPACKS_PLATFORM_KEY,
  DistributedClutchpacksPublicationError,
  buildDistributedClutchpacksPublicationArtifacts,
} from "./distributed-clutchpacks-publication-plan.mts";
import {
  installOwnedLocalConvexPublicationAuthorities,
  runLocalConvexPublicationCommand,
  withVerifiedLocalConvexPublicationAuthorityCleanup,
} from "./local-convex-publication-authorities.mts";
import {
  assertLocalClutchpacksV3Predecessor,
  bindLocalClutchpacksV3Predecessor,
  localClutchpacksManifestTransition,
  localClutchpacksProviderTransition,
} from "./distributed-clutchpacks-publication-transitions.mts";
import {
  localClutchpacksPlannedV3Rows,
  verifyLocalClutchpacksPublicReadback,
  verifyLocalClutchpacksContentReadback,
  type LocalClutchpacksEvReadbackRow,
} from "./distributed-clutchpacks-public-readback.mts";
import {
  resolveLocalClutchpacksProviderTerminal,
  type LocalClutchpacksProviderTerminal,
} from "./distributed-clutchpacks-provider-terminal.mts";

export { providerSnapshot } from "./distributed-clutchpacks-publication-snapshot.mts";
import { parseClutchpacksApprovedAssetOrigins } from "./distributed-clutchpacks-publication-snapshot.mts";
import { loadClutchpacksPublicationSnapshot as loadStableSnapshot, readClutchpacksPublicationDatabaseConfiguration,
  type ClutchpacksPublicationDatabaseConfiguration } from "./distributed-clutchpacks-publication-database.mts";

import { publicationImportLeasePort, withPublicationImportLease } from "./distributed-clutchpacks-publication-lease.mts";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const PROVIDER_KEY_ID = "local.clutchpacks.provider.v1";
const MANIFEST_KEY_ID = "local.manifest.publish.v1";
const DATA_RELEASE_V3_KEY_ID = "local.clutchpacks.data-release-v3.v1";
const AUTH_ENVIRONMENT_KEYS = Object.freeze([
  "PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS",
  "PACKSCOUT_PROVIDER_RELEASE_KEY_PLATFORMS",
  "PACKSCOUT_CATALOG_MANIFEST_KEY_ROLES",
  "PACKSCOUT_DATA_RELEASE_V3_PUBLICATION_KEY_IDS",
  "PACKSCOUT_HEAT_PUBLICATION_KEY_IDS",
] as const);
const PERSISTENT_PUBLICATION_ENVIRONMENT_KEYS = new Set([
  "PACKSCOUT_RUNTIME_ENVIRONMENT",
  "PACKSCOUT_PUBLIC_ORIGIN_SET_HASH",
]);

function refuse(code: string): never {
  throw new DistributedClutchpacksPublicationError(code);
}

async function failClosedPhase<T>(
  code: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DistributedClutchpacksPublicationError) throw error;
    if (error instanceof PublicationClientError) {
      return refuse(`${code}__${error.code}`);
    }
    return refuse(code);
  }
}

function required(value: string | undefined, code: string): string {
  const normalized = value?.trim() ?? "";
  if (normalized.length === 0 || /[\r\n\0]/u.test(normalized)) return refuse(code);
  return normalized;
}

function credentialKey(environment: NodeJS.ProcessEnv): {
  readonly version: number;
  readonly bytes: Uint8Array;
} {
  const encoded = required(
    environment.PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64,
    "PROVIDER_CREDENTIAL_CONFIGURATION_INVALID",
  );
  const bytes = Buffer.from(encoded, "base64");
  const version = Number(
    environment.PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION?.trim() ?? "1",
  );
  if (
    bytes.byteLength !== 32 ||
    bytes.toString("base64").replace(/=+$/u, "") !==
      encoded.replace(/=+$/u, "") ||
    !Number.isSafeInteger(version) || version < 1
  ) {
    bytes.fill(0);
    return refuse("PROVIDER_CREDENTIAL_CONFIGURATION_INVALID");
  }
  return { version, bytes: new Uint8Array(bytes) };
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

function loopbackSiteUrl(environment: NodeJS.ProcessEnv): string {
  const raw = required(
    environment.CONVEX_SITE_URL,
    "LOCAL_CONVEX_CONFIGURATION_INVALID",
  );
  try {
    const parsed = new URL(raw);
    if (
      parsed.protocol !== "http:" ||
      (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") ||
      parsed.username !== "" || parsed.password !== "" ||
      parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== ""
    ) return refuse("LOCAL_CONVEX_CONFIGURATION_INVALID");
    return parsed.origin;
  } catch {
    return refuse("LOCAL_CONVEX_CONFIGURATION_INVALID");
  }
}

function expectedHead(
  head: Awaited<ReturnType<SignedConvexProviderReleasePublicationClient["completedHead"]>>["receipt"]["details"]["head"],
): ProviderReleaseExpectedCompletedHeadV1 {
  return head.release === null
    ? {
        platformKey: DISTRIBUTED_CLUTCHPACKS_PLATFORM_KEY,
        publicProviderReleaseId: null,
        sharedConfigurationEpoch: null,
        providerCheckpoint: { settledSequence: "0", settledAt: null },
        observation: null,
        terminalReceiptSha256: null,
      }
    : {
        platformKey: head.platformKey,
        publicProviderReleaseId: head.release.publicProviderReleaseId,
        sharedConfigurationEpoch: head.release.sharedConfigurationEpoch,
        providerCheckpoint: head.providerCheckpoint,
        observation: head.observation,
        terminalReceiptSha256: head.terminalReceiptSha256,
      };
}

function immutableProof(
  plan: Awaited<ReturnType<typeof buildDistributedClutchpacksPublicationArtifacts>>["providerPlan"],
): ProviderReleaseImmutableProofV1 {
  return {
    platformKey: plan.platformKey,
    publicProviderReleaseId: plan.publicProviderReleaseId,
    sharedConfigurationEpoch: plan.sharedConfigurationEpoch,
    providerReleaseFingerprint: plan.providerReleaseFingerprint,
    contentHash: plan.contentHash,
    publicAssetOrigins: plan.publicAssetOrigins,
    governingHashes: plan.governingHashes,
    entityHashes: plan.entityHashes,
    counts: plan.counts,
    searchAlgorithmVersion: plan.searchAlgorithmVersion,
    providerSearchIndexHash: plan.providerSearchIndexHash,
    batchCount: plan.batchCount,
    batchChainHash: plan.batchChainHash,
    dataAsOf: plan.dataAsOf,
  };
}

function checkpointDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

async function installPublicationAuthorities(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly providerSecret: Uint8Array;
  readonly manifestSecret: Uint8Array;
  readonly v3Secret: Uint8Array;
  readonly originSetHash: string;
}): Promise<() => Promise<void>> {
  return await installOwnedLocalConvexPublicationAuthorities({
    authorityEnvironmentKeys: AUTH_ENVIRONMENT_KEYS,
    persistentEnvironmentKeys: PERSISTENT_PUBLICATION_ENVIRONMENT_KEYS,
    commands: {
      async readEnvironment() {
        return parseEnvironmentFile(
          await runConvex(["env", "list"], input.environment, true),
        );
      },
      async setEnvironmentValue(key, value) {
        await runConvex(["env", "set", key], input.environment, false, value);
      },
      async removeEnvironmentValue(key) {
        await runConvex(["env", "remove", key], input.environment);
      },
    },
    async configure({ initialEnvironment, set }) {
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
      await set("PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS", JSON.stringify({
        [PROVIDER_KEY_ID]: Buffer.from(input.providerSecret).toString("base64"),
        [MANIFEST_KEY_ID]: Buffer.from(input.manifestSecret).toString("base64"),
        [DATA_RELEASE_V3_KEY_ID]: Buffer.from(input.v3Secret).toString("base64"),
      }));
      await set("PACKSCOUT_PROVIDER_RELEASE_KEY_PLATFORMS", JSON.stringify({
        [PROVIDER_KEY_ID]: DISTRIBUTED_CLUTCHPACKS_PLATFORM_KEY,
      }));
      await set("PACKSCOUT_CATALOG_MANIFEST_KEY_ROLES", JSON.stringify({
        [MANIFEST_KEY_ID]: ["publish"],
      }));
      await set("PACKSCOUT_DATA_RELEASE_V3_PUBLICATION_KEY_IDS", JSON.stringify([
        DATA_RELEASE_V3_KEY_ID,
      ]));
    },
  });
}

async function publishProvider(input: {
  readonly client: SignedConvexProviderReleasePublicationClient;
  readonly manifestClient: SignedConvexCatalogManifestPublicationClient;
  readonly artifacts: Awaited<ReturnType<typeof buildDistributedClutchpacksPublicationArtifacts>>;
  readonly revalidate: () => Promise<void>;
}) {
  const headRequest = {
    schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
    operationId: "local-clutchpacks-completed-head",
    platformKey: DISTRIBUTED_CLUTCHPACKS_PLATFORM_KEY,
  } as const;
  const before = (await input.client.completedHead(headRequest)).receipt.details.head;
  const expectedProof = immutableProof(input.artifacts.providerPlan);
  const transition = localClutchpacksProviderTransition({
    before,
    expectedProof,
    providerCheckpoint: input.artifacts.providerPlan.providerCheckpoint,
    observation: input.artifacts.providerPlan.observation,
  });
  if (transition === "replay") {
    if (before.release === null) return refuse("LOCAL_CONVEX_PROVIDER_HEAD_NOT_OBSERVED");
    const terminal = await resolveLocalClutchpacksProviderTerminal({
      head: before,
      plan: input.artifacts.providerPlan,
      manifestState: (await input.manifestClient.activeState()).receipt.details.activeState,
      client: input.client,
    });
    return { ...before, ...terminal };
  }
  const plan = transition === "confirmReuse"
    ? { ...input.artifacts.providerPlan, classification: "reuse" as const, batches: [],
        reuseProof: { state: "complete" as const, ...expectedProof } }
    : input.artifacts.providerPlan;
  const prepared = prepareProviderPromotion({
    plan,
    expectedCompletedHead: expectedHead(before),
    checkpointSha256: checkpointDigest({
      stabilityFingerprint: input.artifacts.stabilityFingerprint,
      providerCheckpoint: input.artifacts.providerPlan.providerCheckpoint,
    }),
  });
  let terminal: LocalClutchpacksProviderTerminal | null = null;
  for (const operation of prepared.operations) {
    await input.revalidate();
    const publication = await input.client.sendExact({
      kind: operation.operationKind,
      canonicalRequestBody: operation.canonicalRequestBody,
    });
    const receipt = validateProviderPromotionReceipt({
      operation,
      receipt: publication.receipt,
      canonicalReceiptBody: publication.canonicalReceiptBody,
      receiptSha256: publication.receiptSha256,
    });
    if (receipt.operationKind === "finalize" || receipt.operationKind === "confirmReuse") {
      terminal = {
        terminalOperationKind: receipt.operationKind,
        terminalOperationId: receipt.operationId,
        terminalReceiptSha256: publication.receiptSha256,
      };
    }
  }
  const after = (await input.client.completedHead(headRequest)).receipt.details.head;
  if (
    after.release === null || terminal === null ||
    after.terminalReceiptSha256 !== terminal.terminalReceiptSha256 ||
    canonicalJson(after.release) !== canonicalJson(expectedProof) ||
    canonicalJson(after.providerCheckpoint) !==
      canonicalJson(input.artifacts.providerPlan.providerCheckpoint) ||
    canonicalJson(after.observation) !==
      canonicalJson(input.artifacts.providerPlan.observation)
  ) return refuse("LOCAL_CONVEX_PROVIDER_HEAD_NOT_OBSERVED");
  return { ...after, ...terminal };
}

async function activateManifest(input: {
  readonly client: SignedConvexCatalogManifestPublicationClient;
  readonly artifacts: Awaited<ReturnType<typeof buildDistributedClutchpacksPublicationArtifacts>>;
  readonly providerHead: Exclude<Awaited<ReturnType<typeof publishProvider>>, null>;
  readonly queuedRunCount: number;
  readonly revalidate: () => Promise<void>;
}) {
  if (input.providerHead.release === null) {
    return refuse("LOCAL_CONVEX_PROVIDER_HEAD_NOT_OBSERVED");
  }
  const manifest = await composeGlobalCatalogManifest({
    enabledPlatformKeys: [DISTRIBUTED_CLUTCHPACKS_PLATFORM_KEY],
    providerPlans: [input.artifacts.providerPlan],
    approvedConfiguration: {
      sharedConfigurationEpoch:
        input.artifacts.providerPlan.sharedConfigurationEpoch,
      confidencePolicyVersion:
        input.artifacts.configuration.confidencePolicy.version,
    },
  });
  const observation = buildGlobalCatalogAggregateObservationV1({
    observationSequence: Number(
      input.artifacts.providerPlan.providerCheckpoint.settledSequence,
    ),
    publicReleaseId: manifest.publicReleaseId,
    providerReferenceSetHash: manifest.providerReferenceSetHash,
    providerSelections: [{
      platformKey: DISTRIBUTED_CLUTCHPACKS_PLATFORM_KEY,
      publicProviderReleaseId: input.providerHead.release.publicProviderReleaseId,
      terminalOperationKind: input.providerHead.terminalOperationKind,
      terminalOperationId: input.providerHead.terminalOperationId,
      terminalReceiptSha256: input.providerHead.terminalReceiptSha256,
      selectedProviderCheckpoint: input.providerHead.providerCheckpoint,
      selectedDataAsOf: input.providerHead.release.dataAsOf,
      latestAffectedSettledSequence:
        input.providerHead.providerCheckpoint.settledSequence,
      latestAffectedSourceHeadSequence:
        input.providerHead.observation.sourceHeadSequence,
      initialBackfillComplete: true,
      affectedDerivationsSettled: true,
      settledSourceFreshness: input.queuedRunCount > 0
        ? "delayed"
        : input.providerHead.observation.freshness,
      lastSuccessfulObservationAt:
        input.providerHead.observation.lastSuccessfulObservationAt,
      staleAt: input.providerHead.observation.staleAt,
    }],
  });
  const before = (await input.client.activeState()).receipt.details.activeState;
  const transition = localClutchpacksManifestTransition({ before, manifest, observation });
  if (transition === "replay") return { manifest, observation, state: before };
  const operationId =
    `manifest:${manifest.publicReleaseId}:${observation.observationSequence}:${transition}`;
  const operation = prepareManifestPromotionOperation(transition, {
    schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
    operationId,
    idempotencyKey: operationId,
    manifest,
    observation,
    expectedActiveState: before,
  });
  await input.revalidate();
  const publication = await input.client.sendExact({
    kind: operation.operationKind,
    canonicalRequestBody: operation.canonicalRequestBody,
  });
  validateManifestPromotionReceipt({
    operation,
    receipt: publication.receipt,
    canonicalReceiptBody: publication.canonicalReceiptBody,
    receiptSha256: publication.receiptSha256,
  });
  const after = (await input.client.activeState()).receipt.details.activeState;
  if (
    after.activeManifest?.publicReleaseId !== manifest.publicReleaseId ||
    after.activeManifest.manifestFingerprint !== manifest.manifestFingerprint ||
    canonicalJson(after.observation) !== canonicalJson(observation)
  ) return refuse("LOCAL_CONVEX_ACTIVE_MANIFEST_NOT_OBSERVED");
  return { manifest, observation, state: after };
}

async function verifyPublicReads(input: {
  readonly convexUrl: string;
  readonly expectedRepackIds: readonly string[];
  readonly manifestPublicReleaseId: string;
  readonly v3PublicReleaseId: string;
  readonly v3Plan: Awaited<ReturnType<typeof buildDistributedClutchpacksPublicationArtifacts>>["v3Plan"];
  readonly previousV3Rows: readonly LocalClutchpacksEvReadbackRow[];
}) {
  const client = new ConvexHttpClient(input.convexUrl);
  const currentTime = Date.now();
  const [manifestShell, manifestList, v3Shell, v3List, dashboard] = await Promise.all([
    client.query(api.publicRepacks.getPublicShellStatus, {}),
    client.query(api.publicRepacks.listPublicRepacks, {
      currentTime,
      pageSize: 50,
      filters: { availability: "all" },
    }),
    client.query(api.publicRepacksV3.getPublicShellStatusV3, {}),
    client.query(api.publicRepacksV3.listPublicRepacksV3, {
      currentTime,
      pageSize: 50,
      filters: { availability: "all" },
    }),
    client.query(api.publicRepacksV3.getDashboardBundleV3, {
      currentTime,
      filters: { availability: "all" },
    }),
  ]);
  if (!manifestList.ok || !v3List.ok) return refuse("LOCAL_CONVEX_PUBLIC_READBACK_FAILED");
  verifyLocalClutchpacksContentReadback({ expectedRows: localClutchpacksPlannedV3Rows(input.v3Plan),
    manifestRows: manifestList.data.rows, v3Rows: v3List.data.rows });
  return verifyLocalClutchpacksPublicReadback({
    ...input,
    currentTime,
    expectedV3Rows: localClutchpacksPlannedV3Rows(input.v3Plan),
    manifestShell,
    manifestList,
    v3Shell,
    v3List,
    dashboard,
  });
}

export async function promoteDistributedClutchpacksToLocalConvex(options: {
  readonly checkOnly?: boolean;
} = {}): Promise<void> {
  dotenv.config({ path: path.join(repositoryRoot, ".env") });
  const databaseConfiguration = readClutchpacksPublicationDatabaseConfiguration(process.env);
  const local = await readLocalConvexConfiguration();
  // Before any provider/manifest publication or authority installation. A
  // legacy public snapshot being readable does not mean retention is ready.
  return await withLocalConvexEvReady(await createLocalConvexEvMigrationClient(local),
    () => promoteReadyDistributedClutchpacks(local, options, databaseConfiguration));
}

async function promoteReadyDistributedClutchpacks(
  local: Awaited<ReturnType<typeof readLocalConvexConfiguration>>,
  options: { readonly checkOnly?: boolean },
  databaseConfiguration: ClutchpacksPublicationDatabaseConfiguration,
): Promise<void> {
  const baseUrl = loopbackSiteUrl(local.childEnvironment);
  const approvedPublicAssetOrigins = parseClutchpacksApprovedAssetOrigins(
    process.env.PACKSCOUT_LOCAL_CLUTCHPACKS_PUBLIC_ASSET_ORIGINS_JSON,
  );
  const key = credentialKey(process.env);
  const cipher = new AesGcmProviderCredentialCipher({
    primaryVersion: key.version,
    keys: new Map([[key.version, key.bytes]]),
  });
  const central = createCentralDatabaseLifecycle({
    databaseUrl: databaseConfiguration.centralDatabaseUrl,
    connectionLimit: 2,
  });
  const gateway = new BoundedProviderDatabaseGateway({
    central,
    credentialResolver: new CipherProviderDatabaseCredentialResolver(cipher),
    destinationPolicy: databaseConfiguration.runtimePolicy.destinationPolicy,
    connectionLimitPerProvider: 2,
    maximumCachedProviders: 1,
    operationTimeoutMs: 60_000,
  });
  const providerSecret = randomBytes(32);
  const manifestSecret = randomBytes(32);
  const v3Secret = randomBytes(32);
  try {
    await failClosedPhase(
      "CENTRAL_DATABASE_UNREACHABLE",
      async () => await central.start(),
    );
    const initial = await failClosedPhase(
      "CLUTCHPACKS_SNAPSHOT_LOAD_FAILED",
      async () => await loadStableSnapshot({
        databaseConfiguration,
        central: central.client,
        gateway,
        approvedPublicAssetOrigins,
      }),
    );
    const artifacts = await failClosedPhase(
      "CLUTCHPACKS_PUBLICATION_ARTIFACT_INVALID",
      async () => await buildDistributedClutchpacksPublicationArtifacts(
        initial, new Date().toISOString(),
      ),
    );
    const confirmed = await failClosedPhase(
      "CLUTCHPACKS_SNAPSHOT_CONFIRMATION_FAILED",
      async () => await loadStableSnapshot({
        databaseConfiguration,
        central: central.client,
        gateway,
        approvedPublicAssetOrigins,
      }),
    );
    if (confirmed.stabilityFingerprint !== initial.stabilityFingerprint) {
      return refuse("CLUTCHPACKS_SNAPSHOT_CHANGED");
    }
    if (options.checkOnly === true) {
      process.stdout.write(`${JSON.stringify({
        status: "eligible",
        source: {
          providerKey: DISTRIBUTED_CLUTCHPACKS_PLATFORM_KEY,
          settledSequence:
            artifacts.providerPlan.providerCheckpoint.settledSequence,
          activePacks: confirmed.facts.activePackCount,
          activeCollectibles: confirmed.facts.activeCollectibleCount,
          packContents: confirmed.facts.activePackContentCount,
          runningRuns: confirmed.facts.runningRunCount,
          activeImportLeases: confirmed.facts.activeImportLeaseCount,
          queuedRunsObserved: confirmed.facts.queuedRunCount,
        },
        publication: {
          providerRepackCount: artifacts.providerPlan.counts.repacks,
          providerCollectibleCount: artifacts.providerPlan.counts.collectibles,
          providerRepackChaseCount: artifacts.providerPlan.counts.repackChases,
          frontendRepackCount: artifacts.v3Plan.manifest.counts.repacks,
          plannedCurrentEvCount: localClutchpacksPlannedV3Rows(artifacts.v3Plan)
            .filter(({ evEstimates }) => evEstimates.packScout.status === "current").length,
          plannedUnavailableReasons: localClutchpacksPlannedV3Rows(artifacts.v3Plan)
            .reduce<Record<string, number>>((counts, { evEstimates }) => {
              const ev = evEstimates.packScout;
              if (ev.status === "unavailable") counts[ev.reason] = (counts[ev.reason] ?? 0) + 1;
              return counts;
            }, {}),
        },
      })}\n`);
      return;
    }
    const publicationResult = await withPublicationImportLease({
      port: publicationImportLeasePort({ gateway, organizationId: initial.facts.organizationId, providerId: initial.facts.providerId }),
      operation: async (expectedImportLease, assertLive) => {
        const revalidate = async () => {
          await assertLive();
          const current = await loadStableSnapshot({ databaseConfiguration, central: central.client, gateway, approvedPublicAssetOrigins, expectedImportLease });
          if (current.stabilityFingerprint !== initial.stabilityFingerprint) return refuse("CLUTCHPACKS_SNAPSHOT_CHANGED_DURING_PUBLICATION");
        };
        await revalidate();
        return withVerifiedLocalConvexPublicationAuthorityCleanup({
      install: async () => await failClosedPhase(
        "LOCAL_CONVEX_AUTHORITY_INSTALL_FAILED",
        async () => await installPublicationAuthorities({
          environment: local.childEnvironment,
          providerSecret,
          manifestSecret,
          v3Secret,
          originSetHash: artifacts.providerPlan.governingHashes.originSetHash,
        }),
      ),
      publish: async () => {
        const providerClient = new SignedConvexProviderReleasePublicationClient({
          baseUrl,
          keyId: PROVIDER_KEY_ID,
          secret: providerSecret,
        });
        const manifestClient = new SignedConvexCatalogManifestPublicationClient({
          baseUrl,
          keyId: MANIFEST_KEY_ID,
          secret: manifestSecret,
        });
        const providerHead = await failClosedPhase(
          "LOCAL_CONVEX_PROVIDER_PUBLICATION_FAILED",
          async () => await publishProvider({
            client: providerClient,
            manifestClient,
            artifacts,
            revalidate,
          }),
        );
        const activeManifest = await failClosedPhase(
          "LOCAL_CONVEX_MANIFEST_ACTIVATION_FAILED",
          async () => await activateManifest({
            client: manifestClient,
            artifacts,
            providerHead,
            queuedRunCount: confirmed.facts.queuedRunCount,
            revalidate,
          }),
        );
        // This is the local bridge for the current frontend contract. It may run
        // only after the provider manifest was read back as active.
        const exactActive = (await manifestClient.activeState()).receipt
          .details.activeState;
        if (
          exactActive.activeManifest?.publicReleaseId !==
            activeManifest.manifest.publicReleaseId ||
          exactActive.activeManifest.manifestFingerprint !==
            activeManifest.manifest.manifestFingerprint
        ) return refuse("LOCAL_CONVEX_ACTIVE_MANIFEST_NOT_OBSERVED");
        const v3Client = new SignedConvexDataReleaseV3PublicationClient({
          baseUrl,
          keyId: DATA_RELEASE_V3_KEY_ID,
          secret: v3Secret,
        });
        const v3State = await v3Client.activeState();
        let previousV3Rows: readonly LocalClutchpacksEvReadbackRow[] = [];
        if (v3State.activeRelease !== null) {
          const prior = await new ConvexHttpClient(local.publicUrl).query(
            api.publicRepacksV3.listPublicRepacksV3,
            { currentTime: Date.now(), pageSize: 50, filters: { availability: "all" } },
          );
          if (!prior.ok) return refuse("LOCAL_CONVEX_DATA_RELEASE_V3_SCOPE_CONFLICT");
          previousV3Rows = prior.data.rows;
          assertLocalClutchpacksV3Predecessor({
            state: v3State,
            publicReleaseId: prior.data.release.publicReleaseId,
            total: prior.data.range.total,
            rows: prior.data.rows,
            expectedPublicRepackIds: artifacts.projection.repacks.map(
              ({ publicRepackId }) => publicRepackId,
            ),
            expectedPublicVendorId: artifacts.projection.vendors[0]!.publicVendorId,
          });
        }
        const boundV3 = bindLocalClutchpacksV3Predecessor(v3Client, v3State);
        const v3Outcome = await failClosedPhase(
          "LOCAL_CONVEX_DATA_RELEASE_V3_PUBLICATION_FAILED",
          async () => await new DataReleaseV3ReleasePublisher(
            { ...boundV3,
              activate: async (request) => { await revalidate(); return boundV3.activate(request); },
            },
          )
            .publish(artifacts.v3Plan),
        );
        const finalSnapshot = await failClosedPhase(
          "CLUTCHPACKS_FINAL_SNAPSHOT_LOAD_FAILED",
          async () => await loadStableSnapshot({
            databaseConfiguration,
            central: central.client,
            gateway,
            approvedPublicAssetOrigins,
            expectedImportLease,
          }),
        );
        if (finalSnapshot.stabilityFingerprint !== initial.stabilityFingerprint) {
          return refuse("CLUTCHPACKS_SNAPSHOT_CHANGED_DURING_PUBLICATION");
        }
        const readback = await failClosedPhase(
          "LOCAL_CONVEX_PUBLIC_READBACK_FAILED",
          async () => await verifyPublicReads({
            convexUrl: local.publicUrl,
            expectedRepackIds: artifacts.projection.repacks
              .map(({ publicRepackId }) => publicRepackId),
            manifestPublicReleaseId: activeManifest.manifest.publicReleaseId,
            v3PublicReleaseId: artifacts.v3Plan.publicReleaseId,
            v3Plan: artifacts.v3Plan,
            previousV3Rows,
          }),
        );
        return {
          status: "ready",
          source: {
            providerKey: DISTRIBUTED_CLUTCHPACKS_PLATFORM_KEY,
            settledSequence:
              artifacts.providerPlan.providerCheckpoint.settledSequence,
            activePacks: finalSnapshot.facts.activePackCount,
            activeCollectibles: finalSnapshot.facts.activeCollectibleCount,
            publishedCollectibles: artifacts.providerPlan.counts.collectibles,
            publishedRepackChases: artifacts.providerPlan.counts.repackChases,
            queuedRunsObserved: finalSnapshot.facts.queuedRunCount,
          },
          convex: {
            clientUrl: local.publicUrl,
            siteUrl: baseUrl,
            providerReleaseId: artifacts.providerPlan.publicProviderReleaseId,
            activeManifestPublicReleaseId:
              activeManifest.manifest.publicReleaseId,
            frontendDataReleaseId: artifacts.v3Plan.publicReleaseId,
            frontendDataReleaseOutcome: v3Outcome.outcome,
            manifestRepackCount: readback.manifestRepackCount,
            frontendRepackCount: readback.v3RepackCount,
            frontendKnownEvCount: readback.knownEstimateCount,
            frontendAgedEvCount: readback.agedEstimateCount,
            dashboardOpportunityCount: readback.dashboardOpportunityCount,
          },
        };
      },
        });
      },
    });
    process.stdout.write(`${JSON.stringify(publicationResult)}\n`);
  } finally {
    providerSecret.fill(0);
    manifestSecret.fill(0);
    v3Secret.fill(0);
    key.bytes.fill(0);
    await gateway.close().catch(() => undefined);
    await central.close().catch(() => undefined);
  }
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMain) {
  const argumentsAfterScript = process.argv.slice(2);
  const checkOnly = argumentsAfterScript.length === 1 &&
    argumentsAfterScript[0] === "--check-only";
  const argumentsValid = argumentsAfterScript.length === 0 || checkOnly;
  const operation = argumentsValid
    ? promoteDistributedClutchpacksToLocalConvex({ checkOnly })
    : Promise.reject(
        new DistributedClutchpacksPublicationError("LOCAL_ARGUMENT_INVALID"),
      );
  operation.catch((error: unknown) => {
    const code = error instanceof DistributedClutchpacksPublicationError
      ? error.code
      : "LOCAL_CLUTCHPACKS_PROMOTION_FAILED";
    process.stderr.write(`${JSON.stringify({ status: "refused", code })}\n`);
    process.exitCode = 1;
  });
}

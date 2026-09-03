import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, open, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseEnvironment } from "dotenv";
import { z } from "zod";
import { approvedPublicCatalogConfigurationV1Schema, canonicalJson, publicHttpsOriginSchema,
  publicCategorySchema, publicCollectibleSchema, publicRepackDetailV3Schema, publicRepackChaseSchema,
  type ApprovedPublicCatalogConfigurationV1 } from "@packscout/contracts";
import { AesGcmProviderCredentialCipher, CipherProviderDatabaseCredentialResolver } from "@packscout/services";
import { CLUTCHPACKS_PRODUCTION_SCOPE, CLUTCHPACKS_PRODUCTION_TARGET, ClutchpacksProductionPublicationError,
  assertClutchpacksProductionBindings, clutchpacksProductionPublicationIntentSchema,
  parseClutchpacksProductionPublicationIntent, productionPublicationSha256,
  type ClutchpacksProductionOwnedImportLease, type ClutchpacksProductionLeasePort,
  type ClutchpacksProductionSourcePins } from "./clutchpacks-production-publication-policy.mts";
import type { buildClutchpacksProductionConfiguration, buildClutchpacksProductionPlan,
  ClutchpacksProductionCategoryEvidence, ClutchpacksProductionSnapshot } from "./clutchpacks-production-plan.mts";
import { publishClutchpacksProductionV3, clutchpacksProductionObservationOperationId } from "./clutchpacks-production-v3-publication.mts";
import type { assertClutchpacksProductionIdentityContinuity, assertClutchpacksProductionInventoryContinuity } from "./clutchpacks-production-identity-continuity.mts";
import type { openClutchpacksProductionConvexRuntime } from "./clutchpacks-production-convex-runtime.mts";
import type { verifyClutchpacksProductionPublicReadback } from "./clutchpacks-production-public-readback.mts";
import type { ClutchpacksProductionSourceSnapshot } from "./clutchpacks-production-source-reader.mts";

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const decimal = z.string().regex(/^(0|[1-9][0-9]{0,19})$/u);
const absolutePath = z.string().max(4096).refine(value => path.isAbsolute(value) && !/[\r\n\0]/u.test(value));
const pinnedFile = z.object({ path: absolutePath, sha256: hash }).strict();
const host = z.string().max(253).regex(/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.neon\.tech$/u);
export const clutchpacksProductionSourceConfigSchema = z.object({
  schemaVersion: z.literal("clutchpacks_production_source_config_v1"),
  frozenEnvironment: pinnedFile, centralHost: host, providerHost: host,
  scope: z.object({ organizationId: z.literal(CLUTCHPACKS_PRODUCTION_SCOPE.organizationId),
    providerId: z.literal(CLUTCHPACKS_PRODUCTION_SCOPE.providerId), providerKey: z.literal("clutchpacks"),
    operatorId: z.uuid(), configVersionId: z.literal(CLUTCHPACKS_PRODUCTION_SCOPE.configId),
    configVersionNumber: z.literal("4") }).strict(),
  expected: z.object({ routeDigest: hash, latestSucceededRunId: z.uuid(), checkpointHash: hash,
    stateGeneration: decimal, runtimeRowVersion: decimal }).strict(),
  baseline: pinnedFile, namespaceUuid: z.uuid(), identityProof: pinnedFile,
  approvedPublicAssetOrigins: z.array(publicHttpsOriginSchema).min(1).max(64)
    .refine(values => new Set(values).size === values.length),
}).strict().refine(value => value.centralHost !== value.providerHost);
export type ClutchpacksProductionSourceConfig = z.infer<typeof clutchpacksProductionSourceConfigSchema>;
const count = z.number().int().safe().nonnegative();
const batch = z.object({ batchIndex: count, batchHash: hash });
const planSchema = z.object({ classification: z.literal("publish"), publicReleaseId: z.uuid(), releaseFingerprint: hash,
  manifest: z.object({ methodVersion: z.literal("packscout-buyback-adjusted-ev-v1"),
    confidencePolicyVersion: z.literal("packscout-buyback-adjusted-ev-confidence-v1"),
    publicEvPolicyVersion: z.literal("packscout-public-ev-nonpositive-v1"), dataAsOf: z.string().datetime(), contentHash: hash,
    searchAlgorithmVersion: z.literal("repack_ev_search_v3"), counts: z.object({ categories: count.max(512),
      collectibles: count.max(20_000), repacks: count.max(1_000), chases: count.max(50_000), searchShards: count }).strict(),
    entityChainHashes: z.object({ categories: hash, collectibles: hash, repacks: hash, chases: hash }).strict(),
    topChaseCount: count, batchCount: count.max(2_000), batchChainHash: hash }).strict(),
  batches: z.array(z.discriminatedUnion("kind", [
    batch.extend({ kind: z.literal("categories"), records: z.array(publicCategorySchema).min(1).max(100) }).strict(),
    batch.extend({ kind: z.literal("collectibles"), records: z.array(publicCollectibleSchema).min(1).max(100) }).strict(),
    batch.extend({ kind: z.literal("repacks"), records: z.array(publicRepackDetailV3Schema).min(1).max(100) }).strict(),
    batch.extend({ kind: z.literal("chases"), records: z.array(publicRepackChaseSchema).min(1).max(100) }).strict(),
  ])).max(2_000),
}).strict();
const bundleBodySchema = z.object({ schemaVersion: z.literal("clutchpacks_production_bundle_v1"),
  sourceConfig: clutchpacksProductionSourceConfigSchema, sourceConfigSha256: hash,
  intent: clutchpacksProductionPublicationIntentSchema, approvedConfiguration: approvedPublicCatalogConfigurationV1Schema,
  plan: planSchema,
  productionInventory: z.unknown(), productionInventorySha256: hash,
}).strict();
const bundleSchema = bundleBodySchema.extend({ bundleSha256: hash }).strict();
type Bundle = z.infer<typeof bundleSchema>;
class ProductionCliError extends Error {
  constructor(readonly code: string) { super("ClutchPacks production command was refused safely."); }
}
const safeExternalFailures = new Set([
  "PRODUCTION_INTENT_INVALID", "PRODUCTION_REPLAY_CONFLICT", "PRODUCTION_SOURCE_CHANGED", "PRODUCTION_CONFIGURATION_CHANGED",
  "PRODUCTION_PLAN_CHANGED", "PRODUCTION_PREDECESSOR_CHANGED", "PRODUCTION_READBACK_MISMATCH", "PRODUCTION_SOURCE_NOT_QUIET",
  "PRODUCTION_IMPORT_LEASE_UNAVAILABLE", "PRODUCTION_IMPORT_LEASE_LOST", "PRODUCTION_IMPORT_LEASE_RELEASE_FAILED",
  "PRODUCTION_IMPORT_LEASE_ATTEMPT_PERSIST_FAILED", "PRODUCTION_IMPORT_LEASE_ACQUIRE_UNKNOWN", "PRODUCTION_PUBLICATION_FAILED",
  "PRODUCTION_BACKEND_NOT_READY", "PRODUCTION_PUBLIC_EV_INVALID", "PRODUCTION_OBSERVATION_INVALID",
  "PRODUCTION_VERIFICATION_FAILED_ROLLED_BACK", "PRODUCTION_VERIFICATION_RECOVERY_REQUIRED",
  "PRODUCTION_SOURCE_CATALOG_BOUND_OR_COUNT", "PRODUCTION_SOURCE_CATALOG_FIELD_INVALID", "PRODUCTION_SOURCE_CATALOG_URL_INVALID",
  "PRODUCTION_SOURCE_CATEGORY_OR_ALIAS_REFERENCE_INVALID", "PRODUCTION_SOURCE_AUTHORITY_INVALID", "PRODUCTION_SOURCE_CENTRAL_IDENTITY_INVALID",
  "PRODUCTION_SOURCE_CONFIGURATION_EXPIRED_OR_UNSUPPORTED", "PRODUCTION_SOURCE_CONFIGURATION_INVALID", "PRODUCTION_SOURCE_ROUTE_CHANGED",
  "PRODUCTION_SOURCE_AUTHORITY_CHANGED", "PRODUCTION_SOURCE_CATALOG_CHANGED", "PRODUCTION_SOURCE_CHANGED_DURING_READ",
  "PRODUCTION_SOURCE_CLOSED_OR_BUSY", "PRODUCTION_SOURCE_DATABASE_UNREACHABLE", "PRODUCTION_SOURCE_FULL_READ_REQUIRED",
  "PRODUCTION_SOURCE_IMPORT_LEASE_INVALID", "PRODUCTION_SOURCE_IMPORT_LEASE_NOT_ACQUIRED_HERE", "PRODUCTION_SOURCE_QUIET_BASELINE_CHANGED",
  "PRODUCTION_SOURCE_READ_UNAVAILABLE", "PRODUCTION_SOURCE_CACHED_CONFIGURATION_CHANGED", "PRODUCTION_SOURCE_CHECKPOINT_INVALID",
  "PRODUCTION_SOURCE_DATABASE_CLOCK_UNAVAILABLE", "PRODUCTION_SOURCE_HEAD_OR_RUNTIME_CHANGED", "PRODUCTION_SOURCE_IMPORT_LEASE_UNAVAILABLE",
  "PRODUCTION_SOURCE_PROVIDER_IDENTITY_INVALID", "PRODUCTION_SOURCE_RECONCILIATION_INVALID",
  "PRODUCTION_SOURCE_LEASE_CLEANUP_UNCONFIRMED",
  "CLUTCHPACKS_PRODUCTION_CONVEX_RUNTIME_INVALID", "CLUTCHPACKS_PRODUCTION_CONVEX_RUNTIME_UNAVAILABLE",
  "CLUTCHPACKS_PRODUCTION_IDENTITY_CONTINUITY_FAILED",
  "CLUTCHPACKS_PRODUCTION_CATALOG_INVALID", "CLUTCHPACKS_PRODUCTION_PUBLIC_READBACK_FAILED",
  "CLUTCHPACKS_PRODUCTION_CATEGORY_REFERENCE_INVALID", "CLUTCHPACKS_PRODUCTION_IDENTITY_INVENTORY_INVALID",
]);
function safeFailureCode(error: unknown, fallback = "PRODUCTION_CLI_FAILED"): string {
  if (error instanceof ProductionCliError || error instanceof ClutchpacksProductionPublicationError) return error.code;
  if (error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" && safeExternalFailures.has(error.code)) return error.code;
  if (error instanceof Error && safeExternalFailures.has(error.message)) return error.message;
  return fallback;
}
function refuse(code: string): never { throw new ProductionCliError(code); }
export function parseClutchpacksProductionSourceConfig(value: unknown): ClutchpacksProductionSourceConfig {
  const parsed = clutchpacksProductionSourceConfigSchema.safeParse(value);
  if (!parsed.success) return refuse("PRODUCTION_SOURCE_CONFIG_INVALID");
  return parsed.data;
}
const sha256Bytes = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
async function readBoundedFile(file: string, privateFile = false): Promise<Buffer> {
  if (!absolutePath.safeParse(file).success) return refuse("PRODUCTION_FILE_INVALID");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024 || stat.size < 1 ||
      (privateFile && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) return refuse("PRODUCTION_FILE_INVALID");
    const bytes = await handle.readFile();
    if (bytes.byteLength !== stat.size) return refuse("PRODUCTION_FILE_CHANGED");
    return bytes;
  } finally { await handle.close(); }
}
async function readPinnedFile(pin: z.infer<typeof pinnedFile>, privateFile = false) {
  const bytes = await readBoundedFile(pin.path, privateFile);
  if (sha256Bytes(bytes) !== pin.sha256) { bytes.fill(0); return refuse("PRODUCTION_FILE_DIGEST_CHANGED"); }
  return bytes;
}
function json(bytes: Buffer): unknown {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { return refuse("PRODUCTION_JSON_INVALID"); }
}
/** Complete bytes are fsynced before an exclusive hard link publishes the file.
 * Existing destinations and symlinks are never overwritten or chmodded. */
async function writePrivateExclusive(file: string, value: unknown): Promise<void> {
  if (!absolutePath.safeParse(file).success) return refuse("PRODUCTION_FILE_INVALID");
  const temporary = path.join(path.dirname(file), `.clutchpacks-publication-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${canonicalJson(value)}\n`, "utf8"); await handle.sync(); await handle.close();
    await link(temporary, file);
    const directory = await open(path.dirname(file), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await handle.close().catch(() => undefined); await unlink(temporary).catch(() => undefined); }
}
interface Projection {
  readonly snapshot: ClutchpacksProductionSnapshot;
  readonly categoryEvidence: ClutchpacksProductionCategoryEvidence;
  readonly sourcePins: ClutchpacksProductionSourcePins;
}
interface SourcePort {
  read(lease?: ClutchpacksProductionOwnedImportLease): Promise<unknown>;
  assertQuiet(lease?: ClutchpacksProductionOwnedImportLease): Promise<void>;
  readonly leasePort: ClutchpacksProductionLeasePort;
  close(): Promise<void>;
}
/** The reader deliberately rejects concurrent operations. This awaited queue
 * serializes ownership checks, renewals and full snapshots without racing a
 * still-running database callback or extending an invalid lease. */
export function serializeClutchpacksProductionSourcePort(source: SourcePort): SourcePort {
  let pending = Promise.resolve(); let closing: Promise<void> | undefined;
  const run = <T,>(operation: () => Promise<T>): Promise<T> => {
    if (closing) return Promise.reject(new ProductionCliError("PRODUCTION_SOURCE_CLOSED_OR_BUSY"));
    const result = pending.then(operation);
    pending = result.then(() => undefined, () => undefined);
    return result;
  };
  return { read: lease => run(() => source.read(lease)), assertQuiet: lease => run(() => source.assertQuiet(lease)),
    leasePort: { acquire: request => run(() => source.leasePort.acquire(request)),
      renew: request => run(() => source.leasePort.renew(request)), release: request => run(() => source.leasePort.release(request)) },
    close() { closing ??= pending.then(() => source.close()); return closing; } };
}
type ConvexRuntime = Awaited<ReturnType<typeof openClutchpacksProductionConvexRuntime>>;
export interface ClutchpacksProductionCliDependencies {
  readonly openSource: (config: ClutchpacksProductionSourceConfig, environment: Readonly<Record<string, string>>) => Promise<SourcePort>;
  readonly openConvex: (environment: NodeJS.ProcessEnv) => Promise<ConvexRuntime>;
  readonly projectSource: (source: unknown) => Projection;
  readonly buildConfiguration: typeof buildClutchpacksProductionConfiguration;
  readonly buildPlan: typeof buildClutchpacksProductionPlan;
  readonly verifyIdentity: typeof assertClutchpacksProductionIdentityContinuity;
  readonly readInventory: (environment: NodeJS.ProcessEnv) => Promise<unknown>;
  readonly verifyInventory: typeof assertClutchpacksProductionInventoryContinuity;
  readonly publish: typeof publishClutchpacksProductionV3;
  readonly verifyPublic: typeof verifyClutchpacksProductionPublicReadback;
  readonly now: () => string;
  readonly operationId: () => string;
  readonly healthNow: () => string;
}
/** Preserve the source's reported health; a completed import does not establish
 * healthy quality, and quarantines can never accompany a healthy claim. */
export function clutchpacksProductionSourcePinsFromObservation(source: Pick<ClutchpacksProductionSourceSnapshot,
  "sourceCheckpoint" | "sourceObservation" | "stabilityFingerprint">): ClutchpacksProductionSourcePins {
  const checkpoint = source.sourceCheckpoint;
  const pins = clutchpacksProductionPublicationIntentSchema.shape.source.safeParse({
    runId: checkpoint.runId, checkpointHash: checkpoint.checkpointHash,
    stateGeneration: String(checkpoint.stateGeneration), promotionSequence: String(checkpoint.promotionSequence),
    stabilityFingerprint: source.stabilityFingerprint, lastHeadReachedAt: source.sourceObservation.lastHeadReachedAt,
    qualityState: source.sourceObservation.qualityState, quarantineCount: source.sourceObservation.quarantineCount });
  if (!pins.success) return refuse("PRODUCTION_SOURCE_CHECKPOINT_INVALID");
  return pins.data;
}
function productionScope(config: ClutchpacksProductionSourceConfig) {
  return { organizationId: config.scope.organizationId, providerId: config.scope.providerId, providerKey: config.scope.providerKey,
    configId: config.scope.configVersionId, configVersion: config.scope.configVersionNumber };
}
function assertSourceConfigPins(config: ClutchpacksProductionSourceConfig, projection: Projection) {
  const pins = projection.sourcePins;
  if (pins.runId !== config.expected.latestSucceededRunId || pins.checkpointHash !== config.expected.checkpointHash ||
    pins.stateGeneration !== config.expected.stateGeneration) return refuse("PRODUCTION_SOURCE_CHANGED");
}
function observationFor(intent: Bundle["intent"], configuration: ApprovedPublicCatalogConfigurationV1, observedAt: string) {
  if (!Number.isFinite(Date.parse(observedAt)) || new Date(observedAt).toISOString() !== observedAt) return refuse("PRODUCTION_OBSERVATION_INVALID");
  const operationId = clutchpacksProductionObservationOperationId(intent, observedAt);
  const freshThrough = new Date(Math.min(Date.parse(observedAt) + 86_400_000,
    Date.parse(intent.source.lastHeadReachedAt) + configuration.staleAfterSeconds * 1_000)).toISOString();
  if (observedAt < intent.source.lastHeadReachedAt || freshThrough <= observedAt) {
    return refuse("PRODUCTION_SOURCE_HEAD_STALE");
  }
  return { schemaVersion: "data_release_v3" as const, operationId, idempotencyKey: operationId,
    publicReleaseId: intent.candidate.publicReleaseId, releaseFingerprint: intent.candidate.releaseFingerprint,
    publicVendorId: configuration.platforms[0]!.vendor.publicVendorId, vendorKey: "clutchpacks",
    observationSequence: Date.parse(observedAt), observedAt, freshThrough,
    lastHeadReachedAt: intent.source.lastHeadReachedAt, sourceHeadSequence: intent.source.promotionSequence,
    settledSequence: intent.source.promotionSequence, sourceLifecycle: "active" as const,
    connectionState: "healthy" as const, qualityState: intent.source.qualityState, releaseAlignment: "aligned" as const };
}
async function artifacts(config: ClutchpacksProductionSourceConfig) {
  const baseline = approvedPublicCatalogConfigurationV1Schema.parse(json(await readPinnedFile(config.baseline)));
  const proof = json(await readPinnedFile(config.identityProof));
  if (proof === null || typeof proof !== "object" || !("baseline" in proof) ||
    (proof.baseline as { rawSha256?: unknown })?.rawSha256 !== config.baseline.sha256) return refuse("PRODUCTION_IDENTITY_PROOF_INVALID");
  return { baseline, proof };
}
async function withRuntime<T>(config: ClutchpacksProductionSourceConfig, environment: NodeJS.ProcessEnv,
  deps: ClutchpacksProductionCliDependencies, operation: (source: SourcePort, convex: ConvexRuntime) => Promise<T>): Promise<T> {
  const bytes = await readPinnedFile(config.frozenEnvironment, true);
  const sourceEnvironment = parseEnvironment(bytes); bytes.fill(0);
  let source: SourcePort | undefined; let convex: ConvexRuntime | undefined;
  try {
    source = serializeClutchpacksProductionSourcePort(await deps.openSource(config, sourceEnvironment));
    convex = await deps.openConvex(environment);
    return await operation(source, convex);
  } finally {
    const results = await Promise.allSettled([source?.close(), Promise.resolve().then(() => convex?.close())]);
    for (const key of Object.keys(sourceEnvironment)) delete sourceEnvironment[key];
    if (results.some(result => result.status === "rejected")) refuse("PRODUCTION_RUNTIME_CLOSE_FAILED");
  }
}
function parseBundle(value: unknown): Bundle {
  const parsed = bundleSchema.safeParse(value);
  if (!parsed.success) return refuse("PRODUCTION_BUNDLE_INVALID");
  const { bundleSha256, ...body } = parsed.data;
  if (productionPublicationSha256(body) !== bundleSha256 || productionPublicationSha256(body.sourceConfig) !== body.sourceConfigSha256 ||
    productionPublicationSha256(body.approvedConfiguration) !== body.intent.approvedConfigurationSha256 ||
    productionPublicationSha256(body.plan) !== body.intent.candidate.planSha256 ||
    productionPublicationSha256(body.productionInventory) !== body.productionInventorySha256) {
    return refuse("PRODUCTION_BUNDLE_DIGEST_CHANGED");
  }
  return parsed.data;
}
export async function runClutchpacksProductionCli(args: readonly string[], environment: NodeJS.ProcessEnv,
  dependencies?: ClutchpacksProductionCliDependencies) {
  try {
    if (environment.NODE_ENV !== "production") return refuse("PRODUCTION_ENVIRONMENT_REQUIRED");
    if (!((args[0] === "--prepare" && args.length === 3) || (args[0] === "--publish" && args.length === 2))) {
      return refuse("PRODUCTION_ARGUMENTS_INVALID");
    }
    const deps = dependencies ?? await defaultDependencies();
    if (args[0] === "--prepare") {
      const config = parseClutchpacksProductionSourceConfig(json(await readBoundedFile(args[1]!)));
      const { baseline, proof } = await artifacts(config);
      const body = await withRuntime(config, environment, deps, async (source, convex) => {
        const projection = deps.projectSource(await source.read()); assertSourceConfigPins(config, projection);
        await source.assertQuiet();
        const readAt = deps.now();
        const configuration = deps.buildConfiguration({ baseline, namespaceUuid: config.namespaceUuid,
          snapshot: projection.snapshot, categoryEvidence: projection.categoryEvidence, approvedAt: readAt });
        deps.verifyIdentity({ proof, namespaceUuid: config.namespaceUuid, baseline, configuration });
        const plan = await deps.buildPlan({ snapshot: projection.snapshot, configuration,
          categoryEvidence: projection.categoryEvidence, readAt });
        const inventory = await deps.readInventory(environment);
        const state = await convex.publication.activeState();
        const intent = parseClutchpacksProductionPublicationIntent({ schemaVersion: "clutchpacks_production_publication_v1",
          operationId: deps.operationId(), target: CLUTCHPACKS_PRODUCTION_TARGET, scope: productionScope(config), readAt,
          source: projection.sourcePins, approvedConfigurationSha256: productionPublicationSha256(configuration),
          candidate: { publicReleaseId: plan.publicReleaseId, releaseFingerprint: plan.releaseFingerprint, planSha256: productionPublicationSha256(plan) },
          predecessor: { generation: state.generation, publicReleaseId: state.activeRelease?.publicReleaseId ?? null,
            releaseFingerprint: state.activeRelease?.releaseFingerprint ?? null } });
        assertClutchpacksProductionBindings(intent, { scope: productionScope(config), source: projection.sourcePins,
          approvedConfiguration: configuration, plan, activeState: state });
        deps.verifyInventory({ inventory, configuration, predecessor: intent.predecessor });
        await source.assertQuiet();
        return { schemaVersion: "clutchpacks_production_bundle_v1" as const, sourceConfig: config,
          sourceConfigSha256: productionPublicationSha256(config), intent, approvedConfiguration: configuration, plan,
          productionInventory: inventory, productionInventorySha256: productionPublicationSha256(inventory) };
      });
      const bundle = parseBundle({ ...body, bundleSha256: productionPublicationSha256(body) });
      await writePrivateExclusive(args[2]!, bundle);
      return { status: "prepared", bundlePath: args[2], bundleSha256: bundle.bundleSha256,
        operationId: bundle.intent.operationId, publicReleaseId: bundle.intent.candidate.publicReleaseId,
        readAt: bundle.intent.readAt, qualityState: bundle.intent.source.qualityState, quarantineCount: bundle.intent.source.quarantineCount };
    }
    const bundle = parseBundle(json(await readBoundedFile(args[1]!, true)));
    const { baseline, proof } = await artifacts(bundle.sourceConfig);
    deps.verifyIdentity({ proof, namespaceUuid: bundle.sourceConfig.namespaceUuid, baseline, configuration: bundle.approvedConfiguration });
    deps.verifyInventory({ inventory: bundle.productionInventory, configuration: bundle.approvedConfiguration, predecessor: bundle.intent.predecessor });
    // Health is evaluated now, independently of the frozen EV calculation clock.
    observationFor(bundle.intent, bundle.approvedConfiguration, deps.healthNow());
    const result = await withRuntime(bundle.sourceConfig, environment, deps, async (source, convex) => {
      const readSource = async (lease?: ClutchpacksProductionOwnedImportLease) => {
        const projection = deps.projectSource(await source.read(lease)); assertSourceConfigPins(bundle.sourceConfig, projection);
        return { scope: productionScope(bundle.sourceConfig), source: projection.sourcePins };
      };
      return deps.publish({ intent: bundle.intent, approvedConfiguration: bundle.approvedConfiguration,
        plan: bundle.plan, client: convex.publication, readSource,
        leasePort: source.leasePort, assertSourceQuiet: lease => source.assertQuiet(lease),
        prepareLeaseAttempt: async attempt => {
          await writePrivateExclusive(`${args[1]}.lease.${attempt.attemptId}.json`, {
            schemaVersion: "clutchpacks_production_lease_attempt_v1", bundleSha256: bundle.bundleSha256, ...attempt });
        },
        prepareObservation: async () => {
          const request = observationFor(bundle.intent, bundle.approvedConfiguration, deps.healthNow());
          const requestSha256 = productionPublicationSha256(request);
          const attemptPath = `${args[1]}.observation.${request.observationSequence}.json`;
          await writePrivateExclusive(attemptPath, { schemaVersion: "clutchpacks_production_observation_attempt_v1",
            bundleSha256: bundle.bundleSha256, intentSha256: productionPublicationSha256(bundle.intent), request, requestSha256 });
          return { request, requestSha256 };
        },
        verifyPublic: input => deps.verifyPublic({ ...input, client: convex.publication,
          publicClient: convex.publicClient, catalogReadToken: convex.catalogReadToken }) });
    });
    const receiptPath = `${args[1]}.receipt.${randomUUID()}.json`;
    await writePrivateExclusive(receiptPath, { ...result, bundleSha256: bundle.bundleSha256 });
    return { status: "verified", receiptPath, bundleSha256: bundle.bundleSha256, operationId: bundle.intent.operationId,
      publicReleaseId: bundle.intent.candidate.publicReleaseId, qualityState: result.source.qualityState,
      quarantineCount: result.source.quarantineCount };
  } catch (error) {
    return refuse(safeFailureCode(error));
  }
}

async function defaultDependencies(): Promise<ClutchpacksProductionCliDependencies> {
  const { buildClutchpacksProductionConfiguration, buildClutchpacksProductionPlan } = await import("./clutchpacks-production-plan.mts");
  const { assertClutchpacksProductionIdentityContinuity, assertClutchpacksProductionInventoryContinuity } = await import("./clutchpacks-production-identity-continuity.mts");
  const { openClutchpacksProductionConvexRuntime } = await import("./clutchpacks-production-convex-runtime.mts");
  const { verifyClutchpacksProductionPublicReadback } = await import("./clutchpacks-production-public-readback.mts");
  const { readClutchpacksProductionIdentityInventory } = await import("./clutchpacks-production-identity-inventory.mts");
  const { createClutchpacksProductionSourceReader } = await import("./clutchpacks-production-source-reader.mts");
  const { clutchpacksProductionSourceProjection } = await import("./clutchpacks-production-source-projection.mts");
  type SourceRead = Awaited<ReturnType<ReturnType<typeof createClutchpacksProductionSourceReader>["read"]>>;
  return {
    async openSource(config, environment) {
      const encoded = environment.PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64;
      const encodedVersion = environment.PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION;
      const centralDatabaseUrl = environment.PACKSCOUT_CENTRAL_DATABASE_URL;
      const version = Number(encodedVersion);
      if (!encoded || !encodedVersion || !/^[1-9][0-9]{0,9}$/u.test(encodedVersion) || !Number.isSafeInteger(version) ||
        version > 2_147_483_647 || !centralDatabaseUrl) return refuse("PRODUCTION_SOURCE_ENVIRONMENT_INVALID");
      const key = Buffer.from(encoded, "base64");
      if (key.byteLength !== 32 || key.toString("base64") !== encoded) { key.fill(0); return refuse("PRODUCTION_SOURCE_ENVIRONMENT_INVALID"); }
      try {
        const cipher = new AesGcmProviderCredentialCipher({ primaryVersion: version, keys: new Map([[version, key]]) });
        const reader = createClutchpacksProductionSourceReader({ centralDatabaseUrl, centralHost: config.centralHost,
          providerHost: config.providerHost, credentialResolver: new CipherProviderDatabaseCredentialResolver(cipher),
          scope: { ...config.scope, configVersionNumber: BigInt(config.scope.configVersionNumber) },
          expected: { ...config.expected, stateGeneration: BigInt(config.expected.stateGeneration),
            runtimeRowVersion: BigInt(config.expected.runtimeRowVersion) }, approvedPublicAssetOrigins: config.approvedPublicAssetOrigins });
        return { read: lease => reader.read({ expectedImportLease: lease }),
          assertQuiet: async lease => { await reader.assertQuiet({ expectedImportLease: lease }); }, leasePort: reader.leasePort,
          async close() { try { await reader.close(); } finally { key.fill(0); } } };
      } catch (error) { key.fill(0); return refuse(safeFailureCode(error, "PRODUCTION_SOURCE_ENVIRONMENT_INVALID")); }
    },
    projectSource(raw) {
      const source = raw as SourceRead;
      return { ...clutchpacksProductionSourceProjection(source), sourcePins: clutchpacksProductionSourcePinsFromObservation(source) };
    },
    openConvex: openClutchpacksProductionConvexRuntime, buildConfiguration: buildClutchpacksProductionConfiguration,
    buildPlan: buildClutchpacksProductionPlan, verifyIdentity: assertClutchpacksProductionIdentityContinuity,
    readInventory: readClutchpacksProductionIdentityInventory, verifyInventory: assertClutchpacksProductionInventoryContinuity,
    publish: publishClutchpacksProductionV3, verifyPublic: verifyClutchpacksProductionPublicReadback,
    now: () => new Date().toISOString(), healthNow: () => new Date().toISOString(), operationId: randomUUID,
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runClutchpacksProductionCli(process.argv.slice(2), process.env).then(
    result => process.stdout.write(`${JSON.stringify(result)}\n`),
    error => { process.stderr.write(`${JSON.stringify({ status: "refused", code: error instanceof ProductionCliError ? error.code : "PRODUCTION_CLI_FAILED" })}\n`); process.exitCode = 1; },
  );
}

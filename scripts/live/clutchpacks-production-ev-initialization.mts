import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { canonicalJson, acceptedRepackQuerySchema, contextualRepackFacetsSchema,
  publicOpaqueCursorSchema, publicRepackListPageV3Schema, repackPageRangeSchema } from "@packscout/contracts";
import { migrateLocalConvexEv, type LocalEvMigrationClient } from "../local/local-convex-ev-migration.mts";

// Temporary production migration for the approved pre-feature V3 shape. The
// backend owns all fact derivation and atomic initialization. Remove this entry
// point with the legacy reader after every supported head has been initialized.
export const EV_INITIALIZATION_TARGET = "shiny-newt-310";
export const EV_INITIALIZATION_URL = "https://shiny-newt-310.convex.cloud";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const publicReadSchema = publicRepackListPageV3Schema.safeExtend({
  facets: contextualRepackFacetsSchema, activeQuery: acceptedRepackQuerySchema,
  queryFingerprint: hashSchema, nextCursor: publicOpaqueCursorSchema.nullable(),
  hasPrevious: z.boolean(), range: repackPageRangeSchema,
  paginationReset: z.literal("release_changed").nullable(),
});
const manifestSchema = z.object({
  schemaVersion: z.literal("clutchpacks-production-ev-initialization-v1"),
  deployment: z.literal(EV_INITIALIZATION_TARGET),
  convexUrl: z.literal(EV_INITIALIZATION_URL),
  expectedGeneration: z.number().int().min(1),
  expectedActivePublicReleaseId: z.uuid(),
  expectedActiveReleaseFingerprint: hashSchema,
  expectedPreviousPublicReleaseId: z.uuid().nullable(),
  expectedPreviousReleaseFingerprint: hashSchema.nullable(),
  immutableCatalogProofSha256: hashSchema,
}).strict();
type Manifest = z.infer<typeof manifestSchema>;
type ObjectValue = Record<string, unknown>;
type Operation = "state" | "progress" | "page" | "initialize";
type Mode = "inspect" | "check-only" | "apply";
export interface ProductionEvInitializationPort extends LocalEvMigrationClient {
  inspectPublication(): Promise<unknown>;
}

function refuse(code = "PRODUCTION_EV_INITIALIZATION_INVALID"): never { throw new Error(code); }
function object(value: unknown): ObjectValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return refuse();
  return value as ObjectValue;
}
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const operations = {
  state: "dataReleaseV3EvMigrationState:migrationState",
  progress: "dataReleaseV3EvFactsBackfill:progress",
  page: "dataReleaseV3EvFactsBackfill:backfillActiveReleaseEvFacts",
  initialize: "dataReleaseV3EvFactsBackfill:initializeActiveRetention",
} as const;

// Read-only, bounded metadata. No user records, raw pack payloads, signing keys,
// nonce writes, or retained-EV HTTP endpoints are involved in inspection.
export const EV_INITIALIZATION_PUBLICATION_QUERY = `
const state=await ctx.db.query("activeDataReleaseV3State").withIndex("by_key",q=>q.eq("key","singleton")).unique();
if(!state?.activeRelease)return null;
const operation=state.terminalOperationId?await ctx.db.query("dataReleaseV3Operations").withIndex("by_operation_id",q=>q.eq("operationId",state.terminalOperationId)).unique():null;
const receipt=operation?JSON.parse(operation.receiptJson):null;
const catalog=await ctx.db.query("activeCatalogManifestState").withIndex("by_key",q=>q.eq("key","singleton")).unique();
const activeManifest=catalog?.activeManifestId?await ctx.db.get("globalCatalogManifests",catalog.activeManifestId):null;
const staging=await ctx.db.query("dataReleaseV3Releases").withIndex("by_lifecycle",q=>q.eq("lifecycle","staging")).take(1);
return {generation:state.generation,activeRelease:state.activeRelease,previousRelease:state.previousRelease,
 terminalOperation:operation?{operationId:operation.operationId,kind:operation.kind,status:operation.status,result:operation.result,publicReleaseId:operation.publicReleaseId,receiptDigest:operation.receiptDigest,receiptDetails:receipt?.details}:null,
 catalog:catalog?{generation:catalog.generation,activeManifest:catalog.activeManifest,previousManifest:catalog.previousManifest,terminalOperationId:catalog.terminalOperationId,terminalReceiptSha256:catalog.terminalReceiptSha256}:null,
 catalogCoherent:catalog===null||(catalog.activeManifestId===null?catalog.activeManifest===null:activeManifest?.lifecycle==="complete"&&activeManifest.publicReleaseId===catalog.activeManifest?.publicReleaseId&&activeManifest.manifestFingerprint===catalog.activeManifest?.manifestFingerprint),
 stagingReleasePresent:staging.length!==0};`;

function inspectManifest(stateValue: unknown, publicationValue: unknown): Manifest {
  const state = object(stateValue);
  const publication = object(publicationValue);
  const active = object(state.activeRelease);
  const previous = state.previousRelease === null ? null : object(state.previousRelease);
  const operation = object(publication.terminalOperation);
  const receipt = object(operation.receiptDetails);
  if (typeof state.initialized !== "boolean" || object(active.counts).repacks !== 17 ||
      state.expectedActivePublicReleaseId !== active.publicReleaseId ||
      state.expectedPreviousPublicReleaseId !== (previous?.publicReleaseId ?? null) ||
      publication.stagingReleasePresent !== false || publication.catalogCoherent !== true ||
      publication.generation !== state.expectedGeneration ||
      canonicalJson(publication.activeRelease) !== canonicalJson(active) ||
      canonicalJson(publication.previousRelease) !== canonicalJson(previous) ||
      operation.kind !== "activate" || operation.status !== "completed" || operation.result !== "activated" ||
      operation.publicReleaseId !== active.publicReleaseId ||
      typeof operation.operationId !== "string" || !hashSchema.safeParse(operation.receiptDigest).success ||
      receipt.generation !== state.expectedGeneration ||
      canonicalJson(receipt.activeRelease) !== canonicalJson(active) ||
      canonicalJson(receipt.previousRelease) !== canonicalJson(previous)) {
    return refuse("PRODUCTION_EV_INITIALIZATION_PUBLICATION_CONFLICT");
  }
  const parsed = manifestSchema.safeParse({
    schemaVersion: "clutchpacks-production-ev-initialization-v1",
    deployment: EV_INITIALIZATION_TARGET, convexUrl: EV_INITIALIZATION_URL,
    expectedGeneration: state.expectedGeneration,
    expectedActivePublicReleaseId: active.publicReleaseId,
    expectedActiveReleaseFingerprint: active.releaseFingerprint,
    expectedPreviousPublicReleaseId: previous?.publicReleaseId ?? null,
    expectedPreviousReleaseFingerprint: previous?.releaseFingerprint ?? null,
    immutableCatalogProofSha256: digest(publication),
  });
  if (!parsed.success) return refuse();
  return parsed.data;
}

/** Inspect/check never invoke mutations. Apply rechecks the reviewed proof before
 * every bounded CAS page and initialization, then verifies the immutable catalog
 * again. Concurrent publication must be drained; any observed drift fails closed. */
export async function initializeProductionEv(port: ProductionEvInitializationPort,
  options: { mode: Mode; manifest?: unknown }) {
  if (!["inspect", "check-only", "apply"].includes(options.mode)) return refuse();
  const supplied = options.mode === "inspect" ? null : manifestSchema.safeParse(options.manifest);
  if (supplied !== null && !supplied.success) return refuse();
  const initialState = await port.call("state", {});
  const manifest = inspectManifest(initialState, await port.inspectPublication());
  if (supplied?.success && canonicalJson(supplied.data) !== canonicalJson(manifest)) {
    return refuse("PRODUCTION_EV_INITIALIZATION_MANIFEST_CHANGED");
  }
  await port.verifyPublicRead(manifest.expectedActivePublicReleaseId);
  const requireUnchanged = async () => {
    const state = await port.call("state", {});
    const current = inspectManifest(state, await port.inspectPublication());
    if (canonicalJson(current) !== canonicalJson(manifest)) return refuse("PRODUCTION_EV_INITIALIZATION_MANIFEST_CHANGED");
    return state;
  };
  const checked = await requireUnchanged();
  if (options.mode === "inspect") return { status: object(checked).initialized ? "ready" : "migration_required", manifest };
  const guarded: LocalEvMigrationClient = {
    async call(operation, args) {
      if (operation === "state") return await requireUnchanged();
      if (operation === "page" || operation === "initialize") {
        if (options.mode !== "apply") return refuse();
        await requireUnchanged();
      }
      return await port.call(operation, args);
    },
    verifyPublicRead: (id) => port.verifyPublicRead(id),
  };
  const result = await migrateLocalConvexEv(guarded, { checkOnly: options.mode !== "apply" });
  await requireUnchanged();
  return { ...result, manifest };
}

interface Dependencies {
  readonly run?: (file: string, args: readonly string[], options: {
    cwd: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number;
  }) => Promise<{ stdout: string }>;
  readonly fetch?: typeof fetch;
  readonly readUtf8?: (file: string) => Promise<string>;
}

async function boundedText(response: Response, limit: number): Promise<string> {
  if (!response.ok || response.redirected || response.body === null) return refuse();
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let result = "", bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) { await reader.cancel(); return refuse(); }
      result += decoder.decode(chunk.value, { stream: true });
    }
    return result + decoder.decode();
  } finally { reader.releaseLock(); }
}

/** Existing CLI login only. /dev/null prevents deferred .env/.env.local auth
 * loading, and the fully named 1.43.0 selector precedes target env resolution.
 * Credentials are neither retrieved nor put in argv. No deploy/push is exposed. */
export async function createProductionEvInitializationPort(environment: NodeJS.ProcessEnv,
  dependencies: Dependencies = {}): Promise<ProductionEvInitializationPort> {
  const forbidden = ["CONVEX_DEPLOY_KEY", "CONVEX_DEPLOYMENT", "CONVEX_DEPLOYMENT_TOKEN",
    "CONVEX_SELF_HOSTED_URL", "CONVEX_SELF_HOSTED_ADMIN_KEY", "CONVEX_OVERRIDE_ACCESS_TOKEN"];
  if (environment.NODE_ENV !== "production" || forbidden.some((key) => environment[key] !== undefined) ||
      (environment.CONVEX_URL !== undefined && environment.CONVEX_URL !== EV_INITIALIZATION_URL)) return refuse();
  const token = environment.PACKSCOUT_CATALOG_READ_TOKEN;
  if (typeof token !== "string" || !/^[\x21-\x7e]{32,512}$/u.test(token)) return refuse();
  const read = dependencies.readUtf8 ?? ((file: string) => readFile(file, "utf8"));
  const installed = object(JSON.parse(await read(path.join(projectRoot, "node_modules/convex/package.json"))));
  if (installed.version !== "1.43.0") return refuse("PRODUCTION_EV_INITIALIZATION_CLI_VERSION_INVALID");
  const run = dependencies.run ?? ((file, args, options) => promisify(execFile)(file, [...args], options));
  const request = dependencies.fetch ?? fetch;
  const childEnvironment = { ...environment };
  delete childEnvironment.PACKSCOUT_CATALOG_READ_TOKEN;
  const settings = () => ({ redirect: "error" as const, credentials: "omit" as const,
    cache: "no-store" as const, signal: AbortSignal.timeout(30_000) });
  const requireTarget = async () => {
    const response = await request(`${EV_INITIALIZATION_URL}/instance_name`, { ...settings(), method: "GET" });
    if (await boundedText(response, 256) !== EV_INITIALIZATION_TARGET) return refuse();
  };
  const callCli = async (tail: string[]) => {
    try {
      await requireTarget();
      const result = await run(process.execPath, [path.join(projectRoot, "node_modules/convex/bin/main.js"),
        "run", "--env-file", "/dev/null", "--deployment", EV_INITIALIZATION_TARGET, "--codegen", "disable", ...tail],
      { cwd: projectRoot, env: childEnvironment, timeout: 45_000, maxBuffer: 256 * 1_024 });
      return JSON.parse(result.stdout) as unknown;
    } catch { return refuse("PRODUCTION_EV_INITIALIZATION_REQUEST_FAILED"); }
  };
  return {
    inspectPublication: () => callCli(["--inline-query", EV_INITIALIZATION_PUBLICATION_QUERY]),
    async call(operation: Operation, args) {
      if (!Object.hasOwn(operations, operation)) return refuse();
      return await callCli([operations[operation], canonicalJson(args)]);
    },
    async verifyPublicRead(publicReleaseId) {
      try {
        await requireTarget();
        const response = await request(`${EV_INITIALIZATION_URL}/api/action`, {
          ...settings(), method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: "publicRepacksV3:listPublicRepacksV3", format: "json",
            args: { pageSize: 50, filters: { availability: "all" }, catalogReadToken: token } }),
        });
        const envelope = object(JSON.parse(await boundedText(response, 4 * 1_024 * 1_024)));
        if (envelope.status !== "success") return refuse();
        const value = object(envelope.value);
        const result = publicReadSchema.safeParse(value.data);
        if (value.ok !== true || !result.success) return refuse();
        const page = result.data;
        if (page.release.publicReleaseId !== publicReleaseId || page.rows.length !== 17 || page.range.total !== 17 ||
            page.range.start !== 1 || page.range.end !== 17 || page.activeQuery.pageSize !== 50 ||
            page.activeQuery.filters.availability !== "all" || page.activeQuery.search !== "" ||
            page.activeQuery.desiredPublicCollectibleId !== null ||
            page.rows.some((row) => row.vendorKey !== "clutchpacks") ||
            new Set(page.rows.map((row) => row.publicRepackId)).size !== 17 ||
            page.nextCursor !== null || page.hasPrevious || page.paginationReset !== null ||
            page.confidenceEvaluatedAt !== page.providerHealthEvaluatedAt) return refuse();
      } catch { return refuse("PRODUCTION_EV_INITIALIZATION_PUBLIC_READ_FAILED"); }
    },
  };
}

export async function runProductionEvInitialization(args: string[], environment = process.env) {
  const mode = args[0]?.replace(/^--/u, "") as Mode;
  if ((mode === "inspect" && args.length !== 1) ||
      (["check-only", "apply"].includes(mode) && args.length !== 2) ||
      !["inspect", "check-only", "apply"].includes(mode)) return refuse();
  let manifest: unknown;
  if (mode !== "inspect") {
    const file = path.resolve(args[1]!);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384 || (stat.mode & 0o022) !== 0) return refuse();
    manifest = JSON.parse(await readFile(file, "utf8"));
  }
  return await initializeProductionEv(await createProductionEvInitializationPort(environment), { mode, manifest });
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runProductionEvInitialization(process.argv.slice(2)).then((result) => {
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === "ready" ? 0 : 2;
  }).catch(() => {
    console.error("PRODUCTION_EV_INITIALIZATION_FAILED");
    process.exitCode = 1;
  });
}

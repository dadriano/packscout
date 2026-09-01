import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { canonicalJson, PACKSCOUT_BUYBACK_EV_METHOD_VERSION, PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3, publicCategorySchema, publicCollectibleIdSchema,
  publicRepackIdSchema, publicVendorIdSchema, publicHttpsUrlSchema } from "@packscout/contracts";
import { CLUTCHPACKS_PRODUCTION_TARGET, productionPublicationSha256 } from "./clutchpacks-production-publication-policy.mts";

const DEPLOYMENT = "shiny-newt-310";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const count = z.number().int().safe().nonnegative();
const counts = z.object({ categories: count.max(512), collectibles: count.max(20_000), repacks: count.max(1_000),
  chases: count.max(50_000), searchShards: count.max(32) }).strict();
const pointer = z.object({ publicReleaseId: z.uuid(), releaseFingerprint: hash,
  methodVersion: z.literal(PACKSCOUT_BUYBACK_EV_METHOD_VERSION),
  confidencePolicyVersion: z.literal(PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION),
  publicEvPolicyVersion: z.literal(PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3),
  dataAsOf: z.iso.datetime(), completedAt: z.iso.datetime(), counts }).strict();
const activeStateSchema = z.object({ generation: count.positive(), activeRelease: pointer }).strict();
const stateSchema = z.object({ activeState: activeStateSchema, acceptedCounts: counts,
  complete: z.literal(true) }).strict();
const pinsSchema = z.object({ generation: count.positive(), publicReleaseId: z.uuid(), releaseFingerprint: hash }).strict();
const repackSchema = z.object({ publicRepackId: publicRepackIdSchema, publicVendorId: publicVendorIdSchema,
  vendorKey: z.literal("clutchpacks"), listingUrl: publicHttpsUrlSchema.nullable() }).strict();
const bodySchema = z.object({ schemaVersion: z.literal("clutchpacks-production-identity-inventory-v1"),
  activeState: activeStateSchema, publicRepackIds: z.array(publicRepackIdSchema).max(1_000),
  publicCollectibleIds: z.array(publicCollectibleIdSchema).max(20_000),
  categories: z.array(publicCategorySchema).max(512), repacks: z.array(repackSchema).max(1_000) }).strict();
export const clutchpacksProductionIdentityInventorySchema = bodySchema.extend({ digest: hash }).strict();
export type ClutchpacksProductionIdentityInventory = z.infer<typeof clutchpacksProductionIdentityInventorySchema>;
type Pins = z.infer<typeof pinsSchema>;
type Kind = "collectibles" | "repacks" | "categories";
export interface ClutchpacksProductionIdentityInventoryPort {
  readState(): Promise<unknown>;
  readPage(kind: Kind, afterId: string | null, pins: Pins): Promise<unknown>;
}
function refuse(): never { throw new Error("CLUTCHPACKS_PRODUCTION_IDENTITY_INVENTORY_INVALID"); }
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function state(value: unknown) {
  const parsed = stateSchema.safeParse(value);
  if (!parsed.success || !same(parsed.data.acceptedCounts, parsed.data.activeState.activeRelease.counts)) return refuse();
  return parsed.data;
}
function ordered(ids: readonly string[], previous: string | null = null) {
  return ids.every((id, index) => (index === 0 ? previous === null || previous < id : ids[index - 1]! < id));
}

/** Each page is independently bound to the same current predecessor. Only public
 * identity strings, approved category details and public pack URL references leave
 * Convex. No source payload, description, account or collectible detail is emitted. */
export async function captureClutchpacksProductionIdentityInventory(port: ClutchpacksProductionIdentityInventoryPort):
  Promise<ClutchpacksProductionIdentityInventory> {
  const initial = state(await port.readState());
  const active = initial.activeState.activeRelease;
  const pins: Pins = { generation: initial.activeState.generation,
    publicReleaseId: active.publicReleaseId, releaseFingerprint: active.releaseFingerprint };
  const categories: z.infer<typeof publicCategorySchema>[] = [];
  const repacks: z.infer<typeof repackSchema>[] = [];
  const publicCollectibleIds: string[] = [];
  for (const kind of ["categories", "repacks", "collectibles"] as const) {
    let cursor: string | null = null, total = 0;
    const expected = initial.acceptedCounts[kind];
    const limit = kind === "collectibles" ? 500 : kind === "repacks" ? 32 : 512;
    const item = kind === "collectibles" ? publicCollectibleIdSchema : kind === "repacks" ? repackSchema : publicCategorySchema;
    const pageSchema = z.object({ pins: pinsSchema, items: z.array(item).max(limit),
      lastId: z.string().nullable(), hasMore: z.boolean() }).strict();
    // Repack pages may stop earlier at the 4 MiB read budget. They must still
    // advance by at least one; the other entity pages have fixed row bounds.
    const maximumPages = kind === "repacks" ? Math.max(1, expected) : Math.max(1, Math.ceil(expected / limit));
    for (let pageNumber = 0; ; pageNumber++) {
      if (pageNumber >= maximumPages) return refuse();
      const parsed = pageSchema.safeParse(await port.readPage(kind, cursor, pins));
      if (!parsed.success) return refuse();
      const page = parsed.data;
      const ids = page.items.map((value) => typeof value === "string" ? value
        : "publicRepackId" in value ? value.publicRepackId : value.publicCategoryId);
      if (!same(page.pins, pins) || !ordered(ids, cursor) || page.lastId !== (ids.at(-1) ?? null) ||
          total + ids.length > expected || (page.hasMore && (ids.length === 0 ||
            total + ids.length >= expected || (kind !== "repacks" && ids.length !== limit)))) return refuse();
      total += ids.length;
      if (kind === "collectibles") publicCollectibleIds.push(...page.items as string[]);
      else if (kind === "repacks") repacks.push(...page.items as z.infer<typeof repackSchema>[]);
      else categories.push(...page.items as z.infer<typeof publicCategorySchema>[]);
      if (!page.hasMore) { if (total !== expected) return refuse(); break; }
      cursor = page.lastId;
    }
  }
  const final = state(await port.readState());
  if (!same(initial, final)) return refuse();
  const categoryIds = new Set(categories.map((category) => category.publicCategoryId));
  if (categories.some((category) => category.pathPublicCategoryIds.some((id) => !categoryIds.has(id)))) return refuse();
  const body = bodySchema.parse({ schemaVersion: "clutchpacks-production-identity-inventory-v1",
    activeState: initial.activeState, publicRepackIds: repacks.map((repack) => repack.publicRepackId),
    publicCollectibleIds, categories, repacks });
  return { ...body, digest: productionPublicationSha256(body) };
}

export const CLUTCHPACKS_IDENTITY_STATE_QUERY = `
const s=await ctx.db.query("activeDataReleaseV3State").withIndex("by_key",q=>q.eq("key","singleton")).unique();
if(!s?.activeReleaseId||!s.activeRelease)throw new Error("INVENTORY_STATE_INVALID");
const r=await ctx.db.get("dataReleaseV3Releases",s.activeReleaseId);
if(!r||r.publicReleaseId!==s.activeRelease.publicReleaseId||r.releaseFingerprint!==s.activeRelease.releaseFingerprint||r.completedAt!==s.activeRelease.completedAt||r.dataAsOf!==s.activeRelease.dataAsOf)throw new Error("INVENTORY_STATE_INVALID");
return {activeState:{generation:s.generation,activeRelease:s.activeRelease},acceptedCounts:r.acceptedCounts,
 complete:r.lifecycle==="complete"&&r.methodVersion===s.activeRelease.methodVersion&&r.confidencePolicyVersion===s.activeRelease.confidencePolicyVersion&&r.publicEvPolicyVersion===s.activeRelease.publicEvPolicyVersion&&r.acceptedBatchCount===r.expectedBatchCount&&r.acceptedBatchChainHash===r.expectedBatchChainHash&&r.acceptedSearchRowCount===r.expectedCounts.repacks&&JSON.stringify(r.acceptedCounts)===JSON.stringify(r.expectedCounts)&&JSON.stringify(r.acceptedEntityChainHashes)===JSON.stringify(r.expectedEntityChainHashes)};`;

export function clutchpacksIdentityPageQuery(kind: Kind, afterId: string | null, pinsValue: Pins): string {
  const pins = pinsSchema.parse(pinsValue);
  if (!["categories", "repacks", "collectibles"].includes(kind) ||
      (afterId !== null && !publicCollectibleIdSchema.safeParse(afterId).success) ||
      (kind === "categories" && afterId !== null)) return refuse();
  const prefix = `const expected=${canonicalJson(pins)};
const s=await ctx.db.query("activeDataReleaseV3State").withIndex("by_key",q=>q.eq("key","singleton")).unique();
const pins=s?.activeRelease?{generation:s.generation,publicReleaseId:s.activeRelease.publicReleaseId,releaseFingerprint:s.activeRelease.releaseFingerprint}:null;
if(!s?.activeReleaseId||!pins||pins.generation!==expected.generation||pins.publicReleaseId!==expected.publicReleaseId||pins.releaseFingerprint!==expected.releaseFingerprint)throw new Error("INVENTORY_PREDECESSOR_CHANGED");
const after=${JSON.stringify(afterId)};`;
  if (kind === "collectibles") return `${prefix}
const rows=await ctx.db.query("dataReleaseV3Collectibles").withIndex("by_release_id_and_public_collectible_id",q=>after===null?q.eq("releaseId",s.activeReleaseId):q.eq("releaseId",s.activeReleaseId).gt("publicCollectibleId",after)).take(501);
const items=rows.slice(0,500).map(row=>row.publicCollectibleId);
return {pins,items,lastId:items.at(-1)??null,hasMore:rows.length>500};`;
  if (kind === "categories") return `${prefix}
const rows=await ctx.db.query("dataReleaseV3Categories").withIndex("by_release_id_and_public_category_id",q=>q.eq("releaseId",s.activeReleaseId)).take(513);
if(rows.some(row=>row.publicCategoryId!==row.detail.publicCategoryId))throw new Error("INVENTORY_CATEGORY_INVALID");
const items=rows.map(row=>row.detail);return {pins,items,lastId:items.at(-1)?.publicCategoryId??null,hasMore:false};`;
  return `${prefix}
const query=ctx.db.query("dataReleaseV3Repacks").withIndex("by_release_id_and_public_repack_id",q=>after===null?q.eq("releaseId",s.activeReleaseId):q.eq("releaseId",s.activeReleaseId).gt("publicRepackId",after));
const items=[];let bytes=0;let hasMore=false;
for await(const row of query){const size=new TextEncoder().encode(JSON.stringify(row)).byteLength;
 if(items.length===32||(items.length>0&&bytes+size>4*1024*1024)){hasMore=true;break;}
 if(row.publicRepackId!==row.detail.publicRepackId)throw new Error("INVENTORY_REPACK_INVALID");
 items.push({publicRepackId:row.publicRepackId,publicVendorId:row.detail.publicVendorId,vendorKey:row.detail.vendorKey,listingUrl:row.detail.actions?.repackLink?.listingUrl??null});bytes+=size;}
return {pins,items,lastId:items.at(-1)?.publicRepackId??null,hasMore};`;
}

interface Dependencies {
  readonly run?: (file: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv;
    timeout: number; maxBuffer: number }) => Promise<{ stdout: string }>;
  readonly fetch?: typeof fetch;
  readonly readUtf8?: (file: string) => Promise<string>;
}

async function requireInstance(response: Response): Promise<void> {
  if (!response.ok || response.redirected || response.body === null) return refuse();
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let instance = "", bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 256) { await reader.cancel(); return refuse(); }
      instance += decoder.decode(part.value, { stream: true });
    }
    if (instance + decoder.decode() !== DEPLOYMENT) return refuse();
  } finally { reader.releaseLock(); }
}

/** Every invocation captures the current predecessor. The only CLI verb is run
 * --inline-query, with an exact named deployment and no deferred dotenv loading. */
export async function readClutchpacksProductionIdentityInventory(environment: NodeJS.ProcessEnv,
  dependencies: Dependencies = {}): Promise<ClutchpacksProductionIdentityInventory> {
  try {
    const forbidden = ["CONVEX_DEPLOYMENT", "CONVEX_DEPLOY_KEY", "CONVEX_DEPLOYMENT_TOKEN",
      "CONVEX_SELF_HOSTED_URL", "CONVEX_SELF_HOSTED_ADMIN_KEY", "CONVEX_OVERRIDE_ACCESS_TOKEN"];
    if (environment.NODE_ENV !== "production" || forbidden.some((name) => environment[name] !== undefined) ||
        (environment.PACKSCOUT_RUNTIME_ENVIRONMENT !== undefined && environment.PACKSCOUT_RUNTIME_ENVIRONMENT !== "production") ||
        (environment.CONVEX_URL !== undefined && environment.CONVEX_URL !== CLUTCHPACKS_PRODUCTION_TARGET.cloudUrl)) return refuse();
    const read = dependencies.readUtf8 ?? ((file: string) => readFile(file, "utf8"));
    if ((JSON.parse(await read(path.join(root, "node_modules/convex/package.json"))) as { version?: unknown }).version !== "1.43.0") return refuse();
    const request = dependencies.fetch ?? fetch;
    const childEnvironment: NodeJS.ProcessEnv = {};
    for (const name of ["PATH", "HOME", "TMPDIR", "SystemRoot", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"]) {
      if (environment[name] !== undefined) childEnvironment[name] = environment[name];
    }
    const run = dependencies.run ?? ((file, args, options) => promisify(execFile)(file, [...args], options));
    const query = async (source: string) => {
      const response = await request(`${CLUTCHPACKS_PRODUCTION_TARGET.cloudUrl}/instance_name`, {
        method: "GET", redirect: "error", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(30_000) });
      await requireInstance(response);
      const result = await run(process.execPath, [path.join(root, "node_modules/convex/bin/main.js"), "run",
        "--env-file", "/dev/null", "--deployment", DEPLOYMENT, "--codegen", "disable", "--inline-query", source],
      { cwd: root, env: childEnvironment, timeout: 45_000, maxBuffer: 1_024 * 1_024 });
      return JSON.parse(result.stdout) as unknown;
    };
    return await captureClutchpacksProductionIdentityInventory({
      readState: () => query(CLUTCHPACKS_IDENTITY_STATE_QUERY),
      readPage: (kind, cursor, pins) => query(clutchpacksIdentityPageQuery(kind, cursor, pins)),
    });
  } catch { return refuse(); }
}

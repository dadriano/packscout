import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { convexToJson, jsonToConvex, type JSONValue, type Value } from "convex/values";
import type { LocalEvMigrationClient } from "./local-convex-ev-migration.mts";
import { assertLocalConvexDeployment, assertNoCloudDeployKey, localCatalogReadCredential,
  requireLoopbackConvexUrl } from "./seed-convex-mock-data-release.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const operations = {
  state: { path: "dataReleaseV3EvMigrationState:migrationState", kind: "query" },
  progress: { path: "dataReleaseV3EvFactsBackfill:progress", kind: "query" },
  page: { path: "dataReleaseV3EvFactsBackfill:backfillActiveReleaseEvFacts", kind: "mutation" },
  initialize: { path: "dataReleaseV3EvFactsBackfill:initializeActiveRetention", kind: "mutation" },
} as const;
const MAX_RESPONSE_BYTES = 4 * 1_024 * 1_024;

interface Dependencies {
  readonly projectDirectory?: string;
  readonly homeDirectory?: string;
  readonly readUtf8?: (file: string) => Promise<string>;
  readonly fetch?: typeof fetch;
  readonly timeoutMilliseconds?: number;
}

function refuse(code = "LOCAL_CONVEX_EV_MIGRATION_LOCAL_TARGET_INVALID"): never {
  throw new Error(code);
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return refuse();
  return value as Record<string, unknown>;
}

async function existingConfiguration(deployment: string, dependencies: Dependencies) {
  const [kind, deploymentName] = deployment.split(":") as ["local" | "anonymous", string];
  const read = dependencies.readUtf8 ?? ((file: string) => readFile(file, "utf8"));
  const projectFile = path.join(dependencies.projectDirectory ?? projectRoot,
    ".convex", "local", "default", "config.json");
  let source: string;
  let projectLocal = true;
  try { source = await read(projectFile); }
  catch (error) {
    // An invalid or mismatched project config is never a reason to select another database.
    if (object(error).code !== "ENOENT") return refuse();
    projectLocal = false;
    source = await read(path.join(dependencies.homeDirectory ?? homedir(), ".convex",
      kind === "local" ? "convex-backend-state" : "anonymous-convex-backend-state",
      deploymentName, "config.json"));
  }
  if (Buffer.byteLength(source, "utf8") > 64 * 1_024) return refuse();
  const config = object(JSON.parse(source));
  if ((projectLocal || config.deploymentName !== undefined) && config.deploymentName !== deploymentName) return refuse();
  const port = object(config.ports).cloud;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535 ||
      typeof config.adminKey !== "string" || !/^[\x21-\x7e]{1,4096}$/u.test(config.adminKey)) return refuse();
  return { deploymentName, port, adminKey: config.adminKey };
}

async function boundedText(response: Response, maximumBytes: number): Promise<string> {
  if (!response.ok || response.redirected || response.body === null) return refuse();
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) { await reader.cancel(); return refuse(); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

/** Read an existing local target only; never start a backend, load .env, or invoke the CLI. */
export async function createLocalConvexEvMigrationClient(configuration: {
  readonly childEnvironment: NodeJS.ProcessEnv;
  readonly publicUrl: string;
}, dependencies: Dependencies = {}): Promise<LocalEvMigrationClient> {
  try {
    const environment = { ...configuration.childEnvironment };
    assertNoCloudDeployKey(environment);
    assertLocalConvexDeployment(environment);
    if (requireLoopbackConvexUrl(environment) !== configuration.publicUrl) return refuse();
    const saved = await existingConfiguration(environment.CONVEX_DEPLOYMENT!.trim(), dependencies);
    const configuredUrl = new URL(configuration.publicUrl);
    if (Number(configuredUrl.port || "80") !== saved.port) return refuse();
    // Both accepted host spellings refer to this explicit IP; do not consult DNS for localhost.
    const endpoint = `http://127.0.0.1:${saved.port}`;
    const catalogReadToken = localCatalogReadCredential(environment);
    const request = dependencies.fetch ?? fetch;
    const timeout = dependencies.timeoutMilliseconds ?? 10_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000) return refuse();
    const settings = () => ({ redirect: "error" as const, credentials: "omit" as const,
      cache: "no-store" as const, signal: AbortSignal.timeout(timeout) });
    const requireInstance = async () => {
      const response = await request(`${endpoint}/instance_name`, { ...settings(), method: "GET" });
      if (await boundedText(response, 256) !== saved.deploymentName) return refuse();
    };
    await requireInstance();
    const call = async (functionName: string, kind: "query" | "mutation", args: Record<string, unknown>, admin: boolean) => {
      // Recheck before each authenticated request, including after a backend restart.
      await requireInstance();
      const response = await request(`${endpoint}/api/${kind}`, {
        ...settings(), method: "POST", headers: { "Content-Type": "application/json",
          ...(admin ? { Authorization: `Convex ${saved.adminKey}` } : {}) },
        body: JSON.stringify({ path: functionName, args: [convexToJson(args as Value)], format: "convex_encoded_json" }),
      });
      const result = object(JSON.parse(await boundedText(response, MAX_RESPONSE_BYTES)));
      if (result.status !== "success" || !Object.hasOwn(result, "value")) return refuse();
      return jsonToConvex(result.value as JSONValue);
    };
    return {
      async call(operation, args) {
        try {
          if (!Object.hasOwn(operations, operation)) return refuse();
          const selected = operations[operation];
          return await call(selected.path, selected.kind, args, true);
        } catch { return refuse("LOCAL_CONVEX_EV_MIGRATION_REQUEST_FAILED"); }
      },
      async verifyPublicRead(publicReleaseId) {
        try {
          const result = object(await call("publicRepacksV3:listPublicRepacksV3", "query", {
            currentTime: Date.now(), pageSize: 1, filters: { availability: "all" },
            ...(catalogReadToken === null ? {} : { catalogReadToken }),
          }, false));
          if (result.ok !== true || object(object(result.data).release).publicReleaseId !== publicReleaseId) return refuse();
        } catch { return refuse("LOCAL_CONVEX_EV_MIGRATION_READBACK_FAILED"); }
      },
    };
  } catch { return refuse(); }
}

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ConvexHttpClient } from "convex/browser";
import { decodeProductionAuthSecretBase64, MAX_PRODUCTION_AUTH_SECRET_BYTES,
  MIN_PRODUCTION_AUTH_SECRET_BYTES } from "@packscout/contracts";
import { SignedConvexDataReleaseV3PublicationClient } from "@packscout/services";
import { EV_INITIALIZATION_TARGET as DEPLOYMENT, EV_INITIALIZATION_URL as PUBLIC_URL }
  from "./clutchpacks-production-ev-initialization.mts";

const SITE_URL = "https://shiny-newt-310.convex.site";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const graphNames = ["PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS", "PACKSCOUT_DATA_RELEASE_V3_PUBLICATION_KEY_IDS",
  "PACKSCOUT_PROVIDER_RELEASE_KEY_PLATFORMS", "PACKSCOUT_CATALOG_MANIFEST_KEY_ROLES", "PACKSCOUT_HEAT_PUBLICATION_KEY_IDS"] as const;
const environmentNames = [...graphNames, "PACKSCOUT_RUNTIME_ENVIRONMENT", "PACKSCOUT_CATALOG_READ_TOKEN"] as const;
const overrides = ["CONVEX_DEPLOYMENT", "CONVEX_DEPLOY_KEY", "CONVEX_DEPLOYMENT_TOKEN",
  "CONVEX_SELF_HOSTED_URL", "CONVEX_SELF_HOSTED_ADMIN_KEY", "CONVEX_OVERRIDE_ACCESS_TOKEN"];

// Execute the deployed source's exact graph validator in an isolated process.
// Its env owns the captured values; this never changes the operator process.env,
// rewrites backend code, duplicates role rules, or prints a key ID/secret.
const validateGraphSource = `
import { publicationAuthorityConfigurationIsIsolated, dataReleaseV3PublicationKeyIsAuthorized }
  from "./convex/productionPublicationKeyConfig.ts";
try {
 const ids=JSON.parse(process.env.PACKSCOUT_DATA_RELEASE_V3_PUBLICATION_KEY_IDS??"null");
 const valid=publicationAuthorityConfigurationIsIsolated()&&Array.isArray(ids)&&ids.length===1&&dataReleaseV3PublicationKeyIsAuthorized(ids[0]);
 process.stdout.write(JSON.stringify({valid}));
} catch { process.stdout.write('{"valid":false}'); }`;

interface Dependencies {
  readonly run?: (file: string, args: readonly string[], options: {
    cwd: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number;
  }) => Promise<{ stdout: string }>;
  readonly fetch?: typeof fetch;
  readonly readUtf8?: (file: string) => Promise<string>;
}
const INVALID = "CLUTCHPACKS_PRODUCTION_CONVEX_RUNTIME_INVALID";
const UNAVAILABLE = "CLUTCHPACKS_PRODUCTION_CONVEX_RUNTIME_UNAVAILABLE";
class RuntimeRefusal extends Error {}
class RetryableOpeningFailure extends Error {}
function refuse(code = INVALID): never { throw new RuntimeRefusal(code); }
function unavailable(): never { return refuse(UNAVAILABLE); }
function retryable(): never { throw new RetryableOpeningFailure(); }

/** Opening reads are idempotent and have no publication authority. A single
 * fresh retry absorbs a transient transport/process failure without ever
 * retrying a response or value that failed an integrity check. */
async function onceAfterUnavailable<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) { if (error instanceof RuntimeRefusal) throw error; }
  try { return await operation(); }
  catch (error) { if (error instanceof RuntimeRefusal) throw error; return unavailable(); }
}

function childEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  // CLI login uses the existing home config. Do not forward database/provider
  // credentials, NODE_OPTIONS hooks or process publication overrides to children.
  for (const key of ["PATH", "HOME", "TMPDIR", "SystemRoot", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"]) {
    if (environment[key] !== undefined) result[key] = environment[key];
  }
  return result;
}

async function boundedText(response: Response, limit: number): Promise<string> {
  if (response.redirected || response.body === null) return refuse();
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let value = "", size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) { await reader.cancel(); return refuse(); }
      try { value += decoder.decode(chunk.value, { stream: true }); }
      catch { return refuse(); }
    }
    try { return value + decoder.decode(); }
    catch { return refuse(); }
  } finally { reader.releaseLock(); }
}

/** Read-only opening: uses existing named deployment authority, never env set,
 * deploy, token creation or a signed publication request. All diagnostics redact
 * captured stdout/stderr. Callers own any later publication operation. */
export async function openClutchpacksProductionConvexRuntime(environment: NodeJS.ProcessEnv,
  dependencies: Dependencies = {}) {
  let ownedSecret: Uint8Array | null = null;
  try {
    if (environment.NODE_ENV !== "production" || overrides.some((key) => environment[key] !== undefined) ||
        (environment.PACKSCOUT_RUNTIME_ENVIRONMENT !== undefined && environment.PACKSCOUT_RUNTIME_ENVIRONMENT !== "production") ||
        (environment.CONVEX_URL !== undefined && environment.CONVEX_URL !== PUBLIC_URL) ||
        (environment.PACKSCOUT_CONVEX_PUBLICATION_BASE_URL !== undefined && environment.PACKSCOUT_CONVEX_PUBLICATION_BASE_URL !== SITE_URL)) return refuse();
    const read = dependencies.readUtf8 ?? ((file: string) => readFile(file, "utf8"));
    const installed = JSON.parse(await read(path.join(projectRoot, "node_modules/convex/package.json"))) as { version?: unknown };
    if (installed.version !== "1.43.0") return refuse();
    const run = dependencies.run ?? ((file, args, options) => promisify(execFile)(file, [...args], options));
    const request = dependencies.fetch ?? fetch;
    const cliEnvironment = childEnvironment(environment);
    const requireInstance = async () => {
      const value = await onceAfterUnavailable(async () => {
        const response = await request(`${PUBLIC_URL}/instance_name`, { method: "GET", redirect: "manual",
          credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(30_000) });
        if ([408, 429].includes(response.status) || (response.status >= 500 && response.status <= 599)) {
          await response.body?.cancel().catch(() => undefined);
          return retryable();
        }
        if (!response.ok) return refuse();
        return boundedText(response, 256);
      });
      if (value !== DEPLOYMENT) return refuse();
    };
    await requireInstance();
    const readEnvironment = () => Promise.allSettled(environmentNames.map(async (name) => {
      const result = await run(process.execPath, [path.join(projectRoot, "node_modules/convex/bin/main.js"),
        "env", "get", name, "--env-file", "/dev/null", "--deployment", DEPLOYMENT],
      { cwd: projectRoot, env: cliEnvironment, timeout: 45_000, maxBuffer: 64 * 1_024 });
      // CLI1.43 emits one newline; empty stdout means this optional var is absent.
      const value = result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
      return { name, value };
    }));
    const firstReads = await readEnvironment();
    const reads = firstReads.some((result) => result.status !== "fulfilled")
      ? await readEnvironment()
      : firstReads;
    if (reads.some((result) => result.status !== "fulfilled")) return unavailable();
    for (let index = 0; index < firstReads.length; index += 1) {
      const first = firstReads[index]!, second = reads[index]!;
      if (first.status === "fulfilled" && second.status === "fulfilled" && first.value.value !== second.value.value) return refuse();
    }
    const captured: Record<string, string> = {};
    for (const result of reads) {
      if (result.status === "fulfilled" && result.value.value !== "") captured[result.value.name] = result.value.value;
    }
    if (captured.PACKSCOUT_RUNTIME_ENVIRONMENT !== "production") return refuse();
    const token = captured.PACKSCOUT_CATALOG_READ_TOKEN;
    if (typeof token !== "string" || !/^[\x21-\x7e]{32,512}$/u.test(token)) return refuse();
    const graphEnvironment = childEnvironment(environment);
    for (const name of graphNames) {
      if (captured[name] !== undefined) graphEnvironment[name] = captured[name];
    }
    const checked = await onceAfterUnavailable(() => run(process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", validateGraphSource],
      { cwd: projectRoot, env: graphEnvironment, timeout: 45_000, maxBuffer: 1_024 }));
    if (checked.stdout !== '{"valid":true}') return refuse();
    const ids: unknown = JSON.parse(captured.PACKSCOUT_DATA_RELEASE_V3_PUBLICATION_KEY_IDS!);
    const keys: unknown = JSON.parse(captured.PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS!);
    if (!Array.isArray(ids) || ids.length !== 1 || typeof ids[0] !== "string" ||
        keys === null || typeof keys !== "object" || Array.isArray(keys)) return refuse();
    const encoded = (keys as Record<string, unknown>)[ids[0]];
    if (typeof encoded !== "string") return refuse();
    ownedSecret = decodeProductionAuthSecretBase64(encoded);
    if (ownedSecret === null || ownedSecret.byteLength < MIN_PRODUCTION_AUTH_SECRET_BYTES ||
        ownedSecret.byteLength > MAX_PRODUCTION_AUTH_SECRET_BYTES) return refuse();
    await requireInstance();
    const shutdown = new AbortController();
    let closed = false;
    const guardedFetch = (origin: string, publicRead: boolean): typeof fetch => async (input, init) => {
      try {
        if (closed) return refuse();
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        if (url.origin !== origin || url.username || url.password ||
            (publicRead && !["/api/query", "/api/action"].includes(url.pathname))) return refuse();
        const response = await request(input, { ...init, redirect: "error", credentials: "omit", cache: "no-store",
          signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(30_000), ...(init?.signal ? [init.signal] : [])]) });
        if (!publicRead) return response;
        // ConvexHttpClient otherwise forwards backend diagnostics in exceptions.
        if (!response.ok) return refuse();
        const body = JSON.parse(await boundedText(response, 4 * 1_024 * 1_024)) as Record<string, unknown>;
        if (body.status !== "success" || !Object.hasOwn(body, "value")) return refuse();
        return Response.json({ status: "success", value: body.value });
      } catch { return refuse(); }
    };
    const publication = new SignedConvexDataReleaseV3PublicationClient({
      baseUrl: SITE_URL, keyId: ids[0], secret: ownedSecret, fetch: guardedFetch(SITE_URL, false),
      timeoutMilliseconds: 30_000,
    });
    const publicClient = new ConvexHttpClient(PUBLIC_URL, { logger: false, fetch: guardedFetch(PUBLIC_URL, true) });
    // Drop owned references to captured immutable strings; JavaScript cannot
    // erase them or the publication client's private copied secret buffers.
    for (const name of Object.keys(captured)) delete captured[name];
    for (const name of graphNames) delete graphEnvironment[name];
    return { publication, publicClient, catalogReadToken: token,
      close() {
        if (closed) return;
        closed = true;
        shutdown.abort();
        ownedSecret?.fill(0);
        ownedSecret = null;
      },
    };
  } catch (error) {
    ownedSecret?.fill(0);
    if (error instanceof RuntimeRefusal) throw error;
    return refuse();
  }
}

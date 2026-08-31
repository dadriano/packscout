import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { backfillPinsSchema, refuseBackfill } from "../local/provider-backfill-supervisor-policy.mts";
import { continuousPostHeadMaximumMilliseconds } from "../local/provider-continuous-post-head-policy.mts";

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const commit = z.string().regex(/^[a-f0-9]{40}$/u);
const absolute = z.string().min(1).max(4096).refine(value => path.isAbsolute(value) &&
  path.resolve(value) === value && !/[\x00-\x1f\x7f]/u.test(value));
export const clutchpacksProductionPollerPolicySchema = z.object({
  schemaVersion: z.literal("clutchpacks_production_poller_policy_v1"),
  resident: z.object({ checkout: absolute, commit, environmentSha256: hash }).strict(),
  publisher: z.object({ checkout: absolute, commit, moduleSha256: hash }).strict(),
  baseSourceConfig: z.object({ path: absolute, sha256: hash }).strict(), artifactDirectory: absolute,
  expectedResidentAuthorityDigest: hash,
  timeoutMilliseconds: z.number().int().min(1).max(continuousPostHeadMaximumMilliseconds),
  pins: backfillPinsSchema.refine(pins => pins.providerKey === "clutchpacks"),
  cadence: z.object({ kind: z.literal("operator_interval"), intervalSeconds: z.literal(60) }).strict(),
}).strict();
export type ClutchpacksProductionPollerPolicy = z.infer<typeof clutchpacksProductionPollerPolicySchema>;
export const clutchpacksProductionPublisherModule = "scripts/live/clutchpacks-production-post-head.mts";
export const clutchpacksProductionResidentModule = "scripts/live/run-clutchpacks-production-poller.mts";
export const clutchpacksPollerPolicyPathKey = "PACKSCOUT_CLUTCHPACKS_POLLER_POLICY_PATH";
export const clutchpacksPollerPolicyHashKey = "PACKSCOUT_CLUTCHPACKS_POLLER_POLICY_SHA256";
export const clutchpacksProductionForbiddenEnvironment = Object.freeze([
  "PACKSCOUT_DATABASE_MODE", "PACKSCOUT_CENTRAL_DATABASE_URL", "PACKSCOUT_CENTRAL_DATABASE_ALLOWED_HOSTS",
  "PACKSCOUT_PROVIDER_DATABASE_ALLOWED_HOSTS", "PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64", "PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION",
  "PACKSCOUT_PROVIDER_LANES_JSON", "PACKSCOUT_PROVIDER_DATABASE_URL", "PACKSCOUT_DATABASE_URL", "PACKSCOUT_DATA_API_TOKEN",
]);
export interface ClutchpacksProductionPollerSettings {
  readonly policy: ClutchpacksProductionPollerPolicy;
  readonly policyPath: string;
  readonly fingerprint: string;
}
const bytesHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Check the opened inode and the named path without accepting symlink parents. */
async function verifiedFile(file: string, expectedHash: string, privateFile: boolean, maximum: number) {
  if (await realpath(file) !== file) refuseBackfill("CONTINUOUS_CLUTCHPACKS_FILE_INVALID");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    const privateMode = (before.mode & 0o7777n) === 0o600n;
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maximum) ||
      (privateFile && (process.getuid === undefined || before.uid !== BigInt(process.getuid()) || !privateMode))) {
      refuseBackfill("CONTINUOUS_CLUTCHPACKS_FILE_INVALID");
    }
    const bytes = await handle.readFile(), after = await handle.stat({ bigint: true });
    const named = await lstat(file, { bigint: true });
    if (named.isSymbolicLink() || named.dev !== after.dev || named.ino !== after.ino ||
      before.size !== BigInt(bytes.length) || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
      before.mode !== after.mode || before.uid !== after.uid || await realpath(file) !== file || bytesHash(bytes) !== expectedHash) {
      refuseBackfill("CONTINUOUS_CLUTCHPACKS_FILE_CHANGED");
    }
    return bytes;
  } finally { await handle.close(); }
}
async function verifyCheckout(checkout: string, expectedCommit: string, requiredModule: string) {
  if (await realpath(checkout) !== checkout) refuseBackfill("CONTINUOUS_CLUTCHPACKS_CHECKOUT_INVALID");
  const environment: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" };
  const run = async (args: string[]) => (await promisify(execFile)("/usr/bin/git",
    ["-c", "core.fsmonitor=false", ...args], { cwd: checkout, env: environment, timeout: 10_000, maxBuffer: 1_048_576 })).stdout.trim();
  for (const [args, expected] of [
    [["rev-parse", "--show-toplevel"], checkout], [["rev-parse", "HEAD"], expectedCommit],
    [["status", "--porcelain=v1", "--untracked-files=normal"], ""],
    [["ls-files", "--error-unmatch", requiredModule], requiredModule],
  ] as const) if (await run([...args]) !== expected) refuseBackfill("CONTINUOUS_CLUTCHPACKS_CHECKOUT_INVALID");
}
function frozenPolicy(policy: ClutchpacksProductionPollerPolicy): ClutchpacksProductionPollerPolicy {
  for (const value of Object.values(policy)) if (value && typeof value === "object") Object.freeze(value);
  return Object.freeze(policy);
}
/** Pure admission: no database, module import, directory creation, or publication. */
export async function readClutchpacksProductionPollerSettings(environment: NodeJS.ProcessEnv,
  residentModuleRoot: string): Promise<ClutchpacksProductionPollerSettings> {
  if (clutchpacksProductionForbiddenEnvironment.some(key => environment[key] !== undefined)) {
    refuseBackfill("CONTINUOUS_CLUTCHPACKS_ENVIRONMENT_INVALID");
  }
  const location = absolute.safeParse(environment[clutchpacksPollerPolicyPathKey]);
  const fingerprint = hash.safeParse(environment[clutchpacksPollerPolicyHashKey]);
  if (!location.success || !fingerprint.success) refuseBackfill("CONTINUOUS_CLUTCHPACKS_POLICY_INVALID");
  let raw: unknown;
  try { raw = JSON.parse((await verifiedFile(location.data, fingerprint.data, true, 65_536)).toString("utf8")); }
  catch { refuseBackfill("CONTINUOUS_CLUTCHPACKS_POLICY_INVALID"); }
  const parsed = clutchpacksProductionPollerPolicySchema.safeParse(raw);
  if (!parsed.success || parsed.data.resident.checkout !== path.resolve(residentModuleRoot)) {
    refuseBackfill("CONTINUOUS_CLUTCHPACKS_POLICY_INVALID");
  }
  const policy = parsed.data;
  if ([policy.resident.checkout, policy.publisher.checkout].some(checkout =>
    policy.artifactDirectory === checkout || policy.artifactDirectory.startsWith(`${checkout}${path.sep}`))) {
    refuseBackfill("CONTINUOUS_CLUTCHPACKS_POLICY_INVALID");
  }
  try {
    await verifyCheckout(policy.resident.checkout, policy.resident.commit, clutchpacksProductionResidentModule);
    await verifiedFile(path.join(policy.resident.checkout, ".env"), policy.resident.environmentSha256, true, 1_048_576);
    await verifyCheckout(policy.publisher.checkout, policy.publisher.commit, clutchpacksProductionPublisherModule);
    await verifiedFile(path.join(policy.publisher.checkout, clutchpacksProductionPublisherModule), policy.publisher.moduleSha256, false, 1_048_576);
    await verifiedFile(policy.baseSourceConfig.path, policy.baseSourceConfig.sha256, true, 1_048_576);
  } catch { refuseBackfill("CONTINUOUS_CLUTCHPACKS_DEPLOYMENT_CHANGED"); }
  return Object.freeze({ policy: frozenPolicy(policy), policyPath: location.data, fingerprint: fingerprint.data });
}
export async function revalidateClutchpacksProductionPollerSettings(settings: ClutchpacksProductionPollerSettings,
  residentModuleRoot: string, environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  await readClutchpacksProductionPollerSettings({ ...environment, [clutchpacksPollerPolicyPathKey]: settings.policyPath,
    [clutchpacksPollerPolicyHashKey]: settings.fingerprint }, residentModuleRoot);
}

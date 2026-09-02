import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export const publisherModule = "scripts/live/clutchpacks-production-post-head.mts";
export const residentModule = "scripts/live/run-clutchpacks-production-poller.mts";
export const policyPathKey = "PACKSCOUT_CLUTCHPACKS_POLLER_POLICY_PATH";
export const policyHashKey = "PACKSCOUT_CLUTCHPACKS_POLLER_POLICY_SHA256";
export const git = async (cwd, ...args) => (await promisify(execFile)("/usr/bin/git", args, { cwd,
  env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, timeout: 10000 })).stdout.trim();
export async function commit(cwd) {
  await git(cwd, "add", ".");
  await git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false",
    "-c", "core.hooksPath=/dev/null", "commit", "-qm", "Synthetic pinned fixture");
  return git(cwd, "rev-parse", "HEAD");
}
export async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "packscout-production-poller-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resident = path.join(root, "resident"), publisher = path.join(root, "publisher");
  for (const [checkout, module] of [[resident, residentModule], [publisher, publisherModule]]) {
    await mkdir(path.join(checkout, "scripts/live"), { recursive: true }); await git(checkout, "init", "-q");
    await writeFile(path.join(checkout, ".gitignore"), ".env\n");
    await writeFile(path.join(checkout, module), "throw new Error('Synthetic module must never load during check-only');\n");
    await commit(checkout);
  }
  const configPath = path.join(root, "private-source.json");
  await writeFile(path.join(resident, ".env"), "PACKSCOUT_DATABASE_MODE=synthetic\n", { mode: 0o600 });
  await writeFile(configPath, '{"syntheticPrivateValue":"never-log-this"}\n', { mode: 0o600 });
  const pins = { organizationId: "5c333333-3333-4333-8333-333333333331", providerId: "5c333333-3333-4333-8333-333333333332",
    providerKey: "clutchpacks", configId: "5c333333-3333-4333-8333-333333333333", initialRunId: "5c333333-3333-4333-8333-333333333334",
    operationId: "5c333333-3333-4333-8333-333333333335", operatorId: "5c333333-3333-4333-8333-333333333336" };
  const policy = { schemaVersion: "clutchpacks_production_poller_policy_v1",
    resident: { checkout: resident, commit: await git(resident, "rev-parse", "HEAD"),
      environmentSha256: sha256(await readFile(path.join(resident, ".env"))) },
    publisher: { checkout: publisher, commit: await git(publisher, "rev-parse", "HEAD"),
      moduleSha256: sha256(await readFile(path.join(publisher, publisherModule))) },
    baseSourceConfig: { path: configPath, sha256: sha256(await readFile(configPath)) },
    artifactDirectory: path.join(root, "artifacts"), expectedResidentAuthorityDigest: "d".repeat(64), timeoutMilliseconds: 12345,
    pins, cadence: { kind: "operator_interval", intervalSeconds: 60 } };
  const policyPath = path.join(root, "policy.json");
  const environment = { NODE_ENV: "development", [policyPathKey]: policyPath };
  const writePolicy = async () => {
    const bytes = `${JSON.stringify(policy)}\n`; await writeFile(policyPath, bytes, { mode: 0o600 }); await chmod(policyPath, 0o600);
    environment[policyHashKey] = sha256(bytes);
  };
  await writePolicy();
  const args = (mode = "--run") => [mode, "--organization-id", pins.organizationId, "--provider-id", pins.providerId,
    "--provider-key", pins.providerKey, "--config-id", pins.configId, "--initial-run-id", pins.initialRunId,
    "--operation-id", pins.operationId, "--operator-id", pins.operatorId, "--poll-interval-seconds", "60"];
  const head = Object.freeze({ providerId: pins.providerId, configId: pins.configId, configNumber: "4", runId: pins.initialRunId,
    checkpointHash: "a".repeat(64), generation: "41", runtimeRowVersion: "428", headFinishedAt: "2026-08-31T17:40:22.177Z",
    authorityDigest: policy.expectedResidentAuthorityDigest });
  return { root, resident, publisher, policy, policyPath, environment, pins, head, args, writePolicy };
}

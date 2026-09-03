import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseRemoteHealthScope, refuseRemoteHealth, type RemoteHealthScope } from "./remote-provider-health-policy.mts";

const exec = promisify(execFile);
const workspace = fileURLToPath(new URL("../../", import.meta.url));
export async function readRemoteHealthPrivateFile(file: string, limit: number) {
  if (!path.isAbsolute(file)) refuseRemoteHealth("REMOTE_HEALTH_PRIVATE_FILE_INVALID");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > limit) {
      refuseRemoteHealth("REMOTE_HEALTH_PRIVATE_FILE_INVALID");
    }
    const bytes = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > limit) { bytes.fill(0); refuseRemoteHealth("REMOTE_HEALTH_PRIVATE_FILE_INVALID"); }
    return bytes.subarray(0, bytesRead);
  } finally { await handle.close(); }
}
export function assertRemoteHealthSourceState(scope: RemoteHealthScope, head: string, status: string) {
  if (head.trim() !== scope.sourceCommit || status.trim() !== "") refuseRemoteHealth("REMOTE_HEALTH_SOURCE_REVISION_CHANGED");
}
export function assertRemoteHealthEvidence(scope: RemoteHealthScope, evidence: Uint8Array) {
  if (createHash("sha256").update(evidence).digest("hex") !== scope.migrationEvidence.sha256) {
    refuseRemoteHealth("REMOTE_HEALTH_MIGRATION_EVIDENCE_CHANGED");
  }
}
export async function readRemoteHealthScope(file: string) {
  const bytes = await readRemoteHealthPrivateFile(file, 16_384);
  let scope: RemoteHealthScope;
  try { scope = parseRemoteHealthScope(JSON.parse(bytes.toString("utf8"))); }
  finally { bytes.fill(0); }
  const [head, status] = await Promise.all([
    exec("git", ["rev-parse", "HEAD"], { cwd: workspace, timeout: 5000, maxBuffer: 65_536 }),
    exec("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: workspace, timeout: 5000, maxBuffer: 65_536 }),
  ]);
  assertRemoteHealthSourceState(scope, head.stdout, status.stdout);
  const evidence = await readRemoteHealthPrivateFile(scope.migrationEvidence.path, 4 * 1024 * 1024);
  try { assertRemoteHealthEvidence(scope, evidence); } finally { evidence.fill(0); }
  return scope;
}

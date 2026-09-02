import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CatalogBridgeError, refuseCatalogBridge } from "./dataforrest-catalog-bridge-plan.mts";

const commitPattern = /^[a-f0-9]{40}$/u;
const maximumPrivateArtifactBytes = 4 * 1024 * 1024;

function safeAbsolutePath(value: string): boolean {
  return path.isAbsolute(value) && path.resolve(value) === value &&
    !/[\x00-\x1f\x7f]/u.test(value);
}

function safeRelativeModulePath(value: string): boolean {
  return value.length > 0 && value.length <= 1_024 && !path.isAbsolute(value) &&
    !/[\x00-\x1f\x7f]/u.test(value) &&
    !path.normalize(value).split(path.sep).includes("..");
}

export function catalogBridgeRepositoryRoot(moduleUrl: string): string {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..", "..");
}

export interface CatalogBridgeCheckoutObservation {
  readonly checkout: string;
  readonly commit: string;
  readonly clean: true;
  readonly moduleSha256: Readonly<Record<string, string>>;
}

export async function observeCatalogBridgeCheckout(input: Readonly<{
  checkout: string;
  expectedCommit: string;
  executingRoot: string;
  modules: Readonly<Record<string, string>>;
  runGit?: (checkout: string, args: readonly string[]) => string;
  readModule?: (filePath: string) => Promise<Buffer>;
}>): Promise<CatalogBridgeCheckoutObservation> {
  if (!safeAbsolutePath(input.checkout) || !safeAbsolutePath(input.executingRoot) ||
    !commitPattern.test(input.expectedCommit) || Object.keys(input.modules).length === 0 ||
    Object.entries(input.modules).some(([name, relativePath]) =>
      name.length === 0 || !safeRelativeModulePath(relativePath))) {
    refuseCatalogBridge("CATALOG_BRIDGE_EXECUTOR_PINS_INVALID");
  }
  const runGit = input.runGit ?? ((checkout: string, args: readonly string[]) =>
    execFileSync("git", ["-C", checkout, ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }));
  const readModule = input.readModule ?? (async (filePath: string) => {
    const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const details = await handle.stat();
      if (!details.isFile() || details.size < 1 || details.size > maximumPrivateArtifactBytes) {
        refuseCatalogBridge("CATALOG_BRIDGE_EXECUTOR_MODULE_UNSAFE");
      }
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  });
  try {
    const checkout = path.resolve(input.checkout);
    const observedCommit = runGit(checkout, ["rev-parse", "HEAD"]).trim();
    const status = runGit(checkout, ["status", "--porcelain=v1", "--untracked-files=normal"]);
    if (checkout !== path.resolve(input.executingRoot) ||
      observedCommit !== input.expectedCommit || status.length !== 0) {
      refuseCatalogBridge("CATALOG_BRIDGE_EXECUTOR_DRIFT");
    }
    const entries = await Promise.all(Object.entries(input.modules).map(async ([name, relativePath]) => {
      const absolute = path.resolve(checkout, relativePath);
      if (!absolute.startsWith(`${checkout}${path.sep}`)) {
        refuseCatalogBridge("CATALOG_BRIDGE_EXECUTOR_MODULE_UNSAFE");
      }
      const bytes = await readModule(absolute);
      return [name, createHash("sha256").update(bytes).digest("hex")] as const;
    }));
    return Object.freeze({ checkout, commit: observedCommit, clean: true as const,
      moduleSha256: Object.freeze(Object.fromEntries(entries)) });
  } catch (error) {
    if (error instanceof CatalogBridgeError) throw error;
    return refuseCatalogBridge("CATALOG_BRIDGE_EXECUTOR_UNAVAILABLE");
  }
}

async function assertPrivateParent(filePath: string): Promise<void> {
  if (!safeAbsolutePath(filePath)) {
    refuseCatalogBridge("CATALOG_BRIDGE_OPERATOR_OUTPUT_PATH_INVALID");
  }
  const parentPath = path.dirname(filePath);
  const [parent, resolvedParent] = await Promise.all([lstat(parentPath), realpath(parentPath)]);
  if (!parent.isDirectory() || resolvedParent !== parentPath ||
    parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0) {
    refuseCatalogBridge("CATALOG_BRIDGE_OPERATOR_OUTPUT_DIRECTORY_UNSAFE");
  }
}

async function readExistingPrivateBytes(filePath: string): Promise<Buffer | null> {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const details = await handle.stat();
    if (!details.isFile() || details.uid !== process.getuid?.() ||
      (details.mode & 0o777) !== 0o600 || details.size < 1 ||
      details.size > maximumPrivateArtifactBytes) {
      refuseCatalogBridge("CATALOG_BRIDGE_OPERATOR_OUTPUT_FILE_UNSAFE");
    }
    return await handle.readFile();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function persistCatalogBridgePrivateBytes(filePath: string, bytes: Buffer): Promise<Readonly<{
  fileSha256: string;
  exactRetry: boolean;
}>> {
  if (!(bytes instanceof Buffer) || bytes.length < 1 || bytes.length > maximumPrivateArtifactBytes) {
    refuseCatalogBridge("CATALOG_BRIDGE_OPERATOR_OUTPUT_BYTES_INVALID");
  }
  await assertPrivateParent(filePath);
  const fileSha256 = createHash("sha256").update(bytes).digest("hex");
  const existing = await readExistingPrivateBytes(filePath);
  if (existing !== null) {
    try {
      if (Buffer.compare(existing, bytes) !== 0) {
        refuseCatalogBridge("CATALOG_BRIDGE_OPERATOR_OUTPUT_CONFLICT");
      }
      return Object.freeze({ fileSha256, exactRetry: true });
    } finally {
      existing.fill(0);
    }
  }
  let handle;
  try {
    handle = await open(filePath, constants.O_CREAT | constants.O_EXCL |
      constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      const raced = await readExistingPrivateBytes(filePath);
      if (raced === null) refuseCatalogBridge("CATALOG_BRIDGE_OPERATOR_OUTPUT_CONFLICT");
      try {
        if (Buffer.compare(raced, bytes) !== 0) {
          refuseCatalogBridge("CATALOG_BRIDGE_OPERATOR_OUTPUT_CONFLICT");
        }
        return Object.freeze({ fileSha256, exactRetry: true });
      } finally {
        raced.fill(0);
      }
    }
    throw error;
  }
  try {
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    const details = await handle.stat();
    if (!details.isFile() || details.uid !== process.getuid?.() ||
      (details.mode & 0o777) !== 0o600 || details.size !== bytes.length) {
      refuseCatalogBridge("CATALOG_BRIDGE_OPERATOR_OUTPUT_FILE_UNSAFE");
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  const directory = await open(path.dirname(filePath), constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  return Object.freeze({ fileSha256, exactRetry: false });
}

export function catalogBridgePrivateJsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

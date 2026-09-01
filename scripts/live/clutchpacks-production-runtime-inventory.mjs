import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import path from "node:path";

const MAX_ENTRIES = 300_000;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const HASH_BUFFER_BYTES = 1024 * 1024;

function refuse() { throw new Error("CLUTCHPACKS_RECOVERY_RUNTIME_INVENTORY_REFUSED"); }
function inside(parent, child) { return child === parent || child.startsWith(`${parent}${path.sep}`); }
function exactAbsolute(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && path.isAbsolute(value) &&
    path.resolve(value) === value && !/[\r\n\0]/u.test(value);
}
function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object") refuse();
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
function canonicalEntry(value) {
  return Buffer.from(`${canonical(value)}\n`, "utf8");
}
function sameMetadata(left, right) {
  return right.dev === left.dev && right.ino === left.ino && right.uid === left.uid && right.gid === left.gid &&
    right.mode === left.mode && right.size === left.size && right.mtimeMs === left.mtimeMs && right.ctimeMs === left.ctimeMs;
}

async function hashRegularFile(file, before) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  let offset = 0;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameMetadata(before, opened)) refuse();
    while (offset < before.size) {
      const length = Math.min(buffer.byteLength, before.size - offset);
      const result = await handle.read(buffer, 0, length, offset);
      if (result.bytesRead !== length) refuse();
      digest.update(buffer.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
    const final = await handle.stat();
    if (!sameMetadata(before, final)) refuse();
  } finally {
    buffer.fill(0);
    await handle.close();
  }
  const after = await lstat(file);
  if (!after.isFile() || !sameMetadata(before, after)) refuse();
  return digest.digest("hex");
}

/** Canonical Merkle-style inventory for the complete installed publisher runtime.
 * It never follows directory-entry symlinks; their exact targets are recorded and
 * confined to the frozen publisher checkout. */
export async function readClutchpacksProductionRuntimeInventory(root, allowedTargetRoot = path.dirname(root)) {
  if (!exactAbsolute(root) || !exactAbsolute(allowedTargetRoot) || !inside(allowedTargetRoot, root) ||
    await realpath(root) !== root || await realpath(allowedTargetRoot) !== allowedTargetRoot) refuse();
  const tree = createHash("sha256");
  let entryCount = 0, fileCount = 0, directoryCount = 0, symlinkCount = 0, totalBytes = 0;
  const externalTargets = new Set();
  const visit = async (file, relativePath) => {
    if (++entryCount > MAX_ENTRIES) refuse();
    const before = await lstat(file);
    if (before.uid !== process.getuid?.() || (before.mode & 0o022) !== 0) refuse();
    const common = { relativePath, uid: before.uid, gid: before.gid, mode: before.mode & 0o7777, size: before.size };
    if (before.isSymbolicLink()) {
      const target = await readlink(file);
      if (!target || target.length > 4096 || /[\r\n\0]/u.test(target) || path.isAbsolute(target)) refuse();
      const resolved = path.resolve(path.dirname(file), target);
      if (!inside(allowedTargetRoot, resolved)) refuse();
      const canonicalTarget = await realpath(file);
      if (!inside(allowedTargetRoot, canonicalTarget)) refuse();
      const resolvedTarget = path.relative(allowedTargetRoot, canonicalTarget).split(path.sep).join("/");
      if (!inside(root, canonicalTarget)) externalTargets.add(canonicalTarget);
      const after = await lstat(file);
      if (!after.isSymbolicLink() || !sameMetadata(before, after) || await readlink(file) !== target) refuse();
      symlinkCount += 1;
      tree.update(canonicalEntry({ ...common, type: "symlink", target, resolvedTarget }));
      return;
    }
    if (before.isDirectory()) {
      directoryCount += 1;
      const names = (await readdir(file)).sort();
      if (names.some(name => !name || name === "." || name === ".." || /[\/\r\n\0]/u.test(name))) refuse();
      tree.update(canonicalEntry({ ...common, type: "directory" }));
      for (const name of names) await visit(path.join(file, name), relativePath === "." ? name : `${relativePath}/${name}`);
      const after = await lstat(file);
      if (!after.isDirectory() || !sameMetadata(before, after) ||
        JSON.stringify((await readdir(file)).sort()) !== JSON.stringify(names)) refuse();
      return;
    }
    if (!before.isFile() || before.size > MAX_FILE_BYTES || totalBytes + before.size > MAX_TOTAL_BYTES) refuse();
    totalBytes += before.size;
    fileCount += 1;
    const sha256 = await hashRegularFile(file, before);
    tree.update(canonicalEntry({ ...common, type: "file", sha256 }));
  };
  await visit(root, ".");
  const visitedExternal = new Set();
  for (;;) {
    const next = [...externalTargets].filter(target => !visitedExternal.has(target)).sort()[0];
    if (next === undefined) break;
    if (next === allowedTargetRoot) refuse();
    visitedExternal.add(next);
    const relativeTarget = path.relative(allowedTargetRoot, next).split(path.sep).join("/");
    await visit(next, `@target/${relativeTarget}`);
  }
  return Object.freeze({ schemaVersion: "clutchpacks_production_runtime_inventory_v1", root, allowedTargetRoot,
    entryCount, fileCount, directoryCount, symlinkCount, totalBytes, treeSha256: tree.digest("hex") });
}

export const clutchpacksProductionRuntimeInventoryTestHarness = process.env.NODE_ENV === "test" ? Object.freeze({
  canonicalEntry,
}) : undefined;

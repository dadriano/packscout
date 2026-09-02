import { constants } from "node:fs";
import { mkdir, open, rename, stat } from "node:fs/promises";
import path from "node:path";
import {
  catalogBridgeDigest,
  refuseCatalogBridge,
  type CatalogBridgePrivatePreparedState,
  type CatalogBridgePublicPreparedReceipt,
} from "./dataforrest-catalog-bridge-plan.mts";
import {
  assertCatalogBridgeJournal,
  createCatalogBridgeJournal,
  type CatalogBridgePublicJournal,
} from "./dataforrest-catalog-bridge-state.mts";

const maximumPrivateDocumentBytes = 4 * 1024 * 1024;

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function requirePrivateFile(filePath: string): Promise<void> {
  const details = await stat(filePath);
  if (!details.isFile() || details.uid !== process.getuid?.() || (details.mode & 0o077) !== 0 ||
    details.size < 2 || details.size > maximumPrivateDocumentBytes) {
    refuseCatalogBridge("CATALOG_BRIDGE_PRIVATE_FILE_UNSAFE");
  }
}

export async function readPrivateJsonFile(filePath: string): Promise<unknown> {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const details = await handle.stat();
    if (!details.isFile() || details.uid !== process.getuid?.() || (details.mode & 0o077) !== 0 ||
      details.size < 2 || details.size > maximumPrivateDocumentBytes) {
      refuseCatalogBridge("CATALOG_BRIDGE_PRIVATE_FILE_UNSAFE");
    }
    return JSON.parse(await handle.readFile("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) refuseCatalogBridge("CATALOG_BRIDGE_PRIVATE_JSON_INVALID");
    throw error;
  } finally {
    await handle?.close();
  }
}

async function ensureJournalDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  const details = await stat(directory);
  if (!details.isDirectory() || details.uid !== process.getuid?.() || (details.mode & 0o077) !== 0) {
    refuseCatalogBridge("CATALOG_BRIDGE_JOURNAL_DIRECTORY_UNSAFE");
  }
}

async function durableWrite(filePath: string, content: string): Promise<void> {
  const temporary = `${filePath}.next-${process.pid}`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filePath);
  const directory = await open(path.dirname(filePath), constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function persistCatalogBridgePreparationInput(filePath: string, value: unknown): Promise<Readonly<{
  sha256: string; exactRetry: boolean;
}>> {
  if (!path.isAbsolute(filePath) || /[\r\n\0]/u.test(filePath)) {
    refuseCatalogBridge("CATALOG_BRIDGE_INPUT_PATH_INVALID");
  }
  const parent = path.dirname(filePath);
  const parentDetails = await stat(parent);
  if (!parentDetails.isDirectory() || parentDetails.uid !== process.getuid?.() || (parentDetails.mode & 0o077) !== 0) {
    refuseCatalogBridge("CATALOG_BRIDGE_INPUT_DIRECTORY_UNSAFE");
  }
  const sha256 = catalogBridgeDigest(value);
  try {
    await requirePrivateFile(filePath);
    if (catalogBridgeDigest(await readPrivateJsonFile(filePath)) !== sha256) {
      refuseCatalogBridge("CATALOG_BRIDGE_RETRY_EVIDENCE_CHANGED");
    }
    return Object.freeze({ sha256, exactRetry: true });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await durableWrite(filePath, serialize(value));
  return Object.freeze({ sha256, exactRetry: false });
}

async function writeOrVerify(filePath: string, value: unknown): Promise<string> {
  const expectedDigest = catalogBridgeDigest(value);
  try {
    await requirePrivateFile(filePath);
    const existing = await readPrivateJsonFile(filePath);
    if (catalogBridgeDigest(existing) !== expectedDigest) {
      refuseCatalogBridge("CATALOG_BRIDGE_RETRY_EVIDENCE_CHANGED");
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    await durableWrite(filePath, serialize(value));
  }
  return expectedDigest;
}

export interface CatalogBridgeJournalCommit {
  readonly schemaVersion: "dataforrest_catalog_bridge_commit_v1";
  readonly operationId: string;
  readonly providerKey: string;
  readonly privateStateSha256: string;
  readonly publicJournalSha256: string;
}

export async function persistPreparedCatalogBridge(input: Readonly<{
  directory: string;
  privateState: CatalogBridgePrivatePreparedState;
  publicReceipt: CatalogBridgePublicPreparedReceipt;
}>): Promise<Readonly<{ journal: CatalogBridgePublicJournal; commit: CatalogBridgeJournalCommit; exactRetry: boolean }>> {
  if (!path.isAbsolute(input.directory) || /[\r\n\0]/u.test(input.directory)) {
    refuseCatalogBridge("CATALOG_BRIDGE_JOURNAL_PATH_INVALID");
  }
  await ensureJournalDirectory(input.directory);
  const journal = createCatalogBridgeJournal(input.publicReceipt);
  assertCatalogBridgeJournal(journal);
  const privatePath = path.join(input.directory, "private-state.json");
  const publicPath = path.join(input.directory, "public-journal.json");
  const commitPath = path.join(input.directory, "commit.json");
  let exactRetry = false;
  try {
    await requirePrivateFile(commitPath);
    exactRetry = true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (exactRetry) {
    const existing = await readPreparedCatalogBridge(input.directory);
    if (catalogBridgeDigest(existing.privateState) !== catalogBridgeDigest(input.privateState) ||
      catalogBridgeDigest(existing.journal) !== catalogBridgeDigest(journal)) {
      refuseCatalogBridge("CATALOG_BRIDGE_RETRY_EVIDENCE_CHANGED");
    }
    return Object.freeze({ journal, commit: existing.commit, exactRetry: true });
  }
  const privateStateSha256 = await writeOrVerify(privatePath, input.privateState);
  const publicJournalSha256 = await writeOrVerify(publicPath, journal);
  await writeOrVerify(path.join(input.directory, `public-journal-${publicJournalSha256}.json`), journal);
  const commit = Object.freeze({ schemaVersion: "dataforrest_catalog_bridge_commit_v1" as const,
    operationId: input.privateState.operationId, providerKey: input.privateState.providerKey,
    privateStateSha256, publicJournalSha256 });
  await writeOrVerify(commitPath, commit);
  return Object.freeze({ journal, commit, exactRetry });
}

/**
 * Advances the public journal through an immutable, content-addressed document.
 * The small commit file is replaced last and is the only mutable authority, so
 * interruption cannot expose a half-written journal as the committed phase.
 */
export async function persistCatalogBridgeJournal(input: Readonly<{
  directory: string;
  expected: CatalogBridgePublicJournal;
  next: CatalogBridgePublicJournal;
}>): Promise<Readonly<{ commit: CatalogBridgeJournalCommit; exactRetry: boolean }>> {
  assertCatalogBridgeJournal(input.expected);
  assertCatalogBridgeJournal(input.next);
  const existing = await readPreparedCatalogBridge(input.directory);
  const existingDigest = catalogBridgeDigest(existing.journal);
  const expectedDigest = catalogBridgeDigest(input.expected);
  const nextDigest = catalogBridgeDigest(input.next);
  if (existingDigest === nextDigest) {
    return Object.freeze({ commit: existing.commit, exactRetry: true });
  }
  if (existingDigest !== expectedDigest || input.expected.operationId !== input.next.operationId ||
    input.expected.providerKey !== input.next.providerKey || input.expected.planDigest !== input.next.planDigest ||
    input.next.receipts.length !== input.expected.receipts.length + 1 ||
    input.next.receipts.slice(0, -1).some((value, index) =>
      catalogBridgeDigest(value) !== catalogBridgeDigest(input.expected.receipts[index]))) {
    refuseCatalogBridge("CATALOG_BRIDGE_JOURNAL_CAS_FAILED");
  }
  const versionedPath = path.join(input.directory, `public-journal-${nextDigest}.json`);
  await writeOrVerify(versionedPath, input.next);
  const commit = Object.freeze({ ...existing.commit, publicJournalSha256: nextDigest });
  // This convenience copy is not authoritative and may safely be ahead of the
  // commit if interrupted. The authoritative commit remains the final write.
  await durableWrite(path.join(input.directory, "public-journal.json"), serialize(input.next));
  await durableWrite(path.join(input.directory, "commit.json"), serialize(commit));
  return Object.freeze({ commit, exactRetry: false });
}

export async function readPreparedCatalogBridge(directory: string): Promise<Readonly<{
  privateState: CatalogBridgePrivatePreparedState;
  journal: CatalogBridgePublicJournal;
  commit: CatalogBridgeJournalCommit;
}>> {
  const commit = await readPrivateJsonFile(path.join(directory, "commit.json")) as CatalogBridgeJournalCommit;
  const privateState = await readPrivateJsonFile(path.join(directory, "private-state.json")) as CatalogBridgePrivatePreparedState;
  let journalValue: unknown;
  try {
    journalValue = await readPrivateJsonFile(path.join(directory,
      `public-journal-${commit.publicJournalSha256}.json`));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    journalValue = await readPrivateJsonFile(path.join(directory, "public-journal.json"));
  }
  const journal = assertCatalogBridgeJournal(journalValue as CatalogBridgePublicJournal);
  if (commit.schemaVersion !== "dataforrest_catalog_bridge_commit_v1" ||
    commit.operationId !== privateState.operationId || commit.providerKey !== privateState.providerKey ||
    journal.operationId !== privateState.operationId || journal.providerKey !== privateState.providerKey ||
    commit.privateStateSha256 !== catalogBridgeDigest(privateState) ||
    commit.publicJournalSha256 !== catalogBridgeDigest(journal)) {
    refuseCatalogBridge("CATALOG_BRIDGE_JOURNAL_COMMIT_INVALID");
  }
  return Object.freeze({ privateState, journal, commit });
}

import { constants } from "node:fs";
import { open, rename, stat } from "node:fs/promises";
import path from "node:path";
import { catalogBridgeDigest, refuseCatalogBridge } from "./dataforrest-catalog-bridge-plan.mts";
import {
  catalogBridgeDrainReceiptSchema,
  type CatalogBridgeDrainReceipt,
} from "./dataforrest-catalog-bridge-drain-policy.mts";

const maximumReceiptBytes = 64 * 1_024;

async function requirePrivateDirectory(directory: string): Promise<void> {
  const details = await stat(directory);
  if (!details.isDirectory() || details.uid !== process.getuid?.() || (details.mode & 0o077) !== 0) {
    refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_RECEIPT_DIRECTORY_UNSAFE");
  }
}

export async function readCatalogBridgeDrainReceipt(filePath: string): Promise<CatalogBridgeDrainReceipt> {
  if (!path.isAbsolute(filePath) || /[\r\n\0]/u.test(filePath)) {
    refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_RECEIPT_PATH_INVALID");
  }
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const details = await handle.stat();
    if (!details.isFile() || details.uid !== process.getuid?.() || (details.mode & 0o077) !== 0 ||
      details.size < 2 || details.size > maximumReceiptBytes) {
      refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_RECEIPT_FILE_UNSAFE");
    }
    return catalogBridgeDrainReceiptSchema.parse(JSON.parse(await handle.readFile("utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_RECEIPT_JSON_INVALID");
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function readCatalogBridgeDrainReceiptIfPresent(filePath: string): Promise<CatalogBridgeDrainReceipt | null> {
  try {
    return await readCatalogBridgeDrainReceipt(filePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function persistCatalogBridgeDrainReceipt(filePath: string,
  receipt: CatalogBridgeDrainReceipt): Promise<Readonly<{ sha256: string; exactRetry: boolean }>> {
  if (!path.isAbsolute(filePath) || /[\r\n\0]/u.test(filePath)) {
    refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_RECEIPT_PATH_INVALID");
  }
  await requirePrivateDirectory(path.dirname(filePath));
  const parsed = catalogBridgeDrainReceiptSchema.parse(receipt);
  const sha256 = catalogBridgeDigest(parsed);
  const existing = await readCatalogBridgeDrainReceiptIfPresent(filePath);
  if (existing !== null) {
    if (catalogBridgeDigest(existing) !== sha256) {
      refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_RETRY_EVIDENCE_CHANGED");
    }
    return Object.freeze({ sha256, exactRetry: true });
  }
  const temporary = `${filePath}.next-${process.pid}`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filePath);
  const directory = await open(path.dirname(filePath), constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
  return Object.freeze({ sha256, exactRetry: false });
}

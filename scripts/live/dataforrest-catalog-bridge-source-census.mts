import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import {
  providerCatalogIdentityChainDigest,
  providerCatalogIdentityCountMapDigest,
  providerCatalogIdentityMultisetDigest,
  providerCatalogSourceIdentityDigest,
} from "@packscout/services";
import { z } from "zod";
import type { ResolvedDataforrestSourceAuthority } from
  "../../apps/worker/src/dataforrest-source-authority-resolver.ts";
import {
  catalogBridgeDigest,
  catalogBridgeProvider,
  refuseCatalogBridge,
} from "./dataforrest-catalog-bridge-plan.mts";
import {
  catalogBridgeSourceCredentialDigest,
  type CatalogBridgeSourceInspection,
} from "./dataforrest-catalog-bridge-source-inspection.mts";
import {
  catalogBridgeSourceCensusPassSchema,
  catalogBridgeSourceCensusSchema,
  type CatalogBridgeSourceCensus,
  type CatalogBridgeSourceCensusPass,
} from "./dataforrest-catalog-bridge-source-census-proof.mts";

export {
  catalogBridgeSourceCensusBytes,
  catalogBridgeSourceCensusFileSha256,
  catalogBridgeSourceCensusPassSchema,
  catalogBridgeSourceCensusSchema,
} from "./dataforrest-catalog-bridge-source-census-proof.mts";
export type {
  CatalogBridgeSourceCensus,
  CatalogBridgeSourceCensusPass,
} from "./dataforrest-catalog-bridge-source-census-proof.mts";

function safeAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) {
    refuseCatalogBridge("CATALOG_BRIDGE_SOURCE_CENSUS_COUNT_INVALID");
  }
  return value;
}

function instant(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    refuseCatalogBridge("CATALOG_BRIDGE_SOURCE_CENSUS_CLOCK_INVALID");
  }
  return value.toISOString();
}

export function assertCatalogBridgeSourceCensusAuthority(
  authority: ResolvedDataforrestSourceAuthority,
): string {
  const definition = catalogBridgeProvider("collector_crypt");
  if (authority.organizationId !== definition.organizationId ||
    authority.providerId !== definition.providerId ||
    authority.providerKey !== definition.providerKey ||
    authority.configVersionId !== definition.currentConfigId ||
    authority.configVersionNumber !== BigInt(definition.currentConfigNumber) ||
    authority.adapterKey !== definition.currentEventManifest.adapterVersion ||
    authority.sourceTypeKey !== definition.currentEventManifest.sourceTypeKey ||
    authority.sourceAdapterVersion !== definition.currentEventManifest.adapterVersion ||
    authority.sourceConfiguration.platform !== definition.providerKey ||
    "stream" in authority.sourceConfiguration ||
    authority.sourceCredentialVersionId.trim().length === 0 ||
    authority.sourceCredentialVersionNumber < 1n) {
    refuseCatalogBridge("CATALOG_BRIDGE_SOURCE_CENSUS_AUTHORITY_INVALID");
  }
  return catalogBridgeSourceCredentialDigest(authority);
}

export async function captureCatalogBridgeSourceCensusPass(input: Readonly<{
  passNumber: 1 | 2;
  authority: ResolvedDataforrestSourceAuthority;
  readPage: (cursor: string | null, signal: AbortSignal) => Promise<CatalogBridgeSourceInspection>;
  signal: AbortSignal;
  now?: () => Date;
  maximumPages?: number;
  onProgress?: (progress: Readonly<{ passNumber: 1 | 2; pageNumber: number;
    sourceRecordCount: number; cardCount: number; packCount: number }>) => void;
}>): Promise<CatalogBridgeSourceCensusPass> {
  assertCatalogBridgeSourceCensusAuthority(input.authority);
  const definition = catalogBridgeProvider("collector_crypt");
  const now = input.now ?? (() => new Date());
  const maximumPages = input.maximumPages ?? 100_000;
  if (!Number.isSafeInteger(maximumPages) || maximumPages < 1 || maximumPages > 100_000) {
    refuseCatalogBridge("CATALOG_BRIDGE_SOURCE_CENSUS_BOUND_INVALID");
  }
  const startedAt = instant(now);
  const identityCounts = new Map<string, number>();
  const seenContinuationCursorHashes = new Set<string>();
  let cursor: string | null = null;
  let requestedCursorHash: string | null = null;
  let rawCardObservationCount = 0;
  let rawPackObservationCount = 0;
  let distinctCardIdentityCount = 0;
  let distinctPackIdentityCount = 0;
  let sourceRecordCount = 0;
  let totalResponseBytes = 0;
  let maximumResponseBytes = 0;
  let traversalChainDigest: string | null = null;

  for (let pageNumber = 1; pageNumber <= maximumPages; pageNumber += 1) {
    if (input.signal.aborted) refuseCatalogBridge("CATALOG_BRIDGE_SOURCE_CENSUS_ABORTED");
    const page = await input.readPage(cursor, input.signal);
    if (page.status !== 200 || page.inspection.kind !== "untrusted_inspection" ||
      !page.inspection.ok || !Number.isFinite(Date.parse(page.checkedAt)) ||
      !Number.isSafeInteger(page.responseBytes) || page.responseBytes < 1 ||
      page.responseBytes > definition.catalogManifest.requestBounds.maximumResponseBytes ||
      !Number.isFinite(page.durationMilliseconds) || page.durationMilliseconds < 0 ||
      !/^[a-f0-9]{64}$/u.test(page.responseSha256) ||
      typeof page.nextCursor !== "string" || page.nextCursor.length < 1 ||
      createHash("sha256").update(page.nextCursor, "utf8").digest("hex") !== page.nextCursorHash ||
      page.inspection.outcomes.some((outcome) => outcome.status !== "valid") ||
      page.inspection.outcomes.length !== page.inspection.recordCount ||
      page.inspection.recordCount > definition.catalogManifest.requestBounds.pageLimit) {
      refuseCatalogBridge("CATALOG_BRIDGE_SOURCE_CENSUS_PAGE_INVALID");
    }
    const pageIdentities: string[] = [];
    for (const outcome of page.inspection.outcomes) {
      if (outcome.status !== "valid" || outcome.observation.kind !== "catalog" ||
        !["card", "pack"].includes(outcome.observation.entity)) {
        refuseCatalogBridge("CATALOG_BRIDGE_SOURCE_CENSUS_PAGE_INVALID");
      }
      const isCard = outcome.observation.entity === "card";
      const recordIdScopeKey = isCard ? "catalog-card-v1" as const : "catalog-pack-v1" as const;
      const identity = outcome.observation.providerRecordIdentity;
      if (identity.recordIdScopeKey !== recordIdScopeKey) {
        refuseCatalogBridge("CATALOG_BRIDGE_SOURCE_CENSUS_PAGE_INVALID");
      }
      const digest = providerCatalogSourceIdentityDigest({
        recordIdScopeKey,
        providerRecordId: identity.providerRecordId,
      });
      pageIdentities.push(digest);
      const prior = identityCounts.get(digest) ?? 0;
      identityCounts.set(digest, safeAdd(prior, 1));
      if (isCard) {
        rawCardObservationCount = safeAdd(rawCardObservationCount, 1);
        if (prior === 0) distinctCardIdentityCount = safeAdd(distinctCardIdentityCount, 1);
      } else {
        rawPackObservationCount = safeAdd(rawPackObservationCount, 1);
        if (prior === 0) distinctPackIdentityCount = safeAdd(distinctPackIdentityCount, 1);
      }
    }
    sourceRecordCount = safeAdd(sourceRecordCount, page.inspection.recordCount);
    totalResponseBytes = safeAdd(totalResponseBytes, page.responseBytes);
    maximumResponseBytes = Math.max(maximumResponseBytes, page.responseBytes);
    const pageIdentityMultisetDigest = providerCatalogIdentityMultisetDigest(pageIdentities);
    const reachedHead = page.inspection.continuation.kind === "poll_after";
    const responseDigest = catalogBridgeDigest({
      pageNumber,
      requestedCursorHash,
      nextCursorHash: page.nextCursorHash,
      continuation: reachedHead ? "head" : "continue",
      pageIdentityMultisetDigest,
    });
    traversalChainDigest = providerCatalogIdentityChainDigest({
      previousChainDigest: traversalChainDigest,
      pageNumber,
      pageResponseDigest: responseDigest,
      pageIdentityMultisetDigest,
    });
    if (pageNumber % 200 === 0 || reachedHead) {
      input.onProgress?.(Object.freeze({ passNumber: input.passNumber, pageNumber,
        sourceRecordCount, cardCount: rawCardObservationCount,
        packCount: rawPackObservationCount }));
    }
    if (reachedHead) {
      if (rawCardObservationCount !== distinctCardIdentityCount ||
        rawPackObservationCount !== distinctPackIdentityCount ||
        distinctCardIdentityCount < definition.documentedCatalogFloor.card ||
        distinctPackIdentityCount < definition.documentedCatalogFloor.pack) {
        refuseCatalogBridge("CATALOG_BRIDGE_SOURCE_CENSUS_IDENTITY_INVALID");
      }
      return catalogBridgeSourceCensusPassSchema.parse({
        passNumber: input.passNumber,
        startedAt,
        completedAt: instant(now),
        pageCount: pageNumber,
        sourceRequestCount: pageNumber,
        sourceRecordCount,
        rawCardObservationCount,
        rawPackObservationCount,
        distinctCardIdentityCount,
        distinctPackIdentityCount,
        identityMultisetDigest: providerCatalogIdentityCountMapDigest(identityCounts),
        traversalChainDigest,
        finalCursorHash: page.nextCursorHash,
        maximumResponseBytes,
        totalResponseBytes,
      });
    }
    if (page.inspection.recordCount < 1 || page.nextCursorHash === requestedCursorHash ||
      seenContinuationCursorHashes.has(page.nextCursorHash)) {
      refuseCatalogBridge("CATALOG_BRIDGE_SOURCE_CENSUS_CURSOR_INVALID");
    }
    seenContinuationCursorHashes.add(page.nextCursorHash);
    cursor = page.nextCursor;
    requestedCursorHash = page.nextCursorHash;
  }
  return refuseCatalogBridge("CATALOG_BRIDGE_SOURCE_CENSUS_PAGE_LIMIT_EXCEEDED");
}

export function catalogBridgeSourceCensusDigest(proof: CatalogBridgeSourceCensus): string {
  return catalogBridgeDigest(catalogBridgeSourceCensusSchema.parse(proof));
}

async function readCatalogBridgeSourceCensusFile(
  filePath: string,
  missing: "throw" | "return_null",
): Promise<Readonly<{ proof: CatalogBridgeSourceCensus; fileSha256: string }> | null> {
  if (!path.isAbsolute(filePath) || path.resolve(filePath) !== filePath || /[\r\n\0]/u.test(filePath)) {
    refuseCatalogBridge("CATALOG_BRIDGE_SOURCE_CENSUS_PATH_INVALID");
  }
  const parentPath = path.dirname(filePath);
  const [parent, resolvedParent] = await Promise.all([
    lstat(parentPath),
    realpath(parentPath),
  ]);
  if (!parent.isDirectory() || resolvedParent !== parentPath ||
    parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0) {
    refuseCatalogBridge("CATALOG_BRIDGE_SOURCE_CENSUS_FILE_UNSAFE");
  }
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const details = await handle.stat();
    if (!details.isFile() || details.uid !== process.getuid?.() ||
      (details.mode & 0o777) !== 0o600 || details.size < 2 || details.size > 128 * 1_024) {
      refuseCatalogBridge("CATALOG_BRIDGE_SOURCE_CENSUS_FILE_UNSAFE");
    }
    const bytes = await handle.readFile();
    const fileSha256 = createHash("sha256").update(bytes).digest("hex");
    const proof = catalogBridgeSourceCensusSchema.parse(JSON.parse(bytes.toString("utf8")));
    return Object.freeze({ proof, fileSha256 });
  } catch (error) {
    if (missing === "return_null" && error instanceof Error &&
      "code" in error && error.code === "ENOENT") return null;
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      refuseCatalogBridge("CATALOG_BRIDGE_SOURCE_CENSUS_INVALID");
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

export function readCatalogBridgeSourceCensusIfPresent(
  filePath: string,
): Promise<Readonly<{ proof: CatalogBridgeSourceCensus; fileSha256: string }> | null> {
  return readCatalogBridgeSourceCensusFile(filePath, "return_null");
}

export async function readCatalogBridgeSourceCensus(
  filePath: string,
  expectedFileSha256: string,
): Promise<Readonly<{ proof: CatalogBridgeSourceCensus; fileSha256: string }>> {
  if (!/^[a-f0-9]{64}$/u.test(expectedFileSha256)) {
    refuseCatalogBridge("CATALOG_BRIDGE_SOURCE_CENSUS_PATH_INVALID");
  }
  const sourceCensus = await readCatalogBridgeSourceCensusFile(filePath, "throw");
  if (sourceCensus === null) {
    refuseCatalogBridge("CATALOG_BRIDGE_SOURCE_CENSUS_INVALID");
  }
  if (sourceCensus.fileSha256 !== expectedFileSha256) {
    refuseCatalogBridge("CATALOG_BRIDGE_SOURCE_CENSUS_FILE_DIGEST_MISMATCH");
  }
  return sourceCensus;
}

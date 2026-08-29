import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  PROVIDER_MIXED_PAGE_MAX_BYTES,
  providerMixedPageCanonicalBytes,
  validateProviderMixedPage,
  type ValidatedProviderMixedPage,
} from "@packscout/database";
import { readValidatedProviderCapture } from "./provider-capture-file.ts";
import { ProviderCaptureMixedPageSource } from
  "./provider-capture-mixed-page-source.ts";
import {
  CLUTCHPACKS_CAPTURE_ADAPTER_KEY,
  CLUTCHPACKS_CAPTURE_FILE_NAME,
  CLUTCHPACKS_CAPTURE_SHA256,
  ProviderCaptureSourceError,
} from "./provider-capture-source-contract.ts";

const providerId = "11111111-1111-4111-8111-111111111111";
const configVersionId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const actorHmacKey = Buffer.alloc(32, 0x5a);

async function requireSample(
  context: TestContext,
): Promise<string | null> {
  const sampleRoot = process.env.PACKSCOUT_PROVIDER_CAPTURE_ROOT;
  if (sampleRoot === undefined || sampleRoot.length === 0) {
    context.skip(
      "Set PACKSCOUT_PROVIDER_CAPTURE_ROOT to run protected capture tests.",
    );
    return null;
  }
  if (!path.isAbsolute(sampleRoot)) {
    throw new Error("PACKSCOUT_PROVIDER_CAPTURE_ROOT must be absolute.");
  }
  try {
    await access(path.join(sampleRoot, CLUTCHPACKS_CAPTURE_FILE_NAME));
    return sampleRoot;
  } catch {
    context.skip("The protected ClutchPacks capture is not available.");
    return null;
  }
}

function source(root: string): ProviderCaptureMixedPageSource {
  return new ProviderCaptureMixedPageSource({
    captureRoot: root,
    actorHmacKey,
  });
}

const authority = Object.freeze({
  providerId,
  providerKey: "clutchpacks",
  configVersionId,
  configVersionNumber: 1n,
  configuration: Object.freeze({
    adapterKey: CLUTCHPACKS_CAPTURE_ADAPTER_KEY,
    settings: Object.freeze({
      // A provider-selected path is intentionally ignored by the source.
      captureRoot: "/browser-controlled/path",
    }),
  }),
});

async function allPages(
  pageSource: ProviderCaptureMixedPageSource,
): Promise<readonly { readonly raw: unknown; readonly page: ValidatedProviderMixedPage }[]> {
  const pages: Array<{ raw: unknown; page: ValidatedProviderMixedPage }> = [];
  let sourceCheckpoint: ValidatedProviderMixedPage["nextCursor"] = null;
  let checkpoint: string | null = null;
  for (let index = 0; index < 20; index += 1) {
    const raw = await pageSource.nextPage({
      authority,
      runId,
      workerFence: 1n,
      pageNumber: index + 1,
      sourceCheckpoint,
      sourceCheckpointFingerprint: checkpoint,
      signal: new AbortController().signal,
    });
    const page = validateProviderMixedPage(raw);
    pages.push({ raw, page });
    if (page.continuation === "head") return Object.freeze(pages);
    sourceCheckpoint = page.nextCursor;
    checkpoint = page.nextCursorFingerprint;
  }
  throw new Error("The capture source did not reach head within its test bound.");
}

function collectStrings(value: unknown, destination: Set<string>): void {
  if (typeof value === "string") {
    destination.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, destination);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, destination);
  }
}

test("the pinned ClutchPacks capture strictly validates with exact source counts", async (context) => {
  const sampleRoot = await requireSample(context);
  if (sampleRoot === null) return;
  const page = await readValidatedProviderCapture({
    captureRoot: sampleRoot,
    fileName: CLUTCHPACKS_CAPTURE_FILE_NAME,
    expectedSha256: CLUTCHPACKS_CAPTURE_SHA256,
    providerKey: "clutchpacks",
    signal: new AbortController().signal,
  });
  assert.deepEqual({
    catalog: page.catalog.length,
    pulls: page.pulls.length,
    sales: page.trades.length,
  }, { catalog: 14, pulls: 15, sales: 15 });
});

test("the ClutchPacks integration emits one deterministic full capture page and intentional pull quarantines", async (context) => {
  const sampleRoot = await requireSample(context);
  if (sampleRoot === null) return;
  const first = await allPages(source(sampleRoot));
  const replay = await allPages(source(sampleRoot));
  assert.equal(first.length, 1);
  const firstPage = first[0];
  assert.ok(firstPage);
  assert.equal(firstPage.page.records.length, 976);
  assert.ok(
    providerMixedPageCanonicalBytes(firstPage.raw).byteLength
      <= PROVIDER_MIXED_PAGE_MAX_BYTES,
  );
  assert.deepEqual(
    first.map(({ raw }) => providerMixedPageCanonicalBytes(raw).toString("hex")),
    replay.map(({ raw }) => providerMixedPageCanonicalBytes(raw).toString("hex")),
  );

  const records = first.flatMap(({ page }) => page.records);
  const catalog = records.filter(({ kind }) => kind === "catalog");
  const pulls = records.filter(({ kind }) => kind === "pull");
  const events = records.filter(({ kind }) => kind === "market_event");
  const byEntityType = (entityType: string) => catalog.filter(
    (record) => record.entityType === entityType,
  );
  assert.deepEqual({
    categories: byEntityType("category").length,
    packs: byEntityType("pack").length,
    collectibles: byEntityType("collectible").length,
    providerAccounts: byEntityType("provider_account").length,
    packContents: byEntityType("pack_content").length,
    pulls: pulls.length,
    marketEvents: events.length,
  }, {
    categories: 8,
    packs: 14,
    collectibles: 907,
    providerAccounts: 17,
    packContents: 0,
    pulls: 15,
    marketEvents: 15,
  });

  const collectibleKeys = new Set(
    byEntityType("collectible").map(({ candidate }) => candidate.collectibleKey),
  );
  assert.equal(pulls.every(({ candidate }) => candidate.packKey === null), true);
  assert.equal(pulls.every(({ candidate }) => (
    Array.isArray(candidate.items)
    && candidate.items.length === 1
    && typeof candidate.items[0] === "object"
    && candidate.items[0] !== null
    && collectibleKeys.has(candidate.items[0].collectibleKey)
  )), true);

  const packs = byEntityType("pack");
  assert.equal(packs.filter(({ candidate }) => candidate.priceAmount !== null).length, 14);
  assert.equal(packs.filter(({ candidate }) => candidate.vendorEvAmount !== null).length, 14);
  assert.equal(packs.filter(({ candidate }) => candidate.buybackRate !== null).length, 14);
  assert.equal(packs.filter(({ candidate }) => candidate.primaryImageUrl !== null).length, 14);
  const collectibles = byEntityType("collectible");
  assert.equal(
    collectibles.filter(({ candidate }) => candidate.valuationAmount !== null).length,
    15,
  );
  assert.equal(
    collectibles.filter(({ candidate }) => candidate.primaryImageUrl !== null).length,
    907,
  );
  assert.deepEqual(
    Object.fromEntries([...new Set(events.map(({ candidate }) => candidate.eventType))]
      .sort()
      .map((eventType) => [
        eventType,
        events.filter(({ candidate }) => candidate.eventType === eventType).length,
      ])),
    { mint: 6, sale: 7, ship: 2 },
  );
  assert.equal(events.filter(({ candidate }) => candidate.amount !== null).length, 13);
});

test("normalized pages contain no raw provider actors or transaction identifiers", async (context) => {
  const sampleRoot = await requireSample(context);
  if (sampleRoot === null) return;
  const capture = JSON.parse(await readFile(
    path.join(sampleRoot, CLUTCHPACKS_CAPTURE_FILE_NAME),
    "utf8",
  )) as {
    readonly pulls: readonly {
      readonly data: Readonly<Record<string, unknown>>;
    }[];
    readonly sales: readonly {
      readonly tx_hash: unknown;
      readonly data: Readonly<Record<string, unknown>>;
    }[];
  };
  const protectedValues = new Set<string>();
  for (const pull of capture.pulls) {
    const user = pull.data.user;
    if (user !== null && typeof user === "object" && !Array.isArray(user)) {
      for (const value of Object.values(user)) {
        if (typeof value === "string" && value.length > 0) protectedValues.add(value);
      }
    }
    const transactionId = pull.data.tx_hash;
    if (typeof transactionId === "string" && transactionId.length > 0) {
      protectedValues.add(transactionId);
    }
  }
  for (const sale of capture.sales) {
    for (const value of [sale.tx_hash, sale.data.from, sale.data.to]) {
      if (typeof value === "string" && value.length > 0) protectedValues.add(value);
    }
  }
  const normalizedValues = new Set<string>();
  for (const { raw } of await allPages(source(sampleRoot))) {
    collectStrings(raw, normalizedValues);
  }
  assert.equal(
    [...protectedValues].some((value) => normalizedValues.has(value)),
    false,
  );

  const accounts = (await allPages(source(sampleRoot)))
    .flatMap(({ page }) => page.records)
    .filter((record) => record.entityType === "provider_account");
  assert.equal(accounts.every(({ candidate }) => (
    typeof candidate.accountKey === "string"
    && /^[0-9a-f]{64}$/u.test(candidate.accountKey)
    && candidate.displayName === null
    && JSON.stringify(candidate.attributes) === "{}"
  )), true);
});

test("unknown capture adapters fail closed before any filesystem read", async () => {
  const unavailable = source("/server/root/that/does/not/exist");
  assert.equal(unavailable.supports(CLUTCHPACKS_CAPTURE_ADAPTER_KEY, "clutchpacks"), true);
  assert.equal(unavailable.supports(CLUTCHPACKS_CAPTURE_ADAPTER_KEY, "courtyard"), false);
  assert.equal(unavailable.supports("unknown-adapter", "clutchpacks"), false);
  await assert.rejects(
    unavailable.nextPage({
      authority: {
        ...authority,
        configuration: { adapterKey: "unknown-adapter" },
      },
      runId,
      workerFence: 1n,
      pageNumber: 1,
      sourceCheckpoint: null,
      sourceCheckpointFingerprint: null,
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof ProviderCaptureSourceError
      && error.code === "PROVIDER_SOURCE_ADAPTER_UNAVAILABLE",
  );
});

test("the capture reader rejects traversal and hash drift with public-safe codes", async (context) => {
  const sampleRoot = await requireSample(context);
  if (sampleRoot === null) return;
  await assert.rejects(
    readValidatedProviderCapture({
      captureRoot: sampleRoot,
      fileName: `..${path.sep}${CLUTCHPACKS_CAPTURE_FILE_NAME}`,
      expectedSha256: CLUTCHPACKS_CAPTURE_SHA256,
      providerKey: "clutchpacks",
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof ProviderCaptureSourceError
      && error.code === "PROVIDER_CAPTURE_ROOT_INVALID",
  );
  await assert.rejects(
    readValidatedProviderCapture({
      captureRoot: sampleRoot,
      fileName: CLUTCHPACKS_CAPTURE_FILE_NAME,
      expectedSha256: "0".repeat(64),
      providerKey: "clutchpacks",
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof ProviderCaptureSourceError
      && error.code === "PROVIDER_CAPTURE_HASH_MISMATCH",
  );
});

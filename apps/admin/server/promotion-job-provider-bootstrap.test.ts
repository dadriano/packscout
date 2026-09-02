import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { PinnedProviderReleaseInputs } from "@packscout/database";
import {
  PROVIDER_PROMOTION_BOOTSTRAP_COUNT_LIMITS,
  PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_FRAME_BYTES,
  PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_FRAMES,
  PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_STREAM_BYTES,
  PROVIDER_PROMOTION_BOOTSTRAP_SECTIONS,
} from "@packscout/contracts";
import {
  ProviderPromotionBootstrapService,
  type ProviderPromotionBootstrapStreamFrame,
  readProviderPromotionBootstrapCredentials,
} from "./promotion-job-provider-bootstrap.ts";

const providerA = "a7000000-0000-4000-8000-000000000001";
const providerB = "17000000-0000-4000-8000-000000000002";
const token = Buffer.alloc(32, 7);
const tokenBase64 = token.toString("base64");
const tokenSha256 = createHash("sha256").update(token).digest("hex");

function pin(): PinnedProviderReleaseInputs {
  return {
    providerId: providerA,
    providerKey: "courtyard",
    providerConfigVersionId: "17000000-0000-4000-8000-000000000003",
    providerConfigExpiresAt: new Date("2026-09-01T13:00:00.000Z"),
    staleAfterSeconds: 900,
    centralSchemaVersion: "distributed-central-v1",
    catalogVersionId: "17000000-0000-4000-8000-000000000004",
    catalogSchemaVersion: "catalog-v1",
    catalogContentHash: "1".repeat(64),
    catalogThroughChangeSequence: 41n,
    catalogCategories: [],
    catalogCollectibles: [],
    catalogAliases: [],
    catalogArtifactVerificationHash: "2".repeat(64),
    correlationEventSequence: 42n,
    correlationSnapshotHash: "3".repeat(64),
    categoryCorrelations: [{
      localCategoryId: "17000000-0000-4000-8000-000000000005",
      localEntityVersion: 8n,
      publicCategoryId: "17000000-0000-5000-8000-000000000006",
    }],
    collectibleCorrelations: [],
    publicProfileVersionId: "17000000-0000-4000-8000-000000000007",
    publicProfileHash: "4".repeat(64),
    publicProvider: {
      publicVendorId: "17000000-0000-5000-8000-000000000008",
      vendorKey: "courtyard",
      displayName: "Courtyard",
      logoUrl: null,
      websiteUrl: "https://courtyard.example",
      listingHosts: ["courtyard.example"],
      imageOrigins: [],
      referralParameters: [],
      publicPromo: null,
    },
  };
}

function credentials(value = JSON.stringify({ [providerA]: tokenSha256 })) {
  return readProviderPromotionBootstrapCredentials(value)!;
}

function ownership(signal = new AbortController().signal) {
  return { signal, deadlineAt: Date.now() + 30_000 } as const;
}

async function collect(
  stream: AsyncIterable<ProviderPromotionBootstrapStreamFrame>,
): Promise<readonly ProviderPromotionBootstrapStreamFrame[]> {
  const frames: ProviderPromotionBootstrapStreamFrame[] = [];
  for await (const frame of stream) frames.push(frame);
  return frames;
}

test("bootstrap credential configuration is provider-scoped and digest-only", () => {
  assert.equal(
    credentials().tokenSha256ByProviderId.get(providerA),
    tokenSha256,
  );
  assert.equal(readProviderPromotionBootstrapCredentials(undefined), null);
  for (const value of [
    "{}",
    JSON.stringify({ not_a_provider: tokenSha256 }),
    JSON.stringify({ [providerA]: "secret" }),
    JSON.stringify({
      [providerA]: tokenSha256,
      [providerA.toUpperCase()]: "a".repeat(64),
    }),
    JSON.stringify({
      [providerA]: tokenSha256,
      [providerB]: tokenSha256,
    }),
  ]) assert.throws(
    () => readProviderPromotionBootstrapCredentials(value),
    TypeError,
  );
});

test("bootstrap authorizes one provider before reading its central pin", async () => {
  let reads = 0;
  const service = new ProviderPromotionBootstrapService({
    credentials: credentials(),
    repository: {
      async pin() {
        reads += 1;
        return pin();
      },
    },
  });
  const result = await collect(await service.stream({
    providerId: providerA,
    bearerTokenBase64: tokenBase64,
    ...ownership(),
  }));
  assert.equal(reads, 1);
  const header = result[0];
  assert.equal(header?.kind, "header");
  if (header?.kind !== "header") return;
  const categoryPage = result.find((frame) =>
    frame.kind === "page" && frame.section === "categoryCorrelations");
  assert.deepEqual([
    header.pin.catalogThroughChangeSequence,
    header.pin.correlationEventSequence,
    categoryPage?.kind === "page"
      ? (categoryPage.records[0] as { localEntityVersion: string })
        .localEntityVersion
      : null,
    header.pin.providerConfigExpiresAt,
  ], ["41", "42", "8", "2026-09-01T13:00:00.000Z"]);
  assert.equal(result.at(-1)?.kind, "complete");

  for (const attempt of [
    { providerId: providerB, bearerTokenBase64: tokenBase64 },
    { providerId: providerA, bearerTokenBase64: Buffer.alloc(32, 8).toString("base64") },
    { providerId: providerA, bearerTokenBase64: "not-base64" },
  ]) await assert.rejects(service.stream({ ...attempt, ...ownership() }), {
    code: "PROVIDER_PROMOTION_BOOTSTRAP_UNAUTHORIZED",
    message: "Provider promotion bootstrap failed.",
  });
  assert.equal(reads, 1);
});

test("bootstrap rejects a repository response for another provider", async () => {
  const service = new ProviderPromotionBootstrapService({
    credentials: credentials(),
    repository: {
      async pin() {
        return { ...pin(), providerId: providerB };
      },
    },
  });
  await assert.rejects(service.stream({
    providerId: providerA,
    bearerTokenBase64: tokenBase64,
    ...ownership(),
  }), {
    code: "PROVIDER_PROMOTION_BOOTSTRAP_UNAVAILABLE",
  });
});

test("bootstrap rejects every retained section at the shared count limit plus one", async (context) => {
  for (const section of PROVIDER_PROMOTION_BOOTSTRAP_SECTIONS) {
    await context.test(section, async () => {
      assert.equal(PROVIDER_PROMOTION_BOOTSTRAP_COUNT_LIMITS[section], 50_000);
      let reads = 0;
      const service = new ProviderPromotionBootstrapService({
        credentials: credentials(),
        repository: {
          async pin() {
            reads += 1;
            return {
              ...pin(),
              [section]: new Array<never>(
                PROVIDER_PROMOTION_BOOTSTRAP_COUNT_LIMITS[section] + 1,
              ),
            };
          },
        },
      });

      await assert.rejects(service.stream({
        providerId: providerA,
        bearerTokenBase64: tokenBase64,
        ...ownership(),
      }), {
        name: "ProviderPromotionBootstrapError",
        code: "PROVIDER_PROMOTION_BOOTSTRAP_UNAVAILABLE",
        message: "Provider promotion bootstrap failed.",
      });
      assert.equal(reads, 1);
    });
  }
});

test("bootstrap reads one pin and emits a graph larger than 16 MiB in bounded frames", async () => {
  const padding = "x".repeat(640);
  const catalogCollectibles = Array.from({ length: 20_000 }, (_, index) => ({
    publicCollectibleId: `17000000-0000-5000-8000-${String(index)
      .padStart(12, "0")}`,
    identityState: "canonical" as const,
    collectibleType: "card" as const,
    displayName: `Card ${index} ${padding}`,
    normalizedName: `card ${index} ${padding}`,
    nameAliases: [],
    normalizedNameAliases: [],
    publicCategoryIds: [],
    year: null,
    brand: null,
    setOrSeries: null,
    cardNumber: null,
    referenceNumber: null,
    subject: null,
    grade: null,
    grader: null,
    primaryImageUrl: null,
    primaryImageAlt: null,
    valuationAmount: null,
    valuationCurrency: null,
    valuationUsdAmount: null,
    valuationUnavailableReason: null,
    valuationType: null,
    valuationObservedAt: null,
    dataAsOf: "2026-09-01T12:00:00.000Z",
  }));
  let reads = 0;
  const service = new ProviderPromotionBootstrapService({
    credentials: credentials(),
    repository: {
      async pin() {
        reads += 1;
        return { ...pin(), catalogCollectibles };
      },
    },
  });
  const frames = await collect(await service.stream({
    providerId: providerA,
    bearerTokenBase64: tokenBase64,
    ...ownership(),
  }));
  const byteLengths = frames.map((frame) =>
    Buffer.byteLength(`${JSON.stringify(frame)}\n`, "utf8"));
  assert.equal(reads, 1);
  assert.ok(byteLengths.reduce((total, bytes) => total + bytes, 0) >
    16 * 1_024 * 1_024);
  assert.ok(byteLengths.every((bytes) =>
    bytes <= PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_FRAME_BYTES));
  const pages = frames.filter((frame) =>
    frame.kind === "page" && frame.section === "catalogCollectibles");
  assert.ok(pages.length > 1);
  assert.equal(pages.reduce((total, frame) =>
    total + (frame.kind === "page" ? frame.records.length : 0), 0), 20_000);
});

test("bootstrap stops awaiting a central pin when request ownership aborts", async () => {
  const controller = new AbortController();
  let started!: () => void;
  const pinStarted = new Promise<void>((resolve) => { started = resolve; });
  let observedSignal: AbortSignal | null = null;
  let observedDeadlineAt: number | null = null;
  const service = new ProviderPromotionBootstrapService({
    credentials: credentials(),
    repository: {
      pin(input) {
        observedSignal = input.signal;
        observedDeadlineAt = input.deadlineAt;
        started();
        return new Promise<PinnedProviderReleaseInputs>(() => {});
      },
    },
  });
  const deadlineAt = Date.now() + 30_000;
  const pending = service.stream({
    providerId: providerA,
    bearerTokenBase64: tokenBase64,
    signal: controller.signal,
    deadlineAt,
  });
  await pinStarted;
  controller.abort();
  await assert.rejects(pending, {
    code: "PROVIDER_PROMOTION_BOOTSTRAP_UNAVAILABLE",
  });
  assert.equal(observedSignal, controller.signal);
  assert.equal(observedDeadlineAt, deadlineAt);
});

test("bootstrap deadline prevents and stops central pin work", async () => {
  let reads = 0;
  const service = new ProviderPromotionBootstrapService({
    credentials: credentials(),
    repository: {
      pin() {
        reads += 1;
        return new Promise<PinnedProviderReleaseInputs>(() => {});
      },
    },
  });
  const signal = new AbortController().signal;
  await assert.rejects(service.stream({
    providerId: providerA,
    bearerTokenBase64: tokenBase64,
    signal,
    deadlineAt: Date.now() - 1,
  }), { code: "PROVIDER_PROMOTION_BOOTSTRAP_UNAVAILABLE" });
  assert.equal(reads, 0);

  const startedAt = performance.now();
  await assert.rejects(service.stream({
    providerId: providerA,
    bearerTokenBase64: tokenBase64,
    signal,
    deadlineAt: Date.now() + 100,
  }), { code: "PROVIDER_PROMOTION_BOOTSTRAP_UNAVAILABLE" });
  assert.equal(reads, 1);
  assert.ok(performance.now() - startedAt < 1_000);
});

test("bootstrap serializes large correlation graphs lazily and cooperatively", async () => {
  let serializedVersions = 0;
  const categoryCorrelations = Array.from({ length: 10_000 }, (_, index) => {
    const correlation = {
      localCategoryId: `27000000-0000-4000-8000-${String(index + 1)
        .padStart(12, "0")}`,
      publicCategoryId: `37000000-0000-5000-8000-${String(index + 1)
        .padStart(12, "0")}`,
    } as Record<string, unknown>;
    Object.defineProperty(correlation, "localEntityVersion", {
      enumerable: true,
      get() {
        serializedVersions += 1;
        return 1n;
      },
    });
    return correlation;
  }) as unknown as PinnedProviderReleaseInputs["categoryCorrelations"];
  const controller = new AbortController();
  const service = new ProviderPromotionBootstrapService({
    credentials: credentials(),
    repository: {
      async pin() {
        return { ...pin(), categoryCorrelations };
      },
    },
  });

  const stream = await service.stream({
    providerId: providerA,
    bearerTokenBase64: tokenBase64,
    signal: controller.signal,
    deadlineAt: Date.now() + 30_000,
  });
  assert.equal(serializedVersions, 0);
  const iterator = stream[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.kind, "header");
  const firstPage = await iterator.next();
  assert.equal(firstPage.value?.kind, "page");
  assert.ok(serializedVersions > 0 && serializedVersions <= 251);
  const serializedBeforeAbort = serializedVersions;

  controller.abort();
  await assert.rejects(iterator.next(), {
    code: "PROVIDER_PROMOTION_BOOTSTRAP_UNAVAILABLE",
  });
  assert.equal(serializedVersions, serializedBeforeAbort);
});

test("bootstrap frames the full accepted collectible-correlation count lazily", {
  timeout: 30_000,
}, async (context) => {
  const correlation = Object.freeze({
    localCollectibleId: "57000000-0000-4000-8000-000000000001",
    localEntityVersion: 9_999_999_999_999_999_999n,
    publicCollectibleId: "56000000-0000-5000-8000-000000000001",
  });
  // Shared immutable records isolate producer framing. The worker constrained-
  // heap test uses distinct records for its consumer-memory proof.
  const collectibleCorrelations = Array(
    PROVIDER_PROMOTION_BOOTSTRAP_COUNT_LIMITS.collectibleCorrelations,
  ).fill(correlation) as PinnedProviderReleaseInputs["collectibleCorrelations"];
  const service = new ProviderPromotionBootstrapService({
    credentials: credentials(),
    repository: {
      async pin() {
        return { ...pin(), categoryCorrelations: [], collectibleCorrelations };
      },
    },
  });
  const stream = await service.stream({
    providerId: providerA,
    bearerTokenBase64: tokenBase64,
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 30_000,
  });

  let emittedBytes = 0;
  let emittedFrames = 0;
  let emittedCorrelations = 0;
  for await (const frame of stream) {
    const frameBytes = Buffer.byteLength(`${JSON.stringify(frame)}\n`, "utf8");
    assert.ok(frameBytes <= PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_FRAME_BYTES);
    emittedBytes += frameBytes;
    emittedFrames += 1;
    if (frame.kind === "page" && frame.section === "collectibleCorrelations") {
      emittedCorrelations += frame.records.length;
    }
  }

  assert.equal(
    emittedCorrelations,
    PROVIDER_PROMOTION_BOOTSTRAP_COUNT_LIMITS.collectibleCorrelations,
  );
  assert.ok(emittedBytes <= PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_STREAM_BYTES);
  assert.ok(emittedFrames <= PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_FRAMES);
  context.diagnostic(
    `correlations=${(emittedBytes / 1_024 / 1_024).toFixed(1)} MiB in ${emittedFrames} frames`,
  );
});

test("bootstrap frames the full accepted catalog-alias count lazily", {
  timeout: 30_000,
}, async (context) => {
  const alias = Object.freeze({
    aliasPublicCollectibleId: "56000000-0000-5000-8000-000000000001",
    canonicalPublicCollectibleId: "56000000-0000-5000-8000-000000000002",
  });
  // Shared immutable records isolate producer framing. The worker constrained-
  // heap test uses distinct records for its consumer-memory proof.
  const catalogAliases = Array(
    PROVIDER_PROMOTION_BOOTSTRAP_COUNT_LIMITS.catalogAliases,
  ).fill(alias) as PinnedProviderReleaseInputs["catalogAliases"];
  const service = new ProviderPromotionBootstrapService({
    credentials: credentials(),
    repository: {
      async pin() {
        return { ...pin(), catalogAliases };
      },
    },
  });
  const stream = await service.stream({
    providerId: providerA,
    bearerTokenBase64: tokenBase64,
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 30_000,
  });

  let emittedAliases = 0;
  let emittedBytes = 0;
  let emittedFrames = 0;
  for await (const frame of stream) {
    const frameBytes = Buffer.byteLength(`${JSON.stringify(frame)}\n`, "utf8");
    assert.ok(frameBytes <= PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_FRAME_BYTES);
    emittedBytes += frameBytes;
    emittedFrames += 1;
    if (frame.kind === "page" && frame.section === "catalogAliases") {
      emittedAliases += frame.records.length;
    }
  }

  assert.equal(
    emittedAliases,
    PROVIDER_PROMOTION_BOOTSTRAP_COUNT_LIMITS.catalogAliases,
  );
  assert.ok(emittedBytes <= PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_STREAM_BYTES);
  assert.ok(emittedFrames <= PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_FRAMES);
  context.diagnostic(
    `aliases=${(emittedBytes / 1_024 / 1_024).toFixed(1)} MiB in ${emittedFrames} frames`,
  );
});

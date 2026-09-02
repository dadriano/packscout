import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import {
  PROVIDER_PROMOTION_BOOTSTRAP_COUNT_LIMITS,
  PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_FRAME_BYTES,
  PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_STREAM_BYTES,
  PROVIDER_PROMOTION_BOOTSTRAP_SECTIONS,
  PROVIDER_PROMOTION_BOOTSTRAP_STREAM_CONTENT_TYPE,
  PROVIDER_PROMOTION_BOOTSTRAP_STREAM_VERSION,
  PROVIDER_PUBLIC_PROFILE_HASH_DOMAIN,
  normalizePublicSearchText,
  providerPromotionBootstrapSnapshotFingerprint,
  providerReleaseCatalogPinHash,
  providerReleaseCorrelationSnapshotHash,
  publicCatalogCollectibleSchema,
  sha256CanonicalJson,
} from "@packscout/contracts";
import {
  ProviderPromotionBootstrapGatewayClient,
} from "./distributed-promotion-gateway-clients.ts";
import { readProviderPromotionBootstrapStream } from
  "./distributed-promotion-bootstrap-stream.ts";
import { interruptibleSha256CanonicalJson } from
  "./interruptible-canonical-sha256.ts";

const providerId = "17000000-0000-4000-8000-000000000001";
const MEMORY_CHILD_ENV = "PACKSCOUT_BOOTSTRAP_MEMORY_CHILD";
const MEMORY_CHILD_HEAP_MIB = 256;
const options = (
  fetch: typeof globalThis.fetch,
  timeoutMilliseconds = 1_000,
) => ({
  baseUrl: "https://promotion-gateway.example",
  bearerToken: new Uint8Array(32).fill(7),
  timeoutMilliseconds,
  fetch,
});

const catalogCategoryId = "27000000-0000-5000-8000-000000000001";

function catalogCategory(
  displayName = "Cards",
): Record<string, unknown> {
  return {
    publicCategoryId: catalogCategoryId,
    parentPublicCategoryId: null,
    categoryKey: "cards",
    displayName,
    categoryKind: "vertical",
    displayOrder: 0,
    depth: 0,
    pathPublicCategoryIds: [catalogCategoryId],
    lifecycle: "active",
  };
}

function catalogCategoryAt(index: number): Record<string, unknown> {
  const publicCategoryId = `27000000-0000-5000-8000-${String(index)
    .padStart(12, "0")}`;
  return {
    ...catalogCategory(`Category ${index}`),
    publicCategoryId,
    categoryKey: `category-${index}`,
    pathPublicCategoryIds: [publicCategoryId],
  };
}

function catalogCollectible(
  index: number,
  aliasCount = 0,
): Record<string, unknown> {
  const displayName = `Card ${index}`;
  const nameAliases = Array.from({ length: aliasCount }, (_, aliasIndex) =>
    `card ${index} alias ${aliasIndex} ${"x".repeat(190)}`);
  return {
    publicCollectibleId: `37000000-0000-5000-8000-${String(index)
      .padStart(12, "0")}`,
    identityState: "canonical",
    collectibleType: "card",
    displayName,
    normalizedName: normalizePublicSearchText(displayName),
    nameAliases,
    normalizedNameAliases: nameAliases.map(normalizePublicSearchText),
    publicCategoryIds: [catalogCategoryId],
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
  };
}

function catalogAlias(index = 1): Record<string, unknown> {
  return {
    aliasPublicCollectibleId: `47000000-0000-5000-8000-${String(index)
      .padStart(12, "0")}`,
    canonicalPublicCollectibleId: `37000000-0000-5000-8000-${String(index)
      .padStart(12, "0")}`,
  };
}

test("raw catalog validation accepts canonical token-address valuations", () => {
  assert.equal(publicCatalogCollectibleSchema.safeParse({
    ...catalogCollectible(1),
    valuationAmount: "1",
    valuationCurrency: "0x1111111111111111111111111111111111111111",
    valuationUnavailableReason: "CURRENCY_UNSUPPORTED",
    valuationType: "market_estimate",
    valuationObservedAt: "2026-09-01T11:00:00.000Z",
  }).success, true);
});

test("incremental canonical hashing preserves roots and observes cancellation", async () => {
  const value = Array.from({ length: 10_000 }, (_, index) => ({
    index,
    nested: [true, null, `value-${index}`],
  }));
  const domain = "packscout.provider-promotion-bootstrap.hash-test.v1";
  assert.equal(
    await interruptibleSha256CanonicalJson(
      domain,
      value,
      new AbortController().signal,
    ),
    await sha256CanonicalJson(domain, value),
  );

  const controller = new AbortController();
  const pending = interruptibleSha256CanonicalJson(
    domain,
    value,
    controller.signal,
  );
  setTimeout(() => controller.abort(), 0);
  await assert.rejects(pending, { name: "AbortError" });
});

const publicProvider = {
  publicVendorId: "17000000-0000-5000-8000-000000000005",
  vendorKey: "courtyard",
  displayName: "Courtyard",
  logoUrl: null,
  websiteUrl: "https://courtyard.example",
  listingHosts: ["courtyard.example"],
  imageOrigins: [],
  referralParameters: [],
  publicPromo: null,
};

async function serializedPin(input: Readonly<{
  providerId?: string;
  catalogCategories?: readonly unknown[];
  catalogCollectibles?: readonly unknown[];
  catalogAliases?: readonly unknown[];
  categoryCorrelations?: readonly Readonly<{
    localCategoryId: string;
    localEntityVersion: string;
    publicCategoryId: string;
  }>[];
  collectibleCorrelations?: readonly Readonly<{
    localCollectibleId: string;
    localEntityVersion: string;
    publicCollectibleId: string;
  }>[];
}> = {}): Promise<Record<string, unknown>> {
  const pinProviderId = input.providerId ?? providerId;
  const catalogCategories = input.catalogCategories ?? [];
  const catalogCollectibles = input.catalogCollectibles ?? [];
  const catalogAliases = input.catalogAliases ?? [];
  const categoryCorrelations = input.categoryCorrelations ?? [];
  const collectibleCorrelations = input.collectibleCorrelations ?? [];
  const catalogVersionId = "17000000-0000-4000-8000-000000000003";
  const catalogSchemaVersion = "catalog-v1";
  const catalogContentHash = "1".repeat(64);
  const catalogThroughChangeSequence = "41";
  const correlationEventSequence = "42";
  return {
    providerId: pinProviderId,
    providerKey: "courtyard",
    providerConfigVersionId: "17000000-0000-4000-8000-000000000002",
    providerConfigExpiresAt: null,
    staleAfterSeconds: 900,
    centralSchemaVersion: "distributed-central-v1",
    catalogVersionId,
    catalogSchemaVersion,
    catalogContentHash,
    catalogThroughChangeSequence,
    catalogCategories,
    catalogCollectibles,
    catalogAliases,
    catalogArtifactVerificationHash: await providerReleaseCatalogPinHash({
      catalogVersionId,
      catalogSchemaVersion,
      catalogContentHash,
      catalogThroughChangeSequence,
      categories: catalogCategories as never[],
      collectibles: catalogCollectibles as never[],
      aliases: catalogAliases as never[],
    }),
    correlationEventSequence,
    correlationSnapshotHash: await providerReleaseCorrelationSnapshotHash({
      providerId: pinProviderId,
      correlationEventSequence,
      categories: categoryCorrelations,
      collectibles: collectibleCorrelations,
    }),
    categoryCorrelations,
    collectibleCorrelations,
    publicProfileVersionId: "17000000-0000-4000-8000-000000000004",
    publicProfileHash: await sha256CanonicalJson(
      PROVIDER_PUBLIC_PROFILE_HASH_DOMAIN,
      publicProvider,
    ),
    publicProvider,
  };
}

async function streamFrames(
  pin: Record<string, unknown>,
  recordsPerFrame = 250,
): Promise<readonly Record<string, unknown>[]> {
  const metadata = { ...pin };
  const counts = Object.fromEntries(
    PROVIDER_PROMOTION_BOOTSTRAP_SECTIONS.map((section) => {
      const records = pin[section] as readonly unknown[];
      delete metadata[section];
      return [section, records.length];
    }),
  );
  const snapshotFingerprint =
    await providerPromotionBootstrapSnapshotFingerprint({
      pin: metadata,
      counts: counts as never,
    });
  const frames: Record<string, unknown>[] = [{
    kind: "header",
    version: PROVIDER_PROMOTION_BOOTSTRAP_STREAM_VERSION,
    snapshotFingerprint,
    counts,
    pin: metadata,
  }];
  for (const section of PROVIDER_PROMOTION_BOOTSTRAP_SECTIONS) {
    const records = pin[section] as readonly unknown[];
    for (let offset = 0; offset < records.length; offset += recordsPerFrame) {
      frames.push({
        kind: "page",
        section,
        offset,
        records: records.slice(offset, offset + recordsPerFrame),
      });
    }
  }
  frames.push({ kind: "complete", snapshotFingerprint });
  return frames;
}

function streamResponse(
  frames: readonly Record<string, unknown>[],
  headers: Readonly<Record<string, string>> = {},
): Response {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const frame = frames[index];
      if (frame === undefined) {
        controller.close();
        return;
      }
      index += 1;
      controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
    },
  }), {
    status: 200,
    headers: {
      "content-type": `${PROVIDER_PROMOTION_BOOTSTRAP_STREAM_CONTENT_TYPE}; charset=utf-8`,
      ...headers,
    },
  });
}

function trackedStreamResponse(
  frames: readonly Record<string, unknown>[],
  onCancel: () => void,
): Response {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    ok: true,
    status: 200,
    headers: {
      get(name: string) {
        return name === "content-type"
          ? PROVIDER_PROMOTION_BOOTSTRAP_STREAM_CONTENT_TYPE
          : null;
      },
    },
    body: {
      getReader() {
        return {
          async read() {
            const frame = frames[index];
            if (frame === undefined) {
              return { done: true as const, value: undefined };
            }
            index += 1;
            return {
              done: false as const,
              value: encoder.encode(`${JSON.stringify(frame)}\n`),
            };
          },
          async cancel() { onCancel(); },
        };
      },
    },
  } as unknown as Response;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function runConstrainedMemoryChild(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      `--max-old-space-size=${MEMORY_CHILD_HEAP_MIB}`,
      "--import",
      "tsx",
      "--test",
      "--test-name-pattern=^bootstrap accepts the maximum-count representative consumer graph$",
      fileURLToPath(import.meta.url),
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_TEST_CONTEXT: undefined,
        [MEMORY_CHILD_ENV]: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (value: string) => {
      output += value;
    });
    child.stderr.setEncoding("utf8").on("data", (value: string) => {
      output += value;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve(output);
      else reject(new Error(
        `Constrained bootstrap child failed (${String(code ?? signal)}).\n${output}`,
      ));
    });
  });
}

function blockPostEofValidationDigest(context: TestContext) {
  const prototype = Object.getPrototypeOf(createHash("sha256")) as {
    digest(encoding: "hex"): string;
  };
  const originalDigest = prototype.digest;
  const started = deferred();
  context.mock.method(
    prototype,
    "digest",
    async function (this: typeof prototype, encoding: "hex") {
      started.resolve();
      await new Promise<void>(() => {});
      return originalDigest.call(this, encoding);
    },
  );
  return started.promise;
}

test("provider bootstrap uses the provider-bound framed machine route", async () => {
  let observedUrl = "";
  let observedAuthorization = "";
  let observedBody: unknown;
  const frames = await streamFrames(await serializedPin());
  const client = new ProviderPromotionBootstrapGatewayClient(options(
    (async (request, init) => {
      observedUrl = String(request);
      observedAuthorization = String(
        (init?.headers as Record<string, string>).authorization,
      );
      observedBody = JSON.parse(String(init?.body)) as unknown;
      return streamResponse(frames);
    }) as typeof globalThis.fetch,
  ));
  const pin = await client.load(providerId);
  assert.equal(pin.providerId, providerId);
  assert.equal(pin.catalogThroughChangeSequence, 41n);
  assert.equal(
    observedUrl,
    "https://promotion-gateway.example/api/internal/promotion-jobs/provider-bootstrap",
  );
  assert.equal(
    observedAuthorization,
    `Bearer ${Buffer.from(new Uint8Array(32).fill(7)).toString("base64")}`,
  );
  assert.deepEqual(observedBody, {
    providerId,
    requestBudgetMilliseconds: 1_000,
  });
});

test("gateway refuses redirects and non-framed response shapes", async () => {
  let redirect: string | undefined;
  const client = new ProviderPromotionBootstrapGatewayClient(options(
    (async (_request, init) => {
      redirect = init?.redirect;
      return new Response(JSON.stringify({ pin: { untrusted: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch,
  ));
  await assert.rejects(client.load(providerId), {
    code: "DISTRIBUTED_PROMOTION_GATEWAY_RESPONSE_INVALID",
  });
  assert.equal(redirect, "error");
});

test("gateway rejects every declared section count at the shared limit plus one", async (context) => {
  const serialized = await serializedPin();
  const metadata = { ...serialized };
  for (const section of PROVIDER_PROMOTION_BOOTSTRAP_SECTIONS) {
    delete metadata[section];
  }

  for (const section of PROVIDER_PROMOTION_BOOTSTRAP_SECTIONS) {
    await context.test(section, async () => {
      assert.equal(PROVIDER_PROMOTION_BOOTSTRAP_COUNT_LIMITS[section], 50_000);
      const counts = Object.fromEntries(
        PROVIDER_PROMOTION_BOOTSTRAP_SECTIONS.map((candidate) => [
          candidate,
          candidate === section
            ? PROVIDER_PROMOTION_BOOTSTRAP_COUNT_LIMITS[candidate] + 1
            : 0,
        ]),
      );
      const client = new ProviderPromotionBootstrapGatewayClient(options(
        (async () => streamResponse([{
          kind: "header",
          version: PROVIDER_PROMOTION_BOOTSTRAP_STREAM_VERSION,
          snapshotFingerprint: "f".repeat(64),
          counts,
          pin: metadata,
        }])) as typeof globalThis.fetch,
      ));

      await assert.rejects(client.load(providerId), {
        name: "DistributedPromotionGatewayResponseError",
        code: "DISTRIBUTED_PROMOTION_GATEWAY_RESPONSE_INVALID",
        message: "Distributed promotion gateway response is invalid.",
      });
    });
  }
});

test("caller abort reaches the in-flight fetch without exposing its reason", async () => {
  let fetchSignal: AbortSignal | null = null;
  let fetchAborted = false;
  const client = new ProviderPromotionBootstrapGatewayClient(options(
    ((_request, init) => {
      fetchSignal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        fetchSignal!.addEventListener("abort", () => {
          fetchAborted = true;
          reject(new DOMException("secret caller reason", "AbortError"));
        }, { once: true });
      });
    }) as typeof globalThis.fetch,
  ));
  const controller = new AbortController();
  const pending = client.load(providerId, controller.signal);
  controller.abort(new Error("secret caller reason"));
  await assert.rejects(pending, {
    code: "DISTRIBUTED_PROMOTION_GATEWAY_ABORTED",
    message: "Distributed promotion gateway request was aborted.",
  });
  assert.ok(fetchSignal);
  assert.equal(fetchAborted, true);
});

test("bootstrap accepts a framed graph larger than the former 16 MiB cap", async () => {
  const catalogCollectibles = Array.from(
    { length: 1_500 },
    (_, index) => catalogCollectible(index + 1, 32),
  );
  const frames = await streamFrames(
    await serializedPin({ catalogCollectibles }),
    1,
  );
  const totalBytes = frames.reduce((total, frame) =>
    total + Buffer.byteLength(`${JSON.stringify(frame)}\n`, "utf8"), 0);
  assert.ok(totalBytes > 16 * 1_024 * 1_024);
  assert.ok(frames.every((frame) =>
    Buffer.byteLength(`${JSON.stringify(frame)}\n`, "utf8") <=
      PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_FRAME_BYTES));
  const client = new ProviderPromotionBootstrapGatewayClient(options(
    (async () => streamResponse(frames)) as typeof globalThis.fetch,
    30_000,
  ));
  const pin = await client.load(providerId);
  assert.equal(pin.catalogCollectibles.length, 1_500);
});

test("bootstrap accepts the maximum-count representative consumer graph", {
  timeout: 120_000,
}, async (context) => {
  if (process.env[MEMORY_CHILD_ENV] !== "1") {
    const output = await runConstrainedMemoryChild();
    const measurement = output.match(
      /maximum-count bootstrap wire=[^\n]+/u,
    )?.[0];
    assert.ok(measurement, output);
    context.diagnostic(
      `${MEMORY_CHILD_HEAP_MIB} MiB V8 old-space child: ${measurement}`,
    );
    return;
  }
  const catalogCategories = Array.from(
    { length: PROVIDER_PROMOTION_BOOTSTRAP_COUNT_LIMITS.catalogCategories },
    (_, index) => catalogCategoryAt(index + 1),
  );
  const catalogCollectibles = Array.from(
    { length: PROVIDER_PROMOTION_BOOTSTRAP_COUNT_LIMITS.catalogCollectibles },
    (_, index) => catalogCollectible(index + 1),
  );
  const catalogAliases = Array.from(
    { length: PROVIDER_PROMOTION_BOOTSTRAP_COUNT_LIMITS.catalogAliases },
    (_, index) => catalogAlias(index + 1),
  );
  const categoryCorrelations = Array.from(
    { length: PROVIDER_PROMOTION_BOOTSTRAP_COUNT_LIMITS.categoryCorrelations },
    (_, index) => ({
      localCategoryId: `57000000-0000-4000-8000-${String(index + 1)
        .padStart(12, "0")}`,
      localEntityVersion: "1",
      publicCategoryId: catalogCategoryId,
    }),
  );
  const collectibleCorrelations = catalogCollectibles.map((collectible, index) => ({
    localCollectibleId: `57000000-0000-4000-8000-${String(index + 1)
      .padStart(12, "0")}`,
    localEntityVersion: "1",
    publicCollectibleId: collectible.publicCollectibleId as string,
  }));
  const frames = await streamFrames(await serializedPin({
    catalogCategories,
    catalogCollectibles,
    catalogAliases,
    categoryCorrelations,
    collectibleCorrelations,
  }));
  const totalBytes = frames.reduce((total, frame) =>
    total + Buffer.byteLength(`${JSON.stringify(frame)}\n`, "utf8"), 0);
  assert.ok(totalBytes > 64 * 1_024 * 1_024);
  assert.ok(totalBytes < PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_STREAM_BYTES);

  const client = new ProviderPromotionBootstrapGatewayClient(options(
    (async () => streamResponse(frames)) as typeof globalThis.fetch,
    30_000,
  ));
  const pin = await client.load(providerId);
  assert.equal(
    pin.catalogCategories.length,
    PROVIDER_PROMOTION_BOOTSTRAP_COUNT_LIMITS.catalogCategories,
  );
  assert.equal(
    pin.catalogCollectibles.length,
    PROVIDER_PROMOTION_BOOTSTRAP_COUNT_LIMITS.catalogCollectibles,
  );
  assert.equal(
    pin.catalogAliases.length,
    PROVIDER_PROMOTION_BOOTSTRAP_COUNT_LIMITS.catalogAliases,
  );
  assert.equal(
    pin.categoryCorrelations.length,
    PROVIDER_PROMOTION_BOOTSTRAP_COUNT_LIMITS.categoryCorrelations,
  );
  assert.equal(
    pin.collectibleCorrelations.length,
    PROVIDER_PROMOTION_BOOTSTRAP_COUNT_LIMITS.collectibleCorrelations,
  );
  context.diagnostic(
    `maximum-count bootstrap wire=${(totalBytes / 1_024 / 1_024).toFixed(1)} MiB; ` +
      `process maxRSS=${(process.resourceUsage().maxRSS / 1_024).toFixed(1)} MiB`,
  );
});

test("gateway rejects an oversized frame and declared stream total at +1", async () => {
  const oversizedFrame = new Uint8Array(
    PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_FRAME_BYTES,
  );
  const frameClient = new ProviderPromotionBootstrapGatewayClient(options(
    (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversizedFrame);
        controller.close();
      },
    }), {
      status: 200,
      headers: { "content-type": PROVIDER_PROMOTION_BOOTSTRAP_STREAM_CONTENT_TYPE },
    })) as typeof globalThis.fetch,
  ));
  await assert.rejects(frameClient.load(providerId), {
    code: "DISTRIBUTED_PROMOTION_GATEWAY_RESPONSE_INVALID",
  });

  const totalClient = new ProviderPromotionBootstrapGatewayClient(options(
    (async () => new Response(new ReadableStream<Uint8Array>(), {
      status: 200,
      headers: {
        "content-type": PROVIDER_PROMOTION_BOOTSTRAP_STREAM_CONTENT_TYPE,
        "content-length": String(
          PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_STREAM_BYTES + 1,
        ),
      },
    })) as typeof globalThis.fetch,
  ));
  await assert.rejects(totalClient.load(providerId), {
    code: "DISTRIBUTED_PROMOTION_GATEWAY_RESPONSE_INVALID",
  });
});

test("gateway rejects the actual streamed byte total at +1", async () => {
  let cancelled = false;
  const response = {
    headers: {
      get(name: string) {
        return name === "content-type"
          ? PROVIDER_PROMOTION_BOOTSTRAP_STREAM_CONTENT_TYPE
          : null;
      },
    },
    body: {
      getReader() {
        return {
          async read() {
            return {
              done: false as const,
              value: {
                byteLength:
                  PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_STREAM_BYTES + 1,
              } as Uint8Array,
            };
          },
          async cancel() { cancelled = true; },
        };
      },
    },
  } as unknown as Response;

  await assert.rejects(
    readProviderPromotionBootstrapStream(
      response,
      providerId,
      new AbortController().signal,
    ),
    { code: "DISTRIBUTED_PROMOTION_GATEWAY_RESPONSE_INVALID" },
  );
  assert.equal(cancelled, true);
});

test("caller abort interrupts scanning an oversized undelimited chunk", async () => {
  let cancelled = false;
  let sent = false;
  const response = {
    ok: true,
    status: 200,
    headers: {
      get(name: string) {
        return name === "content-type"
          ? PROVIDER_PROMOTION_BOOTSTRAP_STREAM_CONTENT_TYPE
          : null;
      },
    },
    body: {
      getReader() {
        return {
          async read() {
            if (sent) return { done: true as const, value: undefined };
            sent = true;
            return {
              done: false as const,
              value: new Uint8Array(8 * 1_024 * 1_024),
            };
          },
          async cancel() { cancelled = true; },
        };
      },
    },
  } as unknown as Response;
  const client = new ProviderPromotionBootstrapGatewayClient(options(
    (async () => response) as typeof globalThis.fetch,
  ));
  const controller = new AbortController();
  const pending = client.load(providerId, controller.signal);
  setTimeout(() => controller.abort(), 0);
  await assert.rejects(pending, {
    code: "DISTRIBUTED_PROMOTION_GATEWAY_ABORTED",
  });
  assert.equal(cancelled, true);
});

test("gateway rejects missing, reordered, and offset-skipping frames", async () => {
  const pin = await serializedPin({ catalogCategories: [catalogCategory()] });
  const valid = [...await streamFrames(pin, 1)];
  const cases = [
    valid.slice(0, -1),
    [valid[0]!, valid.at(-1)!, ...valid.slice(1, -1)],
    valid.map((frame) => frame.kind === "page"
      ? { ...frame, offset: 1 }
      : frame),
  ];
  for (const frames of cases) {
    const client = new ProviderPromotionBootstrapGatewayClient(options(
      (async () => streamResponse(frames)) as typeof globalThis.fetch,
    ));
    await assert.rejects(client.load(providerId), {
      code: "DISTRIBUTED_PROMOTION_GATEWAY_RESPONSE_INVALID",
    });
  }
});

test("gateway rejects page tampering and a valid stream for another provider", async () => {
  const original = [...await streamFrames(await serializedPin({
    catalogCategories: [catalogCategory("Original")],
  }), 1)];
  const tampered = original.map((frame) =>
    frame.kind === "page" && frame.section === "catalogCategories"
      ? { ...frame, records: [catalogCategory("Tampered")] }
      : frame);
  const otherProvider = "27000000-0000-4000-8000-000000000009";
  const wrongScope = await streamFrames(await serializedPin({
    providerId: otherProvider,
  }));

  for (const frames of [tampered, wrongScope]) {
    const client = new ProviderPromotionBootstrapGatewayClient(options(
      (async () => streamResponse(frames)) as typeof globalThis.fetch,
    ));
    await assert.rejects(client.load(providerId), {
      code: "DISTRIBUTED_PROMOTION_GATEWAY_RESPONSE_INVALID",
    });
  }
});

test("gateway strictly validates every catalog record shape", async () => {
  const malformedPins = await Promise.all([
    serializedPin({
      catalogCategories: [{ ...catalogCategory(), unexpected: true }],
    }),
    serializedPin({
      catalogCollectibles: [{ ...catalogCollectible(1), displayName: 7 }],
    }),
    serializedPin({
      catalogAliases: [{
        ...catalogAlias(),
        canonicalPublicCollectibleId: "not-a-public-id",
      }],
    }),
  ]);
  for (const malformedPin of malformedPins) {
    const frames = await streamFrames(malformedPin, 1);
    const client = new ProviderPromotionBootstrapGatewayClient(options(
      (async () => streamResponse(frames)) as typeof globalThis.fetch,
    ));
    await assert.rejects(client.load(providerId), {
      code: "DISTRIBUTED_PROMOTION_GATEWAY_RESPONSE_INVALID",
    });
  }
});

test("caller abort during post-EOF validation cannot return a pin", async (context) => {
  const frames = await streamFrames(await serializedPin());
  const validationStarted = blockPostEofValidationDigest(context);
  let cancellations = 0;
  const client = new ProviderPromotionBootstrapGatewayClient(options(
    (async () => trackedStreamResponse(
      frames,
      () => { cancellations += 1; },
    )) as typeof globalThis.fetch,
  ));
  const controller = new AbortController();
  const pending = client.load(providerId, controller.signal);
  await validationStarted;
  controller.abort(new Error("secret post-EOF abort reason"));

  await assert.rejects(pending, {
    code: "DISTRIBUTED_PROMOTION_GATEWAY_ABORTED",
    message: "Distributed promotion gateway request was aborted.",
  });
  assert.equal(cancellations, 1);
});

test("timeout during post-EOF validation cannot return a pin", async (context) => {
  const frames = await streamFrames(await serializedPin());
  const validationStarted = blockPostEofValidationDigest(context);
  let cancellations = 0;
  let requestSignal: AbortSignal | null = null;
  const client = new ProviderPromotionBootstrapGatewayClient(options(
    (async (_request, init) => {
      requestSignal = init?.signal as AbortSignal;
      return trackedStreamResponse(
        frames,
        () => { cancellations += 1; },
      );
    }) as typeof globalThis.fetch,
    500,
  ));
  const startedAt = performance.now();
  const pending = client.load(providerId);
  await validationStarted;

  await assert.rejects(pending, {
    code: "DISTRIBUTED_PROMOTION_GATEWAY_UNAVAILABLE",
  });
  const activeRequestSignal = requestSignal as unknown as AbortSignal;
  assert.ok(activeRequestSignal);
  assert.equal(activeRequestSignal.aborted, true);
  assert.ok(performance.now() - startedAt < 2_000);
  assert.equal(cancellations, 1);
});

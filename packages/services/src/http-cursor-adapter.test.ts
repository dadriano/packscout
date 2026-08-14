import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ProviderHttpResponseDecoderV2,
  ProviderTransportPageInput,
} from "./provider-adapter.ts";
import { ProviderTransportRequestError } from "./provider-adapter.ts";
import {
  HttpCursorAdapter,
  type HttpCursorAdapterDependencies,
  type ProviderDnsResolver,
  type ProviderHttpClient,
} from "./http-cursor-adapter.ts";

const platform = "fixture-platform";
const providerHost = "provider.invalid";
const publicAddress = "93.184.216.34";
const resolvePublicHost: ProviderDnsResolver = async () => [publicAddress];

const fixtureRecords = [
  {
    stream: "catalog",
    platform,
    entity: "pack",
    record_id: "fixture-pack-001",
    first_seen_at: "2026-08-12T03:04:05.000Z",
    occurred_at: "2026-08-13T03:04:05.000Z",
    collected_at: "2026-08-13T03:05:00.000Z",
    data: { nested: { values: [1, null, "opaque"] } },
  },
  {
    stream: "pulls",
    platform,
    record_id: "fixture-pull-001",
    pack_id: "fixture-pack-001",
    card_id: null,
    occurred_at: "2026-08-13T03:04:05.000Z",
    collected_at: "2026-08-13T03:05:00.000Z",
    data: { outcome: "pending" },
  },
  {
    stream: "trades",
    platform,
    record_id: "fixture-trade-001",
    card_id: "fixture-card-001",
    event_type: "list",
    amount: 50,
    currency: "USDC",
    tx_hash: "fixture-transaction-001",
    occurred_at: "2026-08-13T03:04:05.000Z",
    collected_at: "2026-08-13T03:05:00.000Z",
    data: { actor: "sanitized" },
  },
] as const;

function validWrapper(overrides: Record<string, unknown> = {}) {
  return {
    fixture_records: fixtureRecords,
    fixture_next_cursor: "fixture:cursor:complete",
    fixture_has_more: false,
    ...overrides,
  };
}

const fixtureJsonDecoder: ProviderHttpResponseDecoderV2 = {
  decode(input) {
    let rawPage: unknown;
    try {
      rawPage = JSON.parse(input.bodyText) as unknown;
    } catch {
      return { ok: false, code: "invalid_json" };
    }
    if (typeof rawPage !== "object" || rawPage === null) {
      return {
        ok: false,
        code: "invalid_response",
        fieldPaths: ["$"],
        issueCodes: ["invalid_type"],
      };
    }
    const wrapper = rawPage as Record<string, unknown>;
    return {
      ok: true,
      page: {
        rawPage,
        records: wrapper.fixture_records,
        nextCursor: wrapper.fixture_next_cursor,
        hasMore: wrapper.fixture_has_more,
      },
    };
  },
};

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function pageInput(
  overrides: Partial<ProviderTransportPageInput> = {},
): ProviderTransportPageInput {
  return {
    endpoint: `https://${providerHost}/feed`,
    allowedHosts: [providerHost],
    platform,
    cursor: null,
    auth: { mode: "none" },
    ...overrides,
  };
}

function createAdapter(
  dependencies: Partial<HttpCursorAdapterDependencies> = {},
): HttpCursorAdapter {
  return new HttpCursorAdapter({
    decoder: fixtureJsonDecoder,
    resolveHost: resolvePublicHost,
    ...dependencies,
  });
}

async function captureRequestError(
  operation: Promise<unknown>,
): Promise<ProviderTransportRequestError> {
  try {
    await operation;
  } catch (error) {
    assert.ok(error instanceof ProviderTransportRequestError);
    return error;
  }
  assert.fail("Expected provider transport request to fail.");
}

test("requests send only platform and an optional opaque cursor", async () => {
  const requests: { url: URL; init: RequestInit | undefined }[] = [];
  const httpClient: ProviderHttpClient = async (input, init) => {
    requests.push({ url: new URL(String(input)), init });
    return jsonResponse(validWrapper());
  };
  const adapter = createAdapter({ httpClient });

  await adapter.fetchPage(
    pageInput({
      endpoint:
        `https://${providerHost}/feed?existing=kept&cursor=configured-value#ignored`,
    }),
  );
  const opaqueCursor = "opaque/+?&=% cursor \u96ea";
  await adapter.fetchPage(pageInput({ cursor: opaqueCursor }));

  assert.equal(requests[0]?.url.searchParams.get("platform"), platform);
  assert.equal(requests[0]?.url.searchParams.has("existing"), false);
  assert.equal(requests[0]?.url.searchParams.has("cursor"), false);
  assert.equal(requests[0]?.url.searchParams.has("stream"), false);
  assert.deepEqual([...requests[0]!.url.searchParams.keys()], ["platform"]);
  assert.equal(requests[0]?.url.hash, "");
  assert.equal(requests[1]?.url.searchParams.get("cursor"), opaqueCursor);
  assert.deepEqual([...requests[1]!.url.searchParams.keys()], ["platform", "cursor"]);
  assert.equal(requests[1]?.init?.method, "GET");
  assert.equal(requests[1]?.init?.redirect, "manual");
});

test("none and bearer authentication produce only the configured authorization behavior", async () => {
  const authorizationValues: (string | null)[] = [];
  const httpClient: ProviderHttpClient = async (_input, init) => {
    authorizationValues.push(new Headers(init?.headers).get("authorization"));
    return jsonResponse(validWrapper());
  };
  const adapter = createAdapter({ httpClient });

  await adapter.fetchPage(pageInput({ auth: { mode: "none" } }));
  await adapter.fetchPage(
    pageInput({ auth: { mode: "bearer", token: "fixture-secret-token" } }),
  );
  assert.deepEqual(authorizationValues, [null, "Bearer fixture-secret-token"]);
});

test("the exact-host allowlist rejects lookalikes before DNS or bearer request", async () => {
  let resolutionCount = 0;
  let requestCount = 0;
  const adapter = new HttpCursorAdapter({
    decoder: fixtureJsonDecoder,
    resolveHost: async () => {
      resolutionCount += 1;
      return [publicAddress];
    },
    httpClient: async () => {
      requestCount += 1;
      return jsonResponse(validWrapper());
    },
  });
  const error = await captureRequestError(
    adapter.fetchPage(
      pageInput({
        endpoint: "https://provider.invalid.attacker.example/feed",
        auth: { mode: "bearer", token: "fixture-secret-token" },
      }),
    ),
  );
  assert.deepEqual(error.failure, {
    code: "destination_not_allowed",
    retryable: false,
  });
  assert.equal(resolutionCount, 0);
  assert.equal(requestCount, 0);
});

test("private, loopback, link-local, documentation, and reserved destinations fail closed", async () => {
  const rejectedAddresses = [
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.1.1",
    "172.16.0.1",
    "192.0.2.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "3fff::1",
  ];
  for (const address of rejectedAddresses) {
    let requested = false;
    const adapter = new HttpCursorAdapter({
      decoder: fixtureJsonDecoder,
      resolveHost: async () => [address],
      httpClient: async () => {
        requested = true;
        return jsonResponse(validWrapper());
      },
    });
    const error = await captureRequestError(
      adapter.fetchPage(
        pageInput({ auth: { mode: "bearer", token: "fixture-secret-token" } }),
      ),
    );
    assert.equal(error.failure.code, "destination_not_allowed", address);
    assert.equal(requested, false, address);
  }
});

test("public IPv4 and IPv6 DNS answers can reach the allowlisted host", async () => {
  for (const address of [publicAddress, "2606:4700:4700::1111"] as const) {
    let requested = false;
    const adapter = new HttpCursorAdapter({
      decoder: fixtureJsonDecoder,
      resolveHost: async () => [address],
      httpClient: async () => {
        requested = true;
        return jsonResponse(validWrapper());
      },
    });
    await adapter.fetchPage(pageInput());
    assert.equal(requested, true, address);
  }
});

test("the validated DNS result is passed to the request client as a connection pin", async () => {
  let resolutionCount = 0;
  const httpClient: ProviderHttpClient = async (input, _init, destination) => {
    assert.equal(new URL(String(input)).hostname, providerHost);
    assert.deepEqual(destination, {
      hostname: providerHost,
      addresses: [publicAddress],
    });
    return jsonResponse(validWrapper());
  };
  const adapter = new HttpCursorAdapter({
    decoder: fixtureJsonDecoder,
    resolveHost: async () => {
      resolutionCount += 1;
      return [publicAddress];
    },
    httpClient,
  });

  await adapter.fetchPage(pageInput());

  assert.equal(resolutionCount, 1);
});

test("a private IP endpoint is rejected directly even if a resolver claims it is public", async () => {
  let resolved = false;
  let requested = false;
  const adapter = new HttpCursorAdapter({
    decoder: fixtureJsonDecoder,
    resolveHost: async () => {
      resolved = true;
      return [publicAddress];
    },
    httpClient: async () => {
      requested = true;
      return jsonResponse(validWrapper());
    },
  });
  const error = await captureRequestError(
    adapter.fetchPage(
      pageInput({
        endpoint: "https://127.0.0.1/feed",
        allowedHosts: ["127.0.0.1"],
      }),
    ),
  );
  assert.equal(error.failure.code, "destination_not_allowed");
  assert.equal(resolved, false);
  assert.equal(requested, false);
});

test("DNS errors, empty answers, invalid answers, and mixed public/private answers do not send requests", async () => {
  const resolutions: readonly (() => Promise<readonly string[]>)[] = [
    async () => {
      throw new Error("resolver failure");
    },
    async () => [],
    async () => ["not-an-ip"],
    async () => [publicAddress, "127.0.0.1"],
  ];
  for (const resolveHost of resolutions) {
    let requested = false;
    const adapter = new HttpCursorAdapter({
      decoder: fixtureJsonDecoder,
      resolveHost,
      httpClient: async () => {
        requested = true;
        return jsonResponse(validWrapper());
      },
    });
    const error = await captureRequestError(adapter.fetchPage(pageInput()));
    assert.equal(
      error.failure.code === "destination_resolution_failed" ||
        error.failure.code === "destination_not_allowed",
      true,
    );
    assert.equal(requested, false);
  }
});

test("HTTP and network failures are normalized without body or secret leakage", async () => {
  const secret = "fixture-do-not-leak";
  const rawBody = "fixture-raw-provider-body";
  let responseBodyCancelled = false;
  const httpAdapter = createAdapter({
    httpClient: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(rawBody));
          },
          cancel() {
            responseBodyCancelled = true;
          },
        }),
        { status: 503 },
      ),
  });
  const httpError = await captureRequestError(
    httpAdapter.fetchPage(
      pageInput({ auth: { mode: "bearer", token: secret } }),
    ),
  );
  assert.deepEqual(httpError.failure, {
    code: "http_error",
    retryable: true,
    httpStatus: 503,
  });
  assert.equal(responseBodyCancelled, true);
  const serialized = `${httpError.message} ${httpError.stack} ${JSON.stringify(httpError.failure)}`;
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.doesNotMatch(serialized, new RegExp(rawBody));

  const networkAdapter = createAdapter({
    httpClient: async () => {
      throw new Error(`upstream included ${secret}`);
    },
  });
  const networkError = await captureRequestError(
    networkAdapter.fetchPage(
      pageInput({ auth: { mode: "bearer", token: secret } }),
    ),
  );
  assert.deepEqual(networkError.failure, {
    code: "network_error",
    retryable: true,
  });
  assert.doesNotMatch(
    `${networkError.message} ${networkError.stack} ${JSON.stringify(networkError.failure)}`,
    new RegExp(secret),
  );
  assert.equal(Object.hasOwn(networkError, "cause"), false);
});

test("response size, JSON, and page-structure failures use bounded safe errors", async () => {
  let declaredOversizeBodyCancelled = false;
  const oversizedAdapter = createAdapter({
    httpClient: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            declaredOversizeBodyCancelled = true;
          },
        }),
        { headers: { "content-length": "64" } },
      ),
  });
  const oversized = await captureRequestError(
    oversizedAdapter.fetchPage(pageInput({ maxResponseBytes: 16 })),
  );
  assert.equal(oversized.failure.code, "response_too_large");
  assert.equal(declaredOversizeBodyCancelled, true);

  const streamedOversizedAdapter = createAdapter({
    httpClient: async () => new Response("x".repeat(64)),
  });
  const streamedOversized = await captureRequestError(
    streamedOversizedAdapter.fetchPage(pageInput({ maxResponseBytes: 16 })),
  );
  assert.equal(streamedOversized.failure.code, "response_too_large");

  const invalidJsonAdapter = createAdapter({
    httpClient: async () => new Response("{not-json}"),
  });
  const invalidJson = await captureRequestError(
    invalidJsonAdapter.fetchPage(pageInput()),
  );
  assert.equal(invalidJson.failure.code, "invalid_json");

  const rawValue = "fixture-private-nested-value";
  const invalidStructureAdapter = createAdapter({
    httpClient: async () =>
      jsonResponse({
        rawValue,
        fixture_next_cursor: "next",
        fixture_has_more: false,
      }),
  });
  const invalidStructure = await captureRequestError(
    invalidStructureAdapter.fetchPage(pageInput()),
  );
  assert.deepEqual(invalidStructure.failure, {
    code: "invalid_response",
    retryable: false,
    fieldPaths: ["records"],
    issueCodes: ["invalid_type"],
  });
  assert.doesNotMatch(
    `${invalidStructure.message} ${JSON.stringify(invalidStructure.failure)}`,
    new RegExp(rawValue),
  );
});

test("mixed V2 failures return raw evidence, valid records, and stable invalid outcomes", async () => {
  const rawValue = "fixture-protected-value";
  const records = [
    fixtureRecords[0],
    {
      ...fixtureRecords[1],
      platform: "unexpected-platform",
      data: { rawValue },
    },
  ];
  const wrapper = validWrapper({ fixture_records: records });
  const adapter = createAdapter({ httpClient: async () => jsonResponse(wrapper) });
  const result = await adapter.fetchPage(pageInput());
  assert.equal(result.page.records.length, 1);
  assert.deepEqual(result.invalidRecords.map(({ issues }) => issues), [
    [{ code: "platform_mismatch", path: "records[1].platform" }],
  ]);
  assert.deepEqual(
    (result.rawPage as { fixture_records: unknown[] }).fixture_records[1],
    records[1],
  );
});

test("the injected decoder receives bounded body and response metadata without a wrapper assumption", async () => {
  const wrapper = validWrapper();
  const bodyText = JSON.stringify(wrapper);
  let captured:
    | Parameters<ProviderHttpResponseDecoderV2["decode"]>[0]
    | undefined;
  const decoder: ProviderHttpResponseDecoderV2 = {
    decode(input) {
      captured = input;
      return fixtureJsonDecoder.decode(input);
    },
  };
  const adapter = createAdapter({
    decoder,
    httpClient: async () =>
      new Response(bodyText, {
        headers: {
          "content-type": "application/x-ndjson; charset=utf-8",
          "x-fixture-page": "page-7",
        },
      }),
  });

  await adapter.fetchPage(pageInput({ cursor: "cursor-6" }));

  assert.equal(captured?.bodyText, bodyText);
  assert.equal(captured?.contentType, "application/x-ndjson; charset=utf-8");
  assert.equal(captured?.headers["x-fixture-page"], "page-7");
  assert.equal(captured?.requestedPlatform, platform);
  assert.equal(captured?.requestedCursor, "cursor-6");
});

test("decoder failures stay bounded and unexpected decoder exceptions fail closed", async () => {
  const protectedValue = "provider-private-value";
  const boundedAdapter = createAdapter({
    decoder: {
      decode: () => ({
        ok: false,
        code: "invalid_response",
        fieldPaths: ["records[0].card_id", protectedValue],
        issueCodes: ["invalid_type", protectedValue],
      }),
    },
    httpClient: async () => jsonResponse(validWrapper()),
  });
  const bounded = await captureRequestError(boundedAdapter.fetchPage(pageInput()));
  assert.deepEqual(bounded.failure, {
    code: "invalid_response",
    retryable: false,
    fieldPaths: ["records[0].card_id"],
    issueCodes: ["invalid_type"],
  });
  assert.doesNotMatch(JSON.stringify(bounded.failure), new RegExp(protectedValue));

  const throwingAdapter = createAdapter({
    decoder: {
      decode() {
        throw new Error(protectedValue);
      },
    },
    httpClient: async () => jsonResponse(validWrapper()),
  });
  const throwing = await captureRequestError(
    throwingAdapter.fetchPage(pageInput()),
  );
  assert.deepEqual(throwing.failure, {
    code: "invalid_response",
    retryable: false,
  });
  assert.doesNotMatch(JSON.stringify(throwing.failure), new RegExp(protectedValue));
});

test("a decoder is required and oversized cursors fail before network access", async () => {
  assert.throws(
    () => new HttpCursorAdapter({ decoder: undefined as never }),
    /decoder is required/,
  );
  let requested = false;
  const adapter = createAdapter({
    httpClient: async () => {
      requested = true;
      return jsonResponse(validWrapper());
    },
  });
  const error = await captureRequestError(
    adapter.fetchPage(pageInput({ cursor: "x".repeat(2_049) })),
  );
  assert.equal(error.failure.code, "invalid_configuration");
  assert.equal(requested, false);
});

test("timeouts cover DNS verification and the HTTP request", async () => {
  const never = () => new Promise<readonly string[]>(() => undefined);
  const dnsAdapter = new HttpCursorAdapter({
    decoder: fixtureJsonDecoder,
    resolveHost: never,
  });
  const dnsTimeout = await captureRequestError(
    dnsAdapter.fetchPage(pageInput({ timeoutMs: 1 })),
  );
  assert.deepEqual(dnsTimeout.failure, { code: "timeout", retryable: true });

  const httpClient: ProviderHttpClient = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    });
  const requestAdapter = createAdapter({ httpClient });
  const requestTimeout = await captureRequestError(
    requestAdapter.fetchPage(pageInput({ timeoutMs: 1 })),
  );
  assert.deepEqual(requestTimeout.failure, { code: "timeout", retryable: true });
});

test("connection tests use the initial raw page and return bounded metadata", async () => {
  let requestedCursor: string | null | undefined;
  const timestamps = [100, 107];
  const adapter = createAdapter({
    httpClient: async (input) => {
      requestedCursor = new URL(String(input)).searchParams.get("cursor");
      return jsonResponse(validWrapper());
    },
    now: () => timestamps.shift() ?? 107,
  });
  const result = await adapter.testConnection({
    endpoint: `https://${providerHost}/feed?cursor=must-be-removed`,
    allowedHosts: [providerHost],
    platform,
    auth: { mode: "none" },
  });
  assert.equal(requestedCursor, null);
  assert.deepEqual(result, {
    ok: true,
    latencyMs: 7,
    responseStatus: 200,
    recordCounts: { catalog: 1, pulls: 1, trades: 1 },
    hasMore: false,
    nextCursorPresent: true,
  });
});

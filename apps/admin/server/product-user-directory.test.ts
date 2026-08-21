import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createProductUserDirectoryReader,
  ProductUserDirectoryError,
} from "./product-user-directory.ts";
import { readProductUserDirectoryConfig } from "./runtime-config.ts";

const token = "product-directory-integration-token-value";
const config = { baseUrl: "https://backend.example.test", token };
const subject = "https://auth.example.test/|did:example:1";

function row(overrides: Record<string, unknown> = {}) {
  return {
    subject,
    authMethod: "https://auth.example.test",
    email: "ada@example.test",
    walletAddress: "0xWalletAddress0001",
    firstSeenAt: "2026-08-01T09:00:00.000Z",
    lastSeenAt: "2026-08-19T12:00:00.000Z",
    standing: "active",
    savedRepackCount: 2,
    savedCollectibleCount: 5,
    ...overrides,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function recordingFetch(
  handler: (call: RecordedCall) => Response | Promise<Response>,
) {
  const calls: RecordedCall[] = [];
  const implementation = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { calls, implementation };
}

async function refusal(
  promise: Promise<unknown>,
): Promise<ProductUserDirectoryError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ProductUserDirectoryError);
    return error;
  }
  throw new Error("The directory read was expected to fail.");
}

test("an unconfigured integration fails closed without contacting anything", async () => {
  const { calls, implementation } = recordingFetch(() => jsonResponse({}));
  const reader = createProductUserDirectoryReader({
    config: null,
    fetchImplementation: implementation,
  });
  const error = await refusal(reader.listProductUsers({ limit: 20 }));
  assert.equal(error.code, "PRODUCT_USER_DIRECTORY_UNCONFIGURED");
  assert.equal(error.status, 503);
  assert.equal(calls.length, 0);
});

test("the directory read is a server-to-server POST carrying the bearer secret", async () => {
  const { calls, implementation } = recordingFetch(() =>
    jsonResponse({
      page: [row()],
      isDone: false,
      continueCursor: "cursor-page-two",
      searchTruncated: false,
    }),
  );
  const reader = createProductUserDirectoryReader({
    config,
    fetchImplementation: implementation,
  });

  const page = await reader.listProductUsers({
    search: "ada@example.test",
    cursor: "cursor-page-one",
    limit: 20,
  });
  assert.deepEqual(page, {
    items: [row()],
    nextCursor: "cursor-page-two",
    searchTruncated: false,
  });

  const [call] = calls;
  assert.ok(call);
  assert.equal(call.url, "https://backend.example.test/admin/product-users/list");
  assert.equal(call.init?.method, "POST");
  const headers = call.init?.headers as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${token}`);
  // The personal search term is in the body, never in the URL.
  assert.doesNotMatch(call.url, /ada@example\.test|\?/);
  assert.deepEqual(JSON.parse(String(call.init?.body)), {
    search: "ada@example.test",
    paginationOpts: { numItems: 20, cursor: "cursor-page-one" },
  });
});

test("an exhausted listing reports no continuation", async () => {
  const { calls, implementation } = recordingFetch(() =>
    jsonResponse({
      page: [],
      isDone: true,
      continueCursor: "cursor-that-must-not-be-followed",
      searchTruncated: false,
    }),
  );
  const reader = createProductUserDirectoryReader({
    config,
    fetchImplementation: implementation,
  });
  const page = await reader.listProductUsers({ limit: 20 });
  assert.deepEqual(page, { items: [], nextCursor: null, searchTruncated: false });
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    search: null,
    paginationOpts: { numItems: 20, cursor: null },
  });
});

test("rows are normalized to the bounded browser-facing shape", async () => {
  const { implementation } = recordingFetch(() =>
    jsonResponse({
      page: [
        row({
          authMethod: "   ",
          email: `${"a".repeat(320)}@example.test`,
          walletAddress: "w".repeat(129),
          savedRepackCount: 10_000,
          savedCollectibleCount: -4,
          walletAddressKey: "0xwalletaddress0001",
          accessToken: "never-serialize",
        }),
      ],
      isDone: true,
      continueCursor: null,
      searchTruncated: true,
    }),
  );
  const reader = createProductUserDirectoryReader({
    config,
    fetchImplementation: implementation,
  });
  const page = await reader.listProductUsers({ limit: 20 });
  const [item] = page.items;
  assert.ok(item);
  assert.equal(page.searchTruncated, true);
  assert.equal(item.authMethod, "unknown");
  // Over-long optional attributes are dropped rather than truncated into a
  // value that would misidentify the person.
  assert.equal(item.email, null);
  assert.equal(item.walletAddress, null);
  assert.equal(item.savedRepackCount, 250);
  assert.equal(item.savedCollectibleCount, 0);
  assert.deepEqual(Object.keys(item).sort(), [
    "authMethod",
    "email",
    "firstSeenAt",
    "lastSeenAt",
    "savedCollectibleCount",
    "savedRepackCount",
    "standing",
    "subject",
    "walletAddress",
  ]);
});

test("a broken directory contract is an unavailable directory, not a half row", async () => {
  const brokenPayloads = [
    { page: [row({ subject: "" })], isDone: true, continueCursor: null },
    { page: [row({ standing: "banned" })], isDone: true, continueCursor: null },
    { page: [row({ lastSeenAt: "not-a-timestamp" })], isDone: true, continueCursor: null },
    { page: [null], isDone: true, continueCursor: null },
    { page: "not-an-array", isDone: true, continueCursor: null },
    { isDone: true, continueCursor: null },
    ["not", "an", "object"],
  ];
  for (const payload of brokenPayloads) {
    const { implementation } = recordingFetch(() => jsonResponse(payload));
    const reader = createProductUserDirectoryReader({
      config,
      fetchImplementation: implementation,
    });
    const error = await refusal(reader.listProductUsers({ limit: 20 }));
    assert.equal(error.code, "PRODUCT_USER_DIRECTORY_UNAVAILABLE");
  }
});

test("upstream refusals map to stable codes and never restate the upstream body", async () => {
  const cases: [number, string | null, string][] = [
    [400, "PRODUCT_USER_PAGE_CURSOR_INVALID", "INVALID_PRODUCT_USER_CURSOR"],
    [400, "PRODUCT_USER_SEARCH_INVALID", "INVALID_PRODUCT_USER_REQUEST"],
    [400, "PRODUCT_USER_PAGE_SIZE_INVALID", "INVALID_PRODUCT_USER_REQUEST"],
    [400, "ADMIN_DIRECTORY_REQUEST_INVALID", "INVALID_PRODUCT_USER_REQUEST"],
    [400, "SOMETHING_ELSE", "PRODUCT_USER_DIRECTORY_UNAVAILABLE"],
    [401, "ADMIN_DIRECTORY_UNAUTHORIZED", "PRODUCT_USER_DIRECTORY_UNAVAILABLE"],
    [404, null, "PRODUCT_USER_DIRECTORY_UNAVAILABLE"],
    [500, "ADMIN_DIRECTORY_UNAVAILABLE", "PRODUCT_USER_DIRECTORY_UNAVAILABLE"],
  ];
  for (const [status, code, expected] of cases) {
    const { implementation } = recordingFetch(() =>
      jsonResponse(
        {
          ...(code === null ? {} : { code }),
          error: `secret upstream detail for ${token}`,
        },
        status,
      ),
    );
    const reader = createProductUserDirectoryReader({
      config,
      fetchImplementation: implementation,
    });
    const error = await refusal(reader.listProductUsers({ limit: 20 }));
    assert.equal(error.code, expected);
    assert.doesNotMatch(error.message, new RegExp(`${token}|secret upstream`));
  }
});

test("transport failures and unreadable bodies are one bounded outcome", async () => {
  const throwingFetch = (async () => {
    throw new Error(`connect ECONNREFUSED for ${token}`);
  }) as typeof fetch;
  const unreachable = createProductUserDirectoryReader({
    config,
    fetchImplementation: throwingFetch,
  });
  const transportError = await refusal(unreachable.listProductUsers({ limit: 20 }));
  assert.equal(transportError.code, "PRODUCT_USER_DIRECTORY_UNAVAILABLE");
  assert.equal(transportError.status, 503);
  assert.doesNotMatch(transportError.message, new RegExp(token));

  const { implementation } = recordingFetch(
    () => new Response("<html>gateway timeout</html>", { status: 200 }),
  );
  const malformed = createProductUserDirectoryReader({
    config,
    fetchImplementation: implementation,
  });
  const parseError = await refusal(malformed.listProductUsers({ limit: 20 }));
  assert.equal(parseError.code, "PRODUCT_USER_DIRECTORY_UNAVAILABLE");
});

function savedItemsResponse(overrides: Record<string, unknown> = {}) {
  return {
    catalogAvailable: true,
    savedRepacks: [
      {
        publicRepackId: "40000000-0000-5000-8000-000000000001",
        savedAt: "2026-08-19T12:00:02.000Z",
        resolution: "resolved",
        repack: {
          name: "Mythic Pokemon Gacha",
          vendorDisplayName: "Collector Crypt",
          availability: "active",
          estimatedEv: {
            evDollarsMinorUnits: 12_500,
            grossReturnBasisPoints: 10_500,
            confidenceBand: "high",
          },
        },
      },
      {
        publicRepackId: "40000000-0000-5000-8000-000000000999",
        savedAt: "2026-08-19T12:00:01.000Z",
        resolution: "unresolved",
        repack: null,
      },
    ],
    savedCollectibles: [
      {
        publicCollectibleId: "30000000-0000-5000-8000-000000000001",
        savedAt: "2026-08-19T12:00:03.000Z",
        resolution: "resolved",
        collectible: { name: "Charizard Holo PSA 10", collectibleType: "card" },
      },
    ],
    ...overrides,
  };
}

function detailFetch(
  record: unknown,
  savedItems: unknown = savedItemsResponse(),
) {
  return recordingFetch(({ url }) =>
    jsonResponse(url.endsWith("/record") ? { record } : savedItems),
  );
}

test("the detail read joins the record lookup to the resolved saved items", async () => {
  const { calls, implementation } = detailFetch(row());
  const reader = createProductUserDirectoryReader({
    config,
    fetchImplementation: implementation,
  });

  const detail = await reader.getProductUserDetail({ subject });
  assert.equal(detail.catalogAvailable, true);
  assert.equal(detail.user.subject, subject);
  // The record projection carries identity, not saved-item counts.
  assert.deepEqual(Object.keys(detail.user).sort(), [
    "authMethod",
    "email",
    "firstSeenAt",
    "lastSeenAt",
    "standing",
    "subject",
    "walletAddress",
  ]);
  assert.deepEqual(detail.savedRepacks[0], {
    resolution: "resolved",
    publicRepackId: "40000000-0000-5000-8000-000000000001",
    savedAt: "2026-08-19T12:00:02.000Z",
    name: "Mythic Pokemon Gacha",
    vendorDisplayName: "Collector Crypt",
    availability: "active",
    estimatedEv: {
      evDollarsMinorUnits: 12_500,
      grossReturnBasisPoints: 10_500,
      confidenceBand: "high",
    },
  });
  assert.deepEqual(detail.savedRepacks[1], {
    resolution: "unresolved",
    publicRepackId: "40000000-0000-5000-8000-000000000999",
    savedAt: "2026-08-19T12:00:01.000Z",
  });
  assert.deepEqual(detail.savedCollectibles, [
    {
      resolution: "resolved",
      publicCollectibleId: "30000000-0000-5000-8000-000000000001",
      savedAt: "2026-08-19T12:00:03.000Z",
      name: "Charizard Holo PSA 10",
      collectibleType: "card",
    },
  ]);

  // Both privileged reads are POSTs carrying the secret, with the subject in
  // the body rather than the URL.
  assert.deepEqual(
    calls.map(({ url }) => url).sort(),
    [
      "https://backend.example.test/admin/product-users/record",
      "https://backend.example.test/admin/product-users/saved-items",
    ],
  );
  for (const call of calls) {
    assert.equal(call.init?.method, "POST");
    assert.equal(
      (call.init?.headers as Record<string, string>).authorization,
      `Bearer ${token}`,
    );
    assert.doesNotMatch(call.url, /did:example|\?/);
    assert.deepEqual(JSON.parse(String(call.init?.body)), { subject });
  }
});

test("a subject with no record is not found, and empty collections are honest", async () => {
  const missing = detailFetch(null);
  const reader = createProductUserDirectoryReader({
    config,
    fetchImplementation: missing.implementation,
  });
  const error = await refusal(reader.getProductUserDetail({ subject }));
  assert.equal(error.code, "PRODUCT_USER_NOT_FOUND");
  assert.equal(error.status, 404);

  const empty = detailFetch(
    row(),
    savedItemsResponse({ savedRepacks: [], savedCollectibles: [] }),
  );
  const emptyReader = createProductUserDirectoryReader({
    config,
    fetchImplementation: empty.implementation,
  });
  const detail = await emptyReader.getProductUserDetail({ subject });
  assert.deepEqual(detail.savedRepacks, []);
  assert.deepEqual(detail.savedCollectibles, []);
});

test("an unreadable catalog is reported rather than mislabelled as removed", async () => {
  const { implementation } = detailFetch(
    row(),
    savedItemsResponse({
      catalogAvailable: false,
      savedRepacks: [
        {
          publicRepackId: "40000000-0000-5000-8000-000000000001",
          savedAt: "2026-08-19T12:00:02.000Z",
          resolution: "unresolved",
          repack: null,
        },
      ],
      savedCollectibles: [],
    }),
  );
  const reader = createProductUserDirectoryReader({
    config,
    fetchImplementation: implementation,
  });
  const detail = await reader.getProductUserDetail({ subject });
  assert.equal(detail.catalogAvailable, false);
  assert.equal(detail.savedRepacks[0]?.resolution, "unresolved");
});

test("a cap-sized collection survives the relay and a broken one does not", async () => {
  const capped = Array.from({ length: 250 }, (_, index) => ({
    publicRepackId: `40000000-0000-5000-8000-${String(index).padStart(12, "0")}`,
    savedAt: "2026-08-19T12:00:00.000Z",
    resolution: "unresolved",
    repack: null,
  }));
  const { implementation } = detailFetch(
    row(),
    savedItemsResponse({ savedRepacks: capped, savedCollectibles: [] }),
  );
  const reader = createProductUserDirectoryReader({
    config,
    fetchImplementation: implementation,
  });
  const detail = await reader.getProductUserDetail({ subject });
  assert.equal(detail.savedRepacks.length, 250);

  const brokenCollections = [
    { savedRepacks: "not-an-array" },
    { savedRepacks: [{ resolution: "resolved", publicRepackId: "40000000", savedAt: "2026-08-19T12:00:00.000Z" }] },
    { savedRepacks: [{ resolution: "resolved", publicRepackId: "", savedAt: "2026-08-19T12:00:00.000Z", repack: { name: "n", vendorDisplayName: "v", availability: "active", estimatedEv: null } }] },
    { savedRepacks: [{ resolution: "resolved", publicRepackId: "40000000", savedAt: "nope", repack: { name: "n", vendorDisplayName: "v", availability: "active", estimatedEv: null } }] },
    { savedRepacks: [{ resolution: "resolved", publicRepackId: "40000000", savedAt: "2026-08-19T12:00:00.000Z", repack: { name: "n", vendorDisplayName: "v", availability: "withdrawn", estimatedEv: null } }] },
    { savedCollectibles: [{ resolution: "resolved", publicCollectibleId: "30000000", savedAt: "2026-08-19T12:00:00.000Z", collectible: { name: "n", collectibleType: "spaceship" } }] },
  ];
  for (const overrides of brokenCollections) {
    const broken = detailFetch(row(), savedItemsResponse(overrides));
    const brokenReader = createProductUserDirectoryReader({
      config,
      fetchImplementation: broken.implementation,
    });
    const error = await refusal(brokenReader.getProductUserDetail({ subject }));
    assert.equal(error.code, "PRODUCT_USER_DIRECTORY_UNAVAILABLE");
  }
});

test("directory configuration is optional, bounded, and never partially trusted", () => {
  assert.deepEqual(
    readProductUserDirectoryConfig({
      baseUrl: " https://backend.example.test/admin/ ",
      token: ` ${token} `,
    }),
    { baseUrl: "https://backend.example.test", token },
  );

  const unusable = [
    { baseUrl: undefined, token },
    { baseUrl: "https://backend.example.test", token: undefined },
    { baseUrl: "https://backend.example.test", token: "too-short" },
    { baseUrl: "", token },
    { baseUrl: "not-a-url", token },
    { baseUrl: "ftp://backend.example.test", token },
  ];
  for (const input of unusable) {
    assert.equal(readProductUserDirectoryConfig(input), null);
  }
});

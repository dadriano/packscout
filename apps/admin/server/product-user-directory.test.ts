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

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BetaAllowlistDirectoryError,
  createBetaAllowlistDirectoryClient,
} from "./beta-allowlist-directory.ts";

const token = "product-directory-integration-token-value";
const config = { baseUrl: "https://backend.example.test", token };

function entry(overrides: Record<string, unknown> = {}) {
  return {
    entryId: "entry-0000000000000001",
    email: "ada@example.test",
    walletAddress: "0xWalletAddress0001",
    label: "First invite wave",
    createdAt: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-08-01T09:00:00.000Z",
    createdByOperatorId: "00000000-0000-4000-8000-000000000001",
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
): Promise<BetaAllowlistDirectoryError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof BetaAllowlistDirectoryError);
    return error;
  }
  throw new Error("The allowlist call was expected to fail.");
}

test("an unconfigured integration fails closed without contacting anything", async () => {
  const { calls, implementation } = recordingFetch(() => jsonResponse({}));
  const client = createBetaAllowlistDirectoryClient({
    config: null,
    fetchImplementation: implementation,
  });
  const error = await refusal(client.listEntries({ limit: 20 }));
  assert.equal(error.code, "BETA_ALLOWLIST_UNCONFIGURED");
  assert.equal(error.status, 503);
  assert.equal(calls.length, 0);
});

test("the listing is a server-to-server POST carrying the bearer secret, identifiers in the body", async () => {
  const { calls, implementation } = recordingFetch(() =>
    jsonResponse({
      page: [entry()],
      isDone: false,
      continueCursor: "cursor-page-two",
      searchTruncated: false,
    }),
  );
  const client = createBetaAllowlistDirectoryClient({
    config,
    fetchImplementation: implementation,
  });

  const page = await client.listEntries({
    search: "ada@example.test",
    cursor: "cursor-page-one",
    limit: 20,
  });
  assert.deepEqual(page, {
    items: [entry()],
    nextCursor: "cursor-page-two",
    searchTruncated: false,
  });

  const [call] = calls;
  assert.ok(call);
  assert.equal(call.url, "https://backend.example.test/admin/beta-allowlist/list");
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
  const client = createBetaAllowlistDirectoryClient({
    config,
    fetchImplementation: implementation,
  });
  const page = await client.listEntries({ limit: 20 });
  assert.deepEqual(page, { items: [], nextCursor: null, searchTruncated: false });
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    search: null,
    paginationOpts: { numItems: 20, cursor: null },
  });
});

test("a broken allowlist contract is an unavailable allowlist, not a half entry", async () => {
  const brokenPayloads = [
    { page: [entry({ entryId: "" })], isDone: true, continueCursor: null },
    // An entry with no identifier at all cannot describe an invitation.
    {
      page: [entry({ email: null, walletAddress: null })],
      isDone: true,
      continueCursor: null,
    },
    { page: [entry({ createdAt: "not-a-timestamp" })], isDone: true, continueCursor: null },
    { page: [entry({ createdByOperatorId: "" })], isDone: true, continueCursor: null },
    { page: [null], isDone: true, continueCursor: null },
    { page: "not-an-array", isDone: true, continueCursor: null },
    { isDone: true, continueCursor: null },
    ["not", "an", "object"],
  ];
  for (const payload of brokenPayloads) {
    const { implementation } = recordingFetch(() => jsonResponse(payload));
    const client = createBetaAllowlistDirectoryClient({
      config,
      fetchImplementation: implementation,
    });
    const error = await refusal(client.listEntries({ limit: 20 }));
    assert.equal(error.code, "BETA_ALLOWLIST_UNAVAILABLE");
    assert.equal(error.status, 503);
  }
});

test("creating an entry reports the admitted count and carries the operator reference", async () => {
  const { calls, implementation } = recordingFetch(() =>
    jsonResponse({ entry: entry(), admittedCount: 2 }),
  );
  const client = createBetaAllowlistDirectoryClient({
    config,
    fetchImplementation: implementation,
  });
  const change = await client.createEntry({
    email: "ada@example.test",
    walletAddress: null,
    label: "First invite wave",
    operatorId: "00000000-0000-4000-8000-000000000001",
  });
  assert.deepEqual(change, { entry: entry(), admittedCount: 2 });
  const [call] = calls;
  assert.equal(call?.url, "https://backend.example.test/admin/beta-allowlist/create");
  assert.doesNotMatch(String(call?.url), /\?/);
  assert.deepEqual(JSON.parse(String(call?.init?.body)), {
    email: "ada@example.test",
    walletAddress: null,
    label: "First invite wave",
    operatorId: "00000000-0000-4000-8000-000000000001",
  });
});

test("duplicate identifiers restate as fixed conflict messages, never the upstream body", async () => {
  for (const [upstream, expected] of [
    ["BETA_ALLOWLIST_DUPLICATE_EMAIL", /email address/],
    ["BETA_ALLOWLIST_DUPLICATE_WALLET_ADDRESS", /wallet address/],
  ] as const) {
    const { implementation } = recordingFetch(() =>
      jsonResponse(
        {
          code: upstream,
          error: `refused for ada@example.test with ${token}`,
        },
        409,
      ),
    );
    const client = createBetaAllowlistDirectoryClient({
      config,
      fetchImplementation: implementation,
    });
    const error = await refusal(
      client.createEntry({
        email: "ada@example.test",
        walletAddress: null,
        label: null,
        operatorId: "operator-1",
      }),
    );
    assert.equal(error.code, upstream);
    assert.equal(error.status, 409);
    assert.match(error.message, expected);
    // The message is the admin's own copy; nothing upstream rides along.
    assert.doesNotMatch(error.message, /ada@example\.test|refused|token/);
  }
});

test("upstream validation refusals become actionable operator messages", async () => {
  const cases = [
    ["BETA_ALLOWLIST_EMAIL_INVALID", "BETA_ALLOWLIST_EMAIL_INVALID", 422],
    [
      "BETA_ALLOWLIST_WALLET_ADDRESS_INVALID",
      "BETA_ALLOWLIST_WALLET_ADDRESS_INVALID",
      422,
    ],
    ["BETA_ALLOWLIST_LABEL_INVALID", "BETA_ALLOWLIST_LABEL_INVALID", 422],
    [
      "BETA_ALLOWLIST_IDENTIFIER_REQUIRED",
      "BETA_ALLOWLIST_IDENTIFIER_REQUIRED",
      422,
    ],
    ["BETA_ALLOWLIST_PAGE_CURSOR_INVALID", "INVALID_BETA_ALLOWLIST_CURSOR", 422],
    ["ADMIN_ALLOWLIST_REQUEST_INVALID", "INVALID_BETA_ALLOWLIST_REQUEST", 422],
    ["BETA_ALLOWLIST_ENTRY_INVALID", "INVALID_BETA_ALLOWLIST_REQUEST", 422],
  ] as const;
  for (const [upstream, expected, status] of cases) {
    const { implementation } = recordingFetch(() =>
      jsonResponse({ code: upstream, error: "upstream detail" }, 400),
    );
    const client = createBetaAllowlistDirectoryClient({
      config,
      fetchImplementation: implementation,
    });
    const error = await refusal(client.listEntries({ limit: 20 }));
    assert.equal(error.code, expected);
    assert.equal(error.status, status);
    assert.doesNotMatch(error.message, /upstream detail/);
  }
});

test("a rejected secret and an upstream failure are one bounded unavailable outcome", async () => {
  for (const response of [
    jsonResponse({ error: `secret ${token} rejected` }, 401),
    jsonResponse({ error: "exploded", stack: "at convex" }, 500),
    new Response("not json", { status: 200 }),
  ]) {
    const { implementation } = recordingFetch(() => response);
    const client = createBetaAllowlistDirectoryClient({
      config,
      fetchImplementation: implementation,
    });
    const error = await refusal(client.listEntries({ limit: 20 }));
    assert.equal(error.code, "BETA_ALLOWLIST_UNAVAILABLE");
    assert.doesNotMatch(error.message, /secret|rejected|exploded|stack/);
  }

  const { implementation } = recordingFetch(() => {
    throw new Error(`connect ECONNREFUSED with ${token}`);
  });
  const client = createBetaAllowlistDirectoryClient({
    config,
    fetchImplementation: implementation,
  });
  const error = await refusal(client.listEntries({ limit: 20 }));
  assert.equal(error.code, "BETA_ALLOWLIST_UNAVAILABLE");
  assert.doesNotMatch(error.message, /ECONNREFUSED|token/);
});

test("updating distinguishes keep, change, and clear, and restates a vanished entry as not found", async () => {
  const { calls, implementation } = recordingFetch(() =>
    jsonResponse({
      entry: entry({ walletAddress: null, updatedAt: "2026-08-02T10:00:00.000Z" }),
      admittedCount: 1,
    }),
  );
  const client = createBetaAllowlistDirectoryClient({
    config,
    fetchImplementation: implementation,
  });
  const change = await client.updateEntry({
    entryId: "entry-0000000000000001",
    email: "ada@example.test",
    walletAddress: null,
  });
  assert.equal(change.admittedCount, 1);
  assert.equal(change.entry.walletAddress, null);
  // The omitted label never crosses the integration, so upstream keeps it.
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    entryId: "entry-0000000000000001",
    email: "ada@example.test",
    walletAddress: null,
  });

  const vanished = createBetaAllowlistDirectoryClient({
    config,
    fetchImplementation: recordingFetch(() =>
      jsonResponse({ entry: null, admittedCount: 0 }),
    ).implementation,
  });
  const error = await refusal(
    vanished.updateEntry({ entryId: "entry-gone", label: "renamed" }),
  );
  assert.equal(error.code, "BETA_ALLOWLIST_ENTRY_NOT_FOUND");
  assert.equal(error.status, 404);
});

test("removal converges: an already-removed entry reports removed false", async () => {
  for (const removed of [true, false]) {
    const { calls, implementation } = recordingFetch(() =>
      jsonResponse({ removed }),
    );
    const client = createBetaAllowlistDirectoryClient({
      config,
      fetchImplementation: implementation,
    });
    assert.deepEqual(
      await client.removeEntry({ entryId: "entry-0000000000000001" }),
      { removed },
    );
    assert.equal(
      calls[0]?.url,
      "https://backend.example.test/admin/beta-allowlist/remove",
    );
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
      entryId: "entry-0000000000000001",
    });
  }
});

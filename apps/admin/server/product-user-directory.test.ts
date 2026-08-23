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
    access: {
      state: "approved",
      decidedBy: "allowlist",
      decidedAt: "2026-08-02T09:00:00.000Z",
    },
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
    "access",
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
    { page: [row({ access: undefined })], isDone: true, continueCursor: null },
    {
      page: [row({ access: { state: "banished", decidedBy: "operator", decidedAt: "2026-08-02T09:00:00.000Z" } })],
      isDone: true,
      continueCursor: null,
    },
    {
      page: [row({ access: { state: "approved", decidedBy: "magic", decidedAt: "2026-08-02T09:00:00.000Z" } })],
      isDone: true,
      continueCursor: null,
    },
    {
      page: [row({ access: { state: "approved", decidedBy: "allowlist", decidedAt: "not-a-timestamp" } })],
      isDone: true,
      continueCursor: null,
    },
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
    "access",
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

test("a stored decision's operator and allowlist references never leave the integration", async () => {
  const { implementation } = recordingFetch(() =>
    jsonResponse({
      page: [
        row({
          access: {
            state: "approved",
            decidedBy: "allowlist",
            decidedAt: "2026-08-02T09:00:00.000Z",
            allowlistEntryId: "entry-reference-never-serialize",
            operatorId: "operator-reference-never-serialize",
          },
        }),
      ],
      isDone: true,
      continueCursor: null,
      searchTruncated: false,
    }),
  );
  const reader = createProductUserDirectoryReader({
    config,
    fetchImplementation: implementation,
  });
  const page = await reader.listProductUsers({ limit: 20 });
  assert.deepEqual(page.items[0]?.access, {
    state: "approved",
    decidedBy: "allowlist",
    decidedAt: "2026-08-02T09:00:00.000Z",
  });
  assert.doesNotMatch(JSON.stringify(page), /never-serialize/);
});

test("the queue read posts the state and cursor and relays rows oldest-first", async () => {
  const oldest = row({
    subject: "https://auth.example.test/|did:example:oldest",
    access: {
      state: "awaiting_review",
      decidedBy: "default",
      decidedAt: "2026-08-01T09:00:00.000Z",
    },
  });
  const newer = row({
    subject: "https://auth.example.test/|did:example:newer",
    access: {
      state: "awaiting_review",
      decidedBy: "operator",
      decidedAt: "2026-08-03T09:00:00.000Z",
    },
  });
  const { calls, implementation } = recordingFetch(() =>
    jsonResponse({
      page: [oldest, newer],
      isDone: false,
      continueCursor: "queue-cursor-two",
      queueTruncated: true,
    }),
  );
  const reader = createProductUserDirectoryReader({
    config,
    fetchImplementation: implementation,
  });

  const page = await reader.listProductUserAccessQueue({
    accessState: "awaiting_review",
    cursor: "queue-cursor-one",
    limit: 20,
  });
  // The backend's oldest-first ordering is preserved verbatim.
  assert.deepEqual(page, {
    items: [oldest, newer],
    nextCursor: "queue-cursor-two",
    queueTruncated: true,
  });

  const [call] = calls;
  assert.ok(call);
  assert.equal(
    call.url,
    "https://backend.example.test/admin/product-users/access/queue",
  );
  assert.equal(call.init?.method, "POST");
  assert.equal(
    (call.init?.headers as Record<string, string>).authorization,
    `Bearer ${token}`,
  );
  assert.doesNotMatch(call.url, /did:example|\?/);
  assert.deepEqual(JSON.parse(String(call.init?.body)), {
    accessState: "awaiting_review",
    paginationOpts: { numItems: 20, cursor: "queue-cursor-one" },
  });
});

test("an exhausted queue reports no continuation and a broken one is unavailable", async () => {
  const done = recordingFetch(() =>
    jsonResponse({
      page: [],
      isDone: true,
      continueCursor: "cursor-that-must-not-be-followed",
      queueTruncated: false,
    }),
  );
  const reader = createProductUserDirectoryReader({
    config,
    fetchImplementation: done.implementation,
  });
  assert.deepEqual(
    await reader.listProductUserAccessQueue({
      accessState: "awaiting_review",
      limit: 20,
    }),
    { items: [], nextCursor: null, queueTruncated: false },
  );

  for (const payload of [
    { page: "not-an-array", isDone: true, continueCursor: null },
    { page: [], isDone: "yes", continueCursor: null },
    { page: [row({ access: undefined })], isDone: true, continueCursor: null },
  ]) {
    const broken = recordingFetch(() => jsonResponse(payload));
    const brokenReader = createProductUserDirectoryReader({
      config,
      fetchImplementation: broken.implementation,
    });
    const error = await refusal(
      brokenReader.listProductUserAccessQueue({
        accessState: "awaiting_review",
        limit: 20,
      }),
    );
    assert.equal(error.code, "PRODUCT_USER_DIRECTORY_UNAVAILABLE");
  }
});

test("the awaiting count is bounded, boolean-flagged, and never trusted blindly", async () => {
  const { calls, implementation } = recordingFetch(() =>
    jsonResponse({ count: 500.9, truncated: true, extra: "never-serialize" }),
  );
  const reader = createProductUserDirectoryReader({
    config,
    fetchImplementation: implementation,
  });
  assert.deepEqual(await reader.countAwaitingReview(), {
    count: 500,
    truncated: true,
  });
  assert.equal(
    calls[0]?.url,
    "https://backend.example.test/admin/product-users/access/queue-count",
  );

  for (const payload of [{ truncated: false }, { count: "many" }, []]) {
    const broken = recordingFetch(() => jsonResponse(payload));
    const brokenReader = createProductUserDirectoryReader({
      config,
      fetchImplementation: broken.implementation,
    });
    const error = await refusal(brokenReader.countAwaitingReview());
    assert.equal(error.code, "PRODUCT_USER_DIRECTORY_UNAVAILABLE");
  }
});

test("decision operations post subject and operator to their own endpoints", async () => {
  const previous = {
    state: "awaiting_review",
    decidedBy: "default",
    decidedAt: "2026-08-01T09:00:00.000Z",
  };
  const resulting = {
    state: "approved",
    decidedBy: "operator",
    decidedAt: "2026-08-20T10:00:00.000Z",
    operatorId: "operator-reference-never-serialize",
  };
  const { calls, implementation } = recordingFetch(() =>
    jsonResponse({
      outcome: "decided",
      action: "approve",
      subject,
      operatorId: "operator-reference-never-serialize",
      decidedAt: "2026-08-20T10:00:00.000Z",
      changed: true,
      previous,
      resulting,
      effectiveAccess: { admitted: true, reason: "approved" },
    }),
  );
  const reader = createProductUserDirectoryReader({
    config,
    fetchImplementation: implementation,
  });

  const outcome = await reader.decideProductUserAccess({
    action: "approve",
    subject,
    operatorId: "00000000-0000-4000-8000-000000000001",
  });
  // The upstream echo of subject and operator is not relayed, and the stored
  // decision's operator reference is dropped at this boundary.
  assert.deepEqual(outcome, {
    outcome: "decided",
    changed: true,
    previous,
    resulting: {
      state: "approved",
      decidedBy: "operator",
      decidedAt: "2026-08-20T10:00:00.000Z",
    },
    effectiveAccess: { admitted: true, reason: "approved" },
  });
  assert.doesNotMatch(JSON.stringify(outcome), /never-serialize/);

  const [call] = calls;
  assert.ok(call);
  assert.equal(
    call.url,
    "https://backend.example.test/admin/product-users/access/approve",
  );
  assert.doesNotMatch(call.url, /did:example|\?/);
  assert.deepEqual(JSON.parse(String(call.init?.body)), {
    subject,
    operatorId: "00000000-0000-4000-8000-000000000001",
  });
});

test("decline and revoke address their own endpoints", async () => {
  for (const [action, path] of [
    ["decline", "/admin/product-users/access/decline"],
    ["revoke", "/admin/product-users/access/revoke"],
  ] as const) {
    const { calls, implementation } = recordingFetch(() =>
      jsonResponse({
        outcome: "nothing_to_decide",
        action,
        subject,
        operatorId: "00000000-0000-4000-8000-000000000001",
        decidedAt: "2026-08-20T10:00:00.000Z",
      }),
    );
    const reader = createProductUserDirectoryReader({
      config,
      fetchImplementation: implementation,
    });
    const outcome = await reader.decideProductUserAccess({
      action,
      subject,
      operatorId: "00000000-0000-4000-8000-000000000001",
    });
    // An unknown subject is reported, never invented — and the echo of the
    // personal fields is not relayed.
    assert.deepEqual(outcome, { outcome: "nothing_to_decide" });
    assert.equal(calls[0]?.url, `https://backend.example.test${path}`);
  }
});

test("a broken decision payload is an unavailable directory, not a guessed outcome", async () => {
  const wellFormed = {
    state: "approved",
    decidedBy: "operator",
    decidedAt: "2026-08-20T10:00:00.000Z",
  };
  for (const payload of [
    { outcome: "decided" },
    {
      outcome: "decided",
      changed: "yes",
      previous: wellFormed,
      resulting: wellFormed,
      effectiveAccess: { admitted: true, reason: "approved" },
    },
    {
      outcome: "decided",
      changed: true,
      previous: wellFormed,
      resulting: { state: "approved", decidedBy: "operator" },
      effectiveAccess: { admitted: true, reason: "approved" },
    },
    {
      // A verdict that disagrees with its reason must never be relayed.
      outcome: "decided",
      changed: true,
      previous: wellFormed,
      resulting: wellFormed,
      effectiveAccess: { admitted: true, reason: "suspended" },
    },
    {
      outcome: "decided",
      changed: true,
      previous: wellFormed,
      resulting: wellFormed,
      effectiveAccess: { admitted: false, reason: "approved" },
    },
    { outcome: "vetoed" },
  ]) {
    const { implementation } = recordingFetch(() => jsonResponse(payload));
    const reader = createProductUserDirectoryReader({
      config,
      fetchImplementation: implementation,
    });
    const error = await refusal(
      reader.decideProductUserAccess({
        action: "approve",
        subject,
        operatorId: "00000000-0000-4000-8000-000000000001",
      }),
    );
    assert.equal(error.code, "PRODUCT_USER_DIRECTORY_UNAVAILABLE");
  }
});

test("an unconfigured integration refuses queue reads and decisions without contact", async () => {
  const { calls, implementation } = recordingFetch(() => jsonResponse({}));
  const reader = createProductUserDirectoryReader({
    config: null,
    fetchImplementation: implementation,
  });
  for (const attempt of [
    reader.listProductUserAccessQueue({ accessState: "awaiting_review", limit: 20 }),
    reader.countAwaitingReview(),
    reader.decideProductUserAccess({
      action: "approve",
      subject,
      operatorId: "00000000-0000-4000-8000-000000000001",
    }),
  ]) {
    const error = await refusal(attempt);
    assert.equal(error.code, "PRODUCT_USER_DIRECTORY_UNCONFIGURED");
  }
  assert.equal(calls.length, 0);
});

test("the record read is the single-record lookup without the saved-item join", async () => {
  const { calls, implementation } = recordingFetch(() =>
    jsonResponse({
      record: row({
        access: {
          state: "approved",
          decidedBy: "operator",
          decidedAt: "2026-08-20T10:00:00.000Z",
          operatorRef: "operator-reference-never-serialize",
          allowlistEntryId: "allowlist-entry-never-serialize",
        },
      }),
    }),
  );
  const reader = createProductUserDirectoryReader({
    config,
    fetchImplementation: implementation,
  });

  const record = await reader.getProductUserRecord({ subject });
  assert.equal(record.subject, subject);
  assert.equal(record.email, "ada@example.test");
  // The record projection carries identity, not saved-item counts.
  assert.deepEqual(Object.keys(record).sort(), [
    "access",
    "authMethod",
    "email",
    "firstSeenAt",
    "lastSeenAt",
    "standing",
    "subject",
    "walletAddress",
  ]);
  // The stored decision's operator and allowlist references are dropped at
  // this boundary, exactly as they are on every other read.
  assert.deepEqual(record.access, {
    state: "approved",
    decidedBy: "operator",
    decidedAt: "2026-08-20T10:00:00.000Z",
  });

  // One privileged POST to the record endpoint alone — no saved-item join —
  // with the subject in the body rather than the URL.
  assert.deepEqual(
    calls.map(({ url }) => url),
    ["https://backend.example.test/admin/product-users/record"],
  );
  assert.equal(calls[0]?.init?.method, "POST");
  assert.equal(
    (calls[0]?.init?.headers as Record<string, string>).authorization,
    `Bearer ${token}`,
  );
  assert.doesNotMatch(calls[0]!.url, /did:example|\?/);
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { subject });
});

test("a record read on an unrecorded subject is not found, and a broken one is unavailable", async () => {
  const missing = recordingFetch(() => jsonResponse({ record: null }));
  const missingReader = createProductUserDirectoryReader({
    config,
    fetchImplementation: missing.implementation,
  });
  const notFound = await refusal(missingReader.getProductUserRecord({ subject }));
  assert.equal(notFound.code, "PRODUCT_USER_NOT_FOUND");
  assert.equal(notFound.status, 404);

  const broken = recordingFetch(() =>
    jsonResponse({ record: row({ standing: "weird" }) }),
  );
  const brokenReader = createProductUserDirectoryReader({
    config,
    fetchImplementation: broken.implementation,
  });
  const unavailable = await refusal(brokenReader.getProductUserRecord({ subject }));
  assert.equal(unavailable.code, "PRODUCT_USER_DIRECTORY_UNAVAILABLE");

  const unconfigured = recordingFetch(() => jsonResponse({ record: row() }));
  const unconfiguredReader = createProductUserDirectoryReader({
    config: null,
    fetchImplementation: unconfigured.implementation,
  });
  const refused = await refusal(unconfiguredReader.getProductUserRecord({ subject }));
  assert.equal(refused.code, "PRODUCT_USER_DIRECTORY_UNCONFIGURED");
  assert.equal(unconfigured.calls.length, 0);
});

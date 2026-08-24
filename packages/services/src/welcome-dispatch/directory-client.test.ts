import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createWelcomeDispatchDirectoryClient,
  WELCOME_DISPATCH_CLAIM_PATH,
  WELCOME_DISPATCH_SETTLE_PATH,
} from "./directory-client.ts";

const CONFIG = {
  baseUrl: "https://backend.example.com",
  token: "welcome-dispatch-integration-token-0001",
};

interface RecordedRequest {
  readonly url: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

function stubFetch(
  respond: (url: string) => { status: number; body: unknown },
): { calls: RecordedRequest[]; fetchImplementation: typeof fetch } {
  const calls: RecordedRequest[] = [];
  const fetchImplementation = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      authorization: headers.get("authorization"),
      body: JSON.parse(String(init?.body)),
    });
    const { status, body } = respond(url);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetchImplementation };
}

test("claiming posts the bounded request with the bearer secret and parses the claims", async () => {
  const { calls, fetchImplementation } = stubFetch(() => ({
    status: 200,
    body: {
      claims: [
        { subject: "privy.io|did:privy:one", email: "one@example.com" },
        { subject: "privy.io|did:privy:two", email: null },
      ],
    },
  }));
  const client = createWelcomeDispatchDirectoryClient({
    config: CONFIG,
    fetchImplementation,
  });

  const claims = await client.claimDueWelcomes({
    limit: 5,
    leaseMilliseconds: 60_000,
  });
  assert.deepEqual(claims, [
    { subject: "privy.io|did:privy:one", email: "one@example.com" },
    { subject: "privy.io|did:privy:two", email: null },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, `${CONFIG.baseUrl}${WELCOME_DISPATCH_CLAIM_PATH}`);
  assert.equal(calls[0]?.authorization, `Bearer ${CONFIG.token}`);
  assert.deepEqual(calls[0]?.body, { limit: 5, leaseMilliseconds: 60_000 });
});

test("settling carries the subject only in the JSON body, never the URL", async () => {
  const { calls, fetchImplementation } = stubFetch(() => ({
    status: 200,
    body: { outcome: "settled", state: "sent" },
  }));
  const client = createWelcomeDispatchDirectoryClient({
    config: CONFIG,
    fetchImplementation,
  });

  const result = await client.settleWelcome({
    subject: "privy.io|did:privy:one",
    outcome: "sent",
  });
  assert.equal(result, "settled");
  assert.equal(
    calls[0]?.url,
    `${CONFIG.baseUrl}${WELCOME_DISPATCH_SETTLE_PATH}`,
  );
  assert.equal(calls[0]?.url.includes("privy"), false);
  assert.deepEqual(calls[0]?.body, {
    subject: "privy.io|did:privy:one",
    outcome: "sent",
  });
});

test("upstream failures collapse into stable codes carrying no upstream content", async () => {
  for (const [status, code] of [
    [401, "WELCOME_DIRECTORY_UNAVAILABLE"],
    [400, "WELCOME_DIRECTORY_REQUEST_INVALID"],
    [500, "WELCOME_DIRECTORY_UNAVAILABLE"],
  ] as const) {
    const { fetchImplementation } = stubFetch(() => ({
      status,
      body: { error: "secret-bearing upstream text", code: "UPSTREAM" },
    }));
    const client = createWelcomeDispatchDirectoryClient({
      config: CONFIG,
      fetchImplementation,
    });
    await assert.rejects(
      client.claimDueWelcomes({ limit: 1, leaseMilliseconds: 60_000 }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /failed safely/);
        assert.equal((error as { code?: string }).code, code);
        assert.equal(error.message.includes("upstream"), false);
        return true;
      },
    );
  }
});

test("a network failure and a malformed response are bounded outcomes, not crashes", async () => {
  const failing = createWelcomeDispatchDirectoryClient({
    config: CONFIG,
    fetchImplementation: (async () => {
      throw new Error("ECONNREFUSED with sensitive detail");
    }) as typeof fetch,
  });
  await assert.rejects(
    failing.claimDueWelcomes({ limit: 1, leaseMilliseconds: 60_000 }),
    (error: unknown) =>
      (error as { code?: string }).code === "WELCOME_DIRECTORY_UNAVAILABLE",
  );

  for (const body of [
    { claims: [{ subject: "", email: null }] },
    { claims: [{ subject: 7, email: null }] },
    { claims: "nope" },
    {},
  ]) {
    const { fetchImplementation } = stubFetch(() => ({ status: 200, body }));
    const malformed = createWelcomeDispatchDirectoryClient({
      config: CONFIG,
      fetchImplementation,
    });
    await assert.rejects(
      malformed.claimDueWelcomes({ limit: 1, leaseMilliseconds: 60_000 }),
      (error: unknown) =>
        (error as { code?: string }).code ===
        "WELCOME_DIRECTORY_RESPONSE_INVALID",
    );
  }

  const { fetchImplementation } = stubFetch(() => ({
    status: 200,
    body: { outcome: "unexpected" },
  }));
  const client = createWelcomeDispatchDirectoryClient({
    config: CONFIG,
    fetchImplementation,
  });
  await assert.rejects(
    client.settleWelcome({ subject: "privy.io|did:privy:one", outcome: "sent" }),
    (error: unknown) =>
      (error as { code?: string }).code === "WELCOME_DIRECTORY_RESPONSE_INVALID",
  );
});

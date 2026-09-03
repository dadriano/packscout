import assert from "node:assert/strict";
import { test } from "node:test";
import { createPrivyProductUserProfileReader } from "./privy-product-user-profile.ts";

const appId = "packscout-test-app";
const appSecret = "test-provider-secret";
const userId = "did:privy:alice";
const subject = `privy.io|${userId}`;

function response(linkedAccounts: unknown, id = userId): Response {
  return Response.json({ id, linked_accounts: linkedAccounts });
}

function google() {
  return { type: "google_oauth", email: " Alice@Example.Test ", name: " Alice Lee " };
}

function reader(fetchImplementation: typeof fetch, now?: () => number) {
  return createPrivyProductUserProfileReader({ appId, appSecret, fetchImplementation, now });
}

test("missing or malformed credentials never contact the provider", async () => {
  let calls = 0;
  const fetchImplementation = async () => { calls += 1; return response([google()]); };
  for (const configuration of [
    { appId: undefined, appSecret },
    { appId, appSecret: undefined },
    { appId: "invalid/path", appSecret },
    { appId: " app-with-spaces ", appSecret },
    { appId, appSecret: "" },
    { appId, appSecret: " leading-space" },
    { appId, appSecret: "embedded\nnewline" },
    { appId, appSecret: "x".repeat(4_097) },
  ]) {
    const profiles = createPrivyProductUserProfileReader({ ...configuration, fetchImplementation });
    assert.equal(await profiles.readProfile(subject), null);
  }
  assert.equal(calls, 0);
});

test("only an exact Privy issuer-qualified DID can trigger a lookup", async () => {
  let calls = 0;
  const profiles = reader(async () => { calls += 1; return response([google()]); });
  for (const invalid of [
    userId, `https://privy.io|${userId}`, `evil.example|${userId}`,
    `privy.io.evil.example|${userId}`, `privy.io|https://evil.example`,
    `${subject}/../../users/bob`, `${subject}?secret=x`, `${subject}#fragment`,
    `${subject}|did:privy:bob`, `${subject}\n`, "privy.io|did:privy:",
    `privy.io|did:privy:${"a".repeat(129)}`,
  ]) {
    assert.equal(await profiles.readProfile(invalid), null);
  }
  assert.equal(calls, 0);
});

test("lookup uses the fixed HTTPS host, authenticated headers and no redirects", async () => {
  const profiles = reader(async (url, init) => {
    assert.equal(String(url), "https://api.privy.io/v1/users/did%3Aprivy%3Aalice");
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal instanceof AbortSignal);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("privy-app-id"), appId);
    assert.equal(headers.get("authorization"), `Basic ${Buffer.from(`${appId}:${appSecret}`).toString("base64")}`);
    assert.equal(init?.body, undefined);
    return response([google()]);
  });
  assert.deepEqual(await profiles.readProfile(subject), { name: "Alice Lee", email: "alice@example.test" });
});

test("returned identity must match the requested user, even in a successful response", async () => {
  for (const payload of [
    { id: "did:privy:bob", linked_accounts: [google()] },
    { linked_accounts: [google()] },
    { id: userId, linked_accounts: "not-an-array" },
    { id: userId, linked_accounts: Array(101).fill(google()) },
    null, [],
  ]) {
    assert.equal(await reader(async () => Response.json(payload)).readProfile(subject), null);
  }
});

test("linked email wins over Google email, while an email-only account has no invented name", async () => {
  const profiles = reader(async () => response([
    google(), { type: "email", address: " Primary@Example.Test " },
  ]));
  assert.deepEqual(await profiles.readProfile(subject), { name: "Alice Lee", email: "primary@example.test" });
  const emailOnly = reader(async () => response([{ type: "email", address: "alice@example.test" }]));
  assert.deepEqual(await emailOnly.readProfile(subject), { name: null, email: "alice@example.test" });
});

test("arbitrary metadata and unrelated accounts never become profile identity", async () => {
  const profiles = reader(async () => Response.json({
    id: userId,
    name: "Not trusted",
    email: "not-trusted@example.test",
    custom_metadata: { name: "Not trusted", email: "not-trusted@example.test" },
    linked_accounts: [null, "string", { type: "custom_auth", email: "attacker@example.test", name: "Attacker" }],
    access_token: appSecret,
  }));
  assert.equal(await profiles.readProfile(subject), null);
});

test("malformed and overlong attributes are omitted, never truncated into another identity", async () => {
  for (const malformed of [null, 7, "", "  ", "no-at-sign", "two@@example.test", "space d@example.test", "bad\u0000@example.test", `${"a".repeat(321)}@example.test`]) {
    const profiles = reader(async () => response([{ type: "email", address: malformed }]));
    assert.equal(await profiles.readProfile(subject), null);
  }
  for (const malformed of [null, 7, "", "  ", "x".repeat(241), "Alice\u0000Lee"]) {
    const profiles = reader(async () => response([{ ...google(), name: malformed }]));
    assert.deepEqual(await profiles.readProfile(subject), { name: null, email: "alice@example.test" });
  }
});

test("HTTP, transport, malformed JSON and oversized-body failures expose no upstream details", async () => {
  const failures: Array<typeof fetch> = [
    async () => { throw new Error(`transport failure containing ${appSecret}`); },
    async () => new Response(appSecret, { status: 401 }),
    async () => new Response(appSecret, { status: 429 }),
    async () => new Response(appSecret, { status: 302, headers: { location: "https://evil.example" } }),
    async () => new Response("{ invalid JSON"),
    async () => new Response("x".repeat(128 * 1_024 + 1)),
  ];
  for (const fetchImplementation of failures) {
    assert.equal(await reader(fetchImplementation).readProfile(subject), null);
  }
});

test("the deadline aborts a hanging request and a hanging response body", async () => {
  let requestAborted = false;
  const requestHang = createPrivyProductUserProfileReader({
    appId, appSecret, timeoutMs: 5,
    fetchImplementation: async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        requestAborted = true;
        reject(new Error("request aborted"));
      }, { once: true });
    }),
  });
  assert.equal(await requestHang.readProfile(subject), null);
  assert.equal(requestAborted, true);

  let bodyCancelled = false;
  const bodyHang = createPrivyProductUserProfileReader({
    appId, appSecret, timeoutMs: 5,
    fetchImplementation: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"id":')); },
      cancel() { bodyCancelled = true; },
    })),
  });
  assert.equal(await bodyHang.readProfile(subject), null);
  assert.equal(bodyCancelled, true);
});

test("concurrent reads of one identity share a request and cached profiles expire", async () => {
  let now = 0;
  let calls = 0;
  const profiles = reader(async () => { calls += 1; return response([google()]); }, () => now);
  const results = await Promise.all(Array.from({ length: 20 }, () => profiles.readProfile(subject)));
  assert.equal(calls, 1);
  assert.ok(results.every((profile) => profile?.name === "Alice Lee"));
  now = 299_999;
  assert.deepEqual(await profiles.readProfile(subject), results[0]);
  assert.equal(calls, 1);
  now = 300_000;
  await profiles.readProfile(subject);
  assert.equal(calls, 2);
});

test("queued profiles expire inside the original request budget during an outage", async () => {
  let calls = 0;
  const profiles = createPrivyProductUserProfileReader({
    appId, appSecret, timeoutMs: 10,
    fetchImplementation: async (_url, init) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  });
  const results = await Promise.all(Array.from({ length: 20 }, (_, index) =>
    profiles.readProfile(`privy.io|did:privy:queued-${index}`),
  ));
  assert.ok(results.every((profile) => profile === null));
  // Without an enqueue deadline all twenty requests would eventually start,
  // forcing a page to wait through five sequential timeout windows.
  assert.ok(calls < 20);
});

test("missing profiles are cached briefly and retried after the negative-cache deadline", async () => {
  let now = 0;
  let calls = 0;
  const profiles = reader(async () => {
    calls += 1;
    return calls === 1 ? new Response("unavailable", { status: 503 }) : response([google()]);
  }, () => now);
  assert.equal(await profiles.readProfile(subject), null);
  now = 29_999;
  assert.equal(await profiles.readProfile(subject), null);
  assert.equal(calls, 1);
  now = 30_000;
  assert.equal((await profiles.readProfile(subject))?.name, "Alice Lee");
  assert.equal(calls, 2);
});

test("the profile cache evicts old entries instead of retaining unlimited personal data", async () => {
  let calls = 0;
  const profiles = reader(async (url) => {
    calls += 1;
    return response([google()], decodeURIComponent(String(url).split("/").at(-1)!));
  }, () => 0);
  for (let index = 0; index < 257; index += 1) {
    await profiles.readProfile(`privy.io|did:privy:user-${index}`);
  }
  await profiles.readProfile("privy.io|did:privy:user-256");
  assert.equal(calls, 257);
  await profiles.readProfile("privy.io|did:privy:user-0");
  assert.equal(calls, 258);
});

test("pages share a bounded request pool and excess queued work degrades safely", async () => {
  const pending: Array<() => void> = [];
  let active = 0;
  let peak = 0;
  let calls = 0;
  const profiles = reader(async (url) => {
    calls += 1;
    active += 1;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => pending.push(resolve));
    active -= 1;
    return response([google()], decodeURIComponent(String(url).split("/").at(-1)!));
  });
  const reads = Array.from({ length: 68 }, (_, index) => profiles.readProfile(`privy.io|did:privy:user-${index}`));
  assert.equal(calls, 4);
  assert.equal(await reads[64], null);
  while (calls < 64 || pending.length > 0) {
    pending.splice(0).forEach((finish) => finish());
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const results = await Promise.all(reads);
  assert.equal(peak, 4);
  assert.equal(calls, 64);
  assert.equal(results.filter((profile) => profile !== null).length, 64);
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { captureHardenedProviderResponse, HardenedProviderRequestError } from "../../hardened-provider-request.ts";
import { captureClutchpacksPublicPackMembershipV1, CLUTCHPACKS_PUBLIC_MEMBERSHIP_TIMEOUT_MS_V1,
  MAX_CLUTCHPACKS_PUBLIC_MEMBERSHIP_RESPONSE_BYTES_V1 } from "./public-pack-membership-source-v1.ts";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const observed = Date.parse("2026-08-30T21:40:00.000Z");
function source(providerRecordId = id(1)) {
  return { collection_id: providerRecordId, status: "active", sold_out: false, directly_purchasable: true,
    price_bucket_odds: [{ bucket_id: id(10), drawable_count: 2, has_more: true, preview_cards: [
      { id: id(100), title: "A featured card", front_image_url: "https://d18ez2bunk7yz0.cloudfront.net/cards/medium-images/card.jpg" },
    ] }] };
}
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const captureValue = (value: unknown) => ({ status: 200, protectedBody: bytes(value),
  durationMilliseconds: 0, responseBytes: bytes(value).byteLength });

test("public snapshots use the pinned unauthenticated origin sequentially without paging or invented source revisions", async () => {
  const requests: string[] = [];
  let active = 0;
  let maximumActive = 0;
  const snapshots = await captureClutchpacksPublicPackMembershipV1({ nativePackIds: [id(1), id(2)] }, {
    now: () => observed,
    capture: async (input, dependencies) => {
      assert.equal(input.timeoutMilliseconds, 20_000);
      assert.equal(input.maximumResponseBytes, 2 * 1024 * 1024);
      assert.deepEqual(input.allowedHosts, ["api.clutchpacks.io"]);
      assert.equal(input.allowLocalHttp, undefined);
      return captureHardenedProviderResponse(input, dependencies);
    },
    requestDependencies: {
      resolveHost: async () => ["93.184.216.34"],
      httpClient: async (url, init, destination) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        requests.push(url.toString());
        assert.equal(url.origin, "https://api.clutchpacks.io");
        assert.equal(init.method, "GET");
        assert.equal(init.redirect, "manual");
        const headers = new Headers(init.headers);
        assert.equal(headers.get("authorization"), null);
        assert.equal(headers.get("cookie"), null);
        assert.equal(headers.get("accept"), "application/json");
        assert.deepEqual(destination.addresses, ["93.184.216.34"]);
        await Promise.resolve();
        active -= 1;
        return new Response(JSON.stringify(source(url.pathname.split("/").at(-1)!)));
      },
    },
  });
  assert.equal(maximumActive, 1);
  assert.equal(requests.length, 2);
  assert.equal(snapshots[0]!.membership.completeness, "partial");
  assert.equal(snapshots[0]!.observedAt, "2026-08-30T21:40:00.000Z");
  assert.equal(snapshots[0]!.timeBasis, "response_observed_at");
  assert.equal(snapshots[0]!.sourceRevision, null);
  assert.equal(snapshots[0]!.sourceUpdatedAt, null);
  assert.equal(snapshots[0]!.responseSha256, createHash("sha256").update(bytes(source())).digest("hex"));
  assert.equal(CLUTCHPACKS_PUBLIC_MEMBERSHIP_TIMEOUT_MS_V1, 20_000);
});

test("invalid and duplicate pack scopes fail before any request", async () => {
  let calls = 0;
  for (const nativePackIds of [[], [id(1), id(1)], ["https://localhost/private"], ["../private"],
    Array.from({ length: 101 }, (_, index) => id(index + 1))]) {
    await assert.rejects(captureClutchpacksPublicPackMembershipV1({ nativePackIds }, {
      capture: async () => { calls += 1; return captureValue(source()); },
    }), /invalid_scope/u);
  }
  assert.equal(calls, 0);
});

test("identity mismatch, missing membership, missing availability and malformed responses fail safely", async () => {
  await assert.rejects(captureClutchpacksPublicPackMembershipV1({ nativePackIds: [id(1)] }, {
    capture: async () => captureValue(source(id(2))), now: () => observed,
  }), /identity_mismatch/u);
  for (const body of ["invalid json with sensitive source detail", { collection_id: id(1) },
    { ...source(), status: undefined, directly_purchasable: undefined },
    { ...source(), status: "unknown-new-status" }]) {
    await assert.rejects(captureClutchpacksPublicPackMembershipV1({ nativePackIds: [id(1)] }, {
      capture: async () => captureValue(body), now: () => observed,
    }), /^Error: clutchpacks_public_pack_membership.invalid_response$/u);
  }
  await assert.rejects(captureClutchpacksPublicPackMembershipV1({ nativePackIds: [id(1)] }, {
    capture: async () => ({ status: 200, protectedBody: new Uint8Array([255]), durationMilliseconds: 0, responseBytes: 1 }),
  }), /invalid_response/u);
});

test("private DNS answers and redirects cannot become public membership evidence", async () => {
  let requests = 0;
  await assert.rejects(captureClutchpacksPublicPackMembershipV1({ nativePackIds: [id(1)] }, {
    requestDependencies: { resolveHost: async () => ["127.0.0.1"],
      httpClient: async () => { requests += 1; return new Response("{}"); } },
  }), (error: unknown) => error instanceof HardenedProviderRequestError && error.code === "destination_not_allowed");
  assert.equal(requests, 0);
  await assert.rejects(captureClutchpacksPublicPackMembershipV1({ nativePackIds: [id(1)] }, {
    requestDependencies: { resolveHost: async () => ["93.184.216.34"],
      httpClient: async () => { requests += 1; return new Response(null, { status: 302,
        headers: { Location: "https://localhost/private" } }); } },
  }), (error: unknown) => error instanceof HardenedProviderRequestError && error.code === "redirect_rejected");
  assert.equal(requests, 1);
});

test("body limits settle and cancel oversized responses without retries", async () => {
  let cancelled = false;
  let requests = 0;
  await assert.rejects(captureClutchpacksPublicPackMembershipV1({ nativePackIds: [id(1)] }, {
    requestDependencies: { resolveHost: async () => ["93.184.216.34"], httpClient: async () => {
      requests += 1;
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
        headers: { "Content-Length": String(MAX_CLUTCHPACKS_PUBLIC_MEMBERSHIP_RESPONSE_BYTES_V1 + 1) },
      });
    } },
  }), (error: unknown) => error instanceof HardenedProviderRequestError && error.code === "response_too_large");
  assert.equal(cancelled, true);
  assert.equal(requests, 1);
});

test("an aborted source operation stops before transport work", async () => {
  const controller = new AbortController();
  controller.abort();
  let requests = 0;
  await assert.rejects(captureClutchpacksPublicPackMembershipV1({ nativePackIds: [id(1)], signal: controller.signal }, {
    requestDependencies: { resolveHost: async () => ["93.184.216.34"],
      httpClient: async () => { requests += 1; return new Response("{}"); } },
  }), (error: unknown) => error instanceof HardenedProviderRequestError && error.code === "cancelled");
  assert.equal(requests, 0);
});

test("captured response buffers are cleared after success, malformed data, identity and clock failures", async () => {
  const cases = [
    { body: source(), clock: observed, error: null },
    { body: source(id(2)), clock: observed, error: /identity_mismatch/u },
    { body: { collection_id: id(1) }, clock: observed, error: /invalid_response/u },
    { body: source(), clock: Number.NaN, error: /invalid_response/u },
  ];
  for (const item of cases) {
    const body = bytes(item.body);
    const operation = captureClutchpacksPublicPackMembershipV1({ nativePackIds: [id(1)] }, {
      capture: async () => ({ status: 200, protectedBody: body, responseBytes: body.byteLength, durationMilliseconds: 0 }),
      now: () => item.clock,
    });
    if (item.error === null) await operation;
    else await assert.rejects(operation, item.error);
    assert.ok(body.every((byte) => byte === 0));
  }
});

test("capture-wide byte budget bounds a large explicit pack scope and clears the refused body", async () => {
  let calls = 0;
  let lastBody: Uint8Array | null = null;
  await assert.rejects(captureClutchpacksPublicPackMembershipV1({
    nativePackIds: Array.from({ length: 18 }, (_, index) => id(index + 1)),
  }, {
    capture: async (input) => {
      calls += 1;
      const json = JSON.stringify(source(input.url.pathname.split("/").at(-1)!));
      lastBody = new TextEncoder().encode(json.padEnd(MAX_CLUTCHPACKS_PUBLIC_MEMBERSHIP_RESPONSE_BYTES_V1, " "));
      return { status: 200, protectedBody: lastBody, responseBytes: lastBody.byteLength, durationMilliseconds: 0 };
    },
    now: () => observed,
  }), /capture_too_large/u);
  assert.equal(calls, 17);
  assert.ok(lastBody !== null);
  assert.ok((lastBody as Uint8Array).every((byte) => byte === 0));
});

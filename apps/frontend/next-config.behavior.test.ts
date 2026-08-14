import assert from "node:assert/strict";
import { test } from "node:test";
import nextConfig from "./next.config";

test("frontend responses carry the static security header baseline", async () => {
  const resolveHeaders = nextConfig.headers;
  assert.ok(resolveHeaders, "Next config must apply global response headers");

  const rules = await resolveHeaders();
  const globalRule = rules.find(({ source }) => source === "/(.*)");
  assert.ok(globalRule, "security headers must cover every frontend route");

  const headers = new Map(
    globalRule.headers.map(({ key, value }) => [key.toLowerCase(), value]),
  );

  assert.equal(headers.get("x-frame-options"), "DENY");
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.equal(
    headers.get("strict-transport-security"),
    "max-age=63072000; includeSubDomains; preload",
  );

  assert.equal(
    headers.has("content-security-policy"),
    false,
    "request-specific CSP belongs to proxy.ts so one nonce reaches Next rendering",
  );
});

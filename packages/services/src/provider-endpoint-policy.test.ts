import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ProviderEndpointPolicyError,
  validateProviderEndpoint,
} from "./provider-endpoint-policy.ts";

test("production endpoint policy derives one exact normalized host", () => {
  const validated = validateProviderEndpoint(
    "https://Provider.Example./feed?existing=true",
    "production",
  );
  assert.equal(validated.endpointHost, "provider.example");
  assert.deepEqual(validated.allowedHosts, ["provider.example"]);
  assert.equal(
    validated.endpoint,
    "https://provider.example/feed?existing=true",
  );
});

test("endpoint policy rejects credentials, fragments, insecure production, and nonstandard ports", () => {
  const endpoints = [
    "http://provider.example/feed",
    "https://user:password@provider.example/feed",
    "https://provider.example/feed#fragment",
    "https://provider.example:8443/feed",
  ];
  for (const endpoint of endpoints) {
    assert.throws(
      () => validateProviderEndpoint(endpoint, "production"),
      ProviderEndpointPolicyError,
      endpoint,
    );
  }
});

test("local HTTP is limited to an exact loopback hostname", () => {
  assert.equal(
    validateProviderEndpoint("http://localhost:4312/feed", "local")
      .endpointHost,
    "localhost",
  );
  assert.throws(
    () => validateProviderEndpoint("http://localhost.attacker.test/feed", "local"),
    ProviderEndpointPolicyError,
  );
});

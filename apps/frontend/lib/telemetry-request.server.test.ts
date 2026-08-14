import assert from "node:assert/strict";
import { test } from "node:test";
import { configuredPublicOrigin } from "./telemetry-request.server";

test("requires an exact credential-free HTTPS public origin in production", () => {
  assert.equal(
    configuredPublicOrigin("https://packscout.example", "production"),
    "https://packscout.example",
  );
  for (const value of [
    undefined,
    "",
    "https://packscout.example/path",
    "https://packscout.example?query=secret",
    "https://user:secret@packscout.example",
    "http://packscout.example",
    "javascript:alert(1)",
  ]) {
    assert.equal(configuredPublicOrigin(value, "production"), null);
  }
});

test("permits only explicit loopback HTTP origins outside production", () => {
  assert.equal(
    configuredPublicOrigin("http://localhost:5100", "development"),
    "http://localhost:5100",
  );
  assert.equal(
    configuredPublicOrigin("http://127.0.0.1:5100", "test"),
    "http://127.0.0.1:5100",
  );
  assert.equal(
    configuredPublicOrigin("http://192.168.1.2:5100", "development"),
    null,
  );
});

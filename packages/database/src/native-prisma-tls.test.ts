import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeNativePrismaTlsUrl } from "./native-prisma-tls.ts";

const base = "postgresql://test-user:test-password@database.example.test:5432/packscout";

test("verify-full requires native Prisma TLS and strict certificate validation without changing the input", () => {
  const input = new URL(`${base}?sslmode=verify-full&connect_timeout=15&connection_limit=2&sslcert=%2Ftest-ca.pem`);
  const actual = normalizeNativePrismaTlsUrl(input);
  assert.equal(input.searchParams.get("sslmode"), "verify-full");
  assert.equal(input.searchParams.has("sslaccept"), false);
  assert.equal(actual.searchParams.get("sslmode"), "require");
  assert.equal(actual.searchParams.get("sslaccept"), "strict");
  assert.equal(actual.searchParams.get("sslcert"), "/test-ca.pem");
  assert.equal(actual.searchParams.get("connect_timeout"), "15");
  assert.equal(actual.searchParams.get("connection_limit"), "2");
  assert.equal(actual.origin, input.origin);
  assert.equal(actual.pathname, input.pathname);
  assert.equal(actual.username, input.username);
  assert.equal(actual.password, input.password);
  assert.equal(normalizeNativePrismaTlsUrl(actual).toString(), actual.toString());
});

test("explicit supported native modes and existing local defaults are preserved", () => {
  for (const query of ["", "sslmode=disable", "sslmode=prefer", "sslmode=require", "sslmode=require&sslaccept=strict"]) {
    const input = new URL(`${base}${query ? `?${query}` : ""}`);
    assert.equal(normalizeNativePrismaTlsUrl(input).toString(), input.toString());
  }
});

test("unknown, CA-only, contradictory, and ambiguous TLS settings fail closed without leaking credentials", () => {
  for (const query of [
    "sslmode=verify-ca",
    "sslmode=unrecognized",
    "sslmode=",
    "sslmode=verify-full&sslaccept=accept_invalid_certs",
    "sslmode=verify-full&sslaccept=unknown",
    "sslmode=verify-full&sslmode=disable",
    "sslmode=disable&sslmode=verify-full",
    "sslmode=verify-full&sslaccept=strict&sslaccept=accept_invalid_certs",
    "sslmode=verify-full&sslcert=first&sslcert=second",
    "sslmode=verify-full&sslrootcert=system",
  ]) {
    assert.throws(() => normalizeNativePrismaTlsUrl(new URL(`${base}?${query}`)), (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.equal(error.message.includes("test-password"), false);
      assert.equal(error.message.includes("test-user"), false);
      return true;
    });
  }
});

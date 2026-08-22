import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adminDevelopmentAllowedOrigins,
  adminDevelopmentServerNetwork,
  readAllowedOrigins,
  readBase64Key,
  readServiceHost,
  readPort,
  readPositiveDuration,
  readPositiveInteger,
  readRequiredSecret,
  readTrustedProxies,
  serviceHttpOrigin,
} from "./runtime-config.ts";

test("admin local host binding accepts only explicit loopback hosts", () => {
  assert.equal(
    readServiceHost(undefined, "127.0.0.1", "PACKSCOUT_ADMIN_HOST"),
    "127.0.0.1",
  );
  for (const host of ["127.0.0.1", "::1", "localhost"]) {
    assert.equal(readServiceHost(host, "127.0.0.1", "HOST"), host);
  }
  for (const host of ["0.0.0.0", "::", "admin.local", "127.0.0.2"]) {
    assert.throws(
      () => readServiceHost(host, "127.0.0.1", "PACKSCOUT_ADMIN_HOST"),
      /PACKSCOUT_ADMIN_HOST must be 127\.0\.0\.1, ::1, or localhost/,
    );
  }
  assert.equal(
    readServiceHost(undefined, "0.0.0.0", "PACKSCOUT_ADMIN_HOST", false),
    "0.0.0.0",
  );
  assert.throws(
    () => readServiceHost("admin.internal", "0.0.0.0", "HOST", false),
    /HOST must be a valid IP address or localhost/,
  );
});

test("admin Vite HTTP and HMR development sockets share the loopback host", () => {
  assert.deepEqual(adminDevelopmentServerNetwork("127.0.0.1", 5102), {
    middlewareMode: true,
    hmr: { host: "127.0.0.1", port: 5102 },
  });
});

test("admin development origins and log URLs format IPv6 loopback safely", () => {
  assert.equal(serviceHttpOrigin("::1", 5101), "http://[::1]:5101");
  assert.deepEqual(adminDevelopmentAllowedOrigins("::1", 5101), [
    "http://localhost:5101",
    "http://127.0.0.1:5101",
    "http://[::1]:5101",
  ]);
  assert.deepEqual(adminDevelopmentAllowedOrigins("localhost", 5101), [
    "http://localhost:5101",
    "http://127.0.0.1:5101",
  ]);
});

test("admin ports use a validated fallback", () => {
  assert.equal(readPort(undefined, 5101, "PACKSCOUT_ADMIN_PORT"), 5101);
  assert.equal(readPort("5199", 5101, "PACKSCOUT_ADMIN_PORT"), 5199);
});

test("admin ports fail closed on invalid values", () => {
  for (const value of ["0", "65536", "5101.5", "not-a-port"]) {
    assert.throws(
      () => readPort(value, 5101, "PACKSCOUT_ADMIN_PORT"),
      /PACKSCOUT_ADMIN_PORT must be an integer between 1 and 65535/,
    );
  }
});

test("admin security configuration fails closed and normalizes trusted origins", () => {
  assert.equal(readRequiredSecret("x".repeat(32), "SECRET", 32).length, 32);
  assert.throws(() => readRequiredSecret("short", "SECRET", 32), /SECRET/);
  assert.equal(readPositiveDuration(undefined, 60_000, "IDLE_MS"), 60_000);
  assert.throws(() => readPositiveDuration("0", 60_000, "IDLE_MS"), /IDLE_MS/);
  assert.equal(readPositiveInteger("7", "KEY_VERSION"), 7);
  for (const invalid of [undefined, "", "0", " 1", "1 ", "1.5", "2147483648"]) {
    assert.throws(() => readPositiveInteger(invalid, "KEY_VERSION"), /KEY_VERSION/u);
  }
  assert.deepEqual(
    readAllowedOrigins(
      "https://admin.packscout.test/path, https://admin.packscout.test",
      [],
      "ORIGINS",
    ),
    ["https://admin.packscout.test"],
  );
  assert.throws(() => readAllowedOrigins("not a url", [], "ORIGINS"), /ORIGINS/);
});

test("provider credential keys require canonical base64 with exactly 32 bytes", () => {
  const encoded = Buffer.alloc(32, 7).toString("base64");
  assert.deepEqual(readBase64Key(encoded, "PROVIDER_KEY"), Buffer.alloc(32, 7));
  for (const invalid of [undefined, "not base64", Buffer.alloc(31).toString("base64")]) {
    assert.throws(() => readBase64Key(invalid, "PROVIDER_KEY"), /PROVIDER_KEY/);
  }
});

test("trusted proxies accept only explicit IP addresses and bounded CIDR ranges", () => {
  assert.deepEqual(
    readTrustedProxies(undefined, "PACKSCOUT_ADMIN_TRUSTED_PROXIES"),
    [],
  );
  assert.deepEqual(
    readTrustedProxies(
      "10.0.0.12, 10.0.0.0/24, 2001:db8::1/128, 10.0.0.12",
      "PACKSCOUT_ADMIN_TRUSTED_PROXIES",
    ),
    ["10.0.0.12", "10.0.0.0/24", "2001:db8::1/128"],
  );

  for (const invalid of [
    "*",
    "true",
    "loopback",
    "0.0.0.0/0",
    "::/0",
    "10.0.0.0/33",
    "2001:db8::/129",
  ]) {
    assert.throws(
      () => readTrustedProxies(invalid, "PACKSCOUT_ADMIN_TRUSTED_PROXIES"),
      /PACKSCOUT_ADMIN_TRUSTED_PROXIES/,
    );
  }
});

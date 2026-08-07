import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readAllowedOrigins,
  readBase64Key,
  readPort,
  readPositiveDuration,
  readRequiredSecret,
} from "./runtime-config.ts";

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

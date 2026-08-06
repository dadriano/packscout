import assert from "node:assert/strict";
import { test } from "node:test";
import { readPort } from "./runtime-config.ts";

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

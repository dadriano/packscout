import assert from "node:assert/strict";
import { test } from "node:test";
import { sourceSupervisorFatalEvent } from
  "./source-supervisor-fatal-event.ts";
import { ProviderSourceSupervisorConfigurationError } from
  "./source-supervisor-runtime-config.ts";

test("fatal supervisor events expose only owned configuration codes", () => {
  assert.deepEqual(
    sourceSupervisorFatalEvent(
      new ProviderSourceSupervisorConfigurationError("DATABASE_URL_INVALID"),
    ),
    {
      level: "error",
      event: "provider_source_supervisor_fatal",
      failureCode: "DATABASE_URL_INVALID",
    },
  );
});

test("fatal supervisor events do not copy arbitrary error data", () => {
  const secret = "short-secret";
  const error = Object.assign(new Error(`Bearer ${secret}`), {
    name: secret,
    code: secret,
  });
  const serialized = JSON.stringify(sourceSupervisorFatalEvent(error));

  assert.equal(serialized.includes(secret), false);
  assert.deepEqual(JSON.parse(serialized), {
    level: "error",
    event: "provider_source_supervisor_fatal",
    failureCode: "PROVIDER_SOURCE_SUPERVISOR_FATAL",
  });
});

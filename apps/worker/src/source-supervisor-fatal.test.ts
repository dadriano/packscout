import assert from "node:assert/strict";
import { test } from "node:test";
import { providerSourceSupervisorFatalRecord } from
  "./source-supervisor-fatal.ts";
import { ProviderSourceSupervisorConfigurationError } from
  "./source-supervisor-runtime-config.ts";

test("fatal supervisor output never copies dependency error fields", () => {
  const opaqueToken = "short-opaque-token";
  const failure = Object.assign(
    new Error(`dependency rejected ${opaqueToken}`),
    { code: opaqueToken, name: opaqueToken },
  );

  const record = providerSourceSupervisorFatalRecord(failure);

  assert.deepEqual(record, {
    level: "error",
    event: "provider_source_supervisor_fatal",
    failureCode: "PROVIDER_SOURCE_SUPERVISOR_FATAL",
  });
  assert.equal(JSON.stringify(record).includes(opaqueToken), false);
});

test("fatal supervisor output retains allowlisted configuration codes", () => {
  assert.deepEqual(
    providerSourceSupervisorFatalRecord(
      new ProviderSourceSupervisorConfigurationError("DATABASE_URL_INVALID"),
    ),
    {
      level: "error",
      event: "provider_source_supervisor_fatal",
      failureCode: "DATABASE_URL_INVALID",
    },
  );
});

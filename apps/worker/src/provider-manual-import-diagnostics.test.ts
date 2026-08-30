import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderCaptureSourceError } from "./provider-capture-source-contract.ts";
import { ProviderDataforrestSourceError } from "./provider-dataforrest-mixed-page-source.ts";
import {
  classifyProviderManualImportFailure,
  providerManualImportTerminalDiagnostic,
  type ProviderManualImportStage,
} from "./provider-manual-import-diagnostics.ts";

test("typed source failures retain their stable codes and source classification", () => {
  for (const error of [
    new ProviderCaptureSourceError("PROVIDER_CAPTURE_HASH_MISMATCH"),
    new ProviderDataforrestSourceError("PROVIDER_DATAFORREST_REQUEST_TIMEOUT"),
  ]) {
    const actual = classifyProviderManualImportFailure(error, "source_read");
    assert.equal(actual.failureCode, error.code);
    assert.equal(actual.failureClass, "source");
    assert.match(actual.failureSummary, /stage=source_read; category=source/u);
  }
});

test("database failures are allowlisted independently of the stage and contain no raw error data", () => {
  const secret = "private-cursor-token-native-record-and-query";
  const actual = classifyProviderManualImportFailure({
    code: "P2010", message: secret,
    meta: { code: "40001", message: secret, query: secret }, cause: secret,
  }, "fact_reference_reconciliation");
  assert.equal(actual.failureClass, "database");
  assert.equal(actual.failureCode, "PROVIDER_IMPORT_DATABASE_SERIALIZATION_CONFLICT");
  assert.match(actual.failureSummary, /stage=fact_reference_reconciliation/u);
  assert.equal(JSON.stringify(actual).includes(secret), false);
  assert.equal(classifyProviderManualImportFailure({ code: "40P01" }, "source_read")
    .failureClass, "database");
});

test("closed transaction and query cancellation do not falsely assert a timeout cause", () => {
  assert.equal(classifyProviderManualImportFailure({ code: "P2028" }, "page_commit")
    .failureCode, "PROVIDER_IMPORT_DATABASE_TRANSACTION_INVALID");
  assert.equal(classifyProviderManualImportFailure({ code: "57014" }, "page_commit")
    .failureCode, "PROVIDER_IMPORT_DATABASE_QUERY_CANCELLED");
  assert.equal(classifyProviderManualImportFailure({ code: "P2034" }, "page_commit")
    .failureCode, "PROVIDER_IMPORT_DATABASE_TRANSACTION_CONFLICT");
});

test("unknown exceptions remain non-source failures even during source reads", () => {
  for (const error of [new Error("private details"), { code: "unreviewed-private-code" }, null]) {
    assert.deepEqual(classifyProviderManualImportFailure(error, "source_read"), {
      failureCode: "PROVIDER_IMPORT_EXECUTION_FAILED", failureClass: "worker",
      failureSummary: "Provider import stopped; stage=source_read; category=unclassified_execution_failure.",
    });
  }
});

test("untrusted error accessors and unknown typed codes are not read or disclosed", () => {
  let reads = 0;
  const error = Object.defineProperty({}, "code", { get() { reads += 1; throw new Error("private"); } });
  assert.equal(classifyProviderManualImportFailure(error, "page_commit").failureClass, "worker");
  assert.equal(reads, 0);
  const proxy = new Proxy({}, {
    getOwnPropertyDescriptor() { throw new Error("private property trap"); },
    getPrototypeOf() { throw new Error("private prototype trap"); },
  });
  assert.equal(classifyProviderManualImportFailure(proxy, "page_commit").failureClass, "worker");
  const typed = new ProviderCaptureSourceError("PROVIDER_CAPTURE_FILE_INVALID");
  Object.defineProperty(typed, "code", { value: "private injected value" });
  const actual = classifyProviderManualImportFailure(typed, "private stage" as ProviderManualImportStage);
  assert.equal(actual.failureCode, "PROVIDER_IMPORT_EXECUTION_FAILED");
  assert.match(actual.failureSummary, /stage=execution/u);
  assert.equal(JSON.stringify(actual).includes("private"), false);
});

test("internal terminal decisions are configuration or worker failures", () => {
  assert.equal(providerManualImportTerminalDiagnostic("PROVIDER_CONFIGURATION_UNAVAILABLE")
    .failureClass, "configuration");
  assert.equal(providerManualImportTerminalDiagnostic("PROVIDER_IMPORT_PAGE_LIMIT_EXCEEDED")
    .failureClass, "worker");
});

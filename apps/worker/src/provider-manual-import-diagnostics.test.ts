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
    new ProviderDataforrestSourceError(
      "PROVIDER_DATAFORREST_CATALOG_RESTART_UNSUPPORTED",
    ),
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

test("every expired-transaction P2028 template classifies as expiry while other P2028s stay invalid", async () => {
  const { ProviderPrisma } = await import("@packscout/database/test-support");
  const expired = (operation: string) => new ProviderPrisma.PrismaClientKnownRequestError("private query text", {
    code: "P2028", clientVersion: "6.19.3",
    meta: { error: `Transaction already closed: A ${operation} cannot be executed on an expired transaction. The timeout for this transaction was 480000 ms, however 480205 ms passed since the start of the transaction. Consider increasing the interactive transaction timeout or doing less work in the transaction.` },
  });
  for (const operation of ["query", "batch query", "commit", "rollback"]) {
    const classified = classifyProviderManualImportFailure(expired(operation), "head_reconciliation");
    assert.equal(classified.failureCode, "PROVIDER_IMPORT_DATABASE_TRANSACTION_EXPIRED");
    assert.equal(classified.failureClass, "database");
    assert.match(classified.failureSummary, /stage=head_reconciliation; category=transaction_expired/u);
    assert.equal(JSON.stringify(classified).includes("private"), false);
  }
  const unknown = new ProviderPrisma.PrismaClientKnownRequestError("private query text", {
    code: "P2028", clientVersion: "6.19.3",
    meta: { error: "Transaction not found. Transaction ID is invalid, refers to an old closed transaction Prisma doesn't have information about anymore, or was obtained before disconnecting." },
  });
  assert.equal(classifyProviderManualImportFailure(unknown, "head_reconciliation").failureCode,
    "PROVIDER_IMPORT_DATABASE_TRANSACTION_INVALID");
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

test("only positively typed page expiration receives the specific expiration diagnostic", async () => {
  const { ProviderPageTransactionExpiredError } = await import("@packscout/database");
  const classified = classifyProviderManualImportFailure(new ProviderPageTransactionExpiredError(30_000, 30_001), "page_commit");
  assert.equal(classified.failureCode, "PROVIDER_IMPORT_DATABASE_TRANSACTION_EXPIRED");
  assert.equal(classified.failureSummary, "Provider import stopped; stage=page_commit; category=transaction_expired.");
  assert.equal(classifyProviderManualImportFailure({ code: "PROVIDER_PAGE_TRANSACTION_EXPIRED" }, "page_commit").failureCode,
    "PROVIDER_IMPORT_EXECUTION_FAILED");
});

import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const {
  LocalClutchpacksWorkerE2eError,
  assertProtectedDumpMetadata,
  isOwnedTemporaryClusterPath,
  parseClutchpacksWorkerE2eArguments,
  postgresUrl,
} = await tsImport(
  "./run-clutchpacks-provider-promotion-frontend-e2e.mts",
  import.meta.url,
);

function refusal(code) {
  return (error) => {
    assert.ok(error instanceof LocalClutchpacksWorkerE2eError);
    assert.equal(error.code, code);
    return true;
  };
}

test("CLI accepts no arguments and rejects all operator-selected targets", () => {
  assert.doesNotThrow(() => parseClutchpacksWorkerE2eArguments([]));
  assert.throws(
    () => parseClutchpacksWorkerE2eArguments(["--database", "postgres"]),
    refusal("LOCAL_CLUTCHPACKS_WORKER_E2E_ARGUMENT_INVALID"),
  );
});

test("cleanup ownership is limited to one generated direct child of /tmp", () => {
  assert.equal(
    isOwnedTemporaryClusterPath(
      "/tmp/packscout-clutchpacks-worker-e2e-aB90xy",
    ),
    true,
  );
  for (const candidate of [
    "/tmp/packscout-clutchpacks-worker-e2e-",
    "/tmp/packscout-clutchpacks-worker-e2e-safe/../other",
    "/private/tmp/packscout-clutchpacks-worker-e2e-safe",
    "/tmp/unrelated-safe",
    "/Users/example/packscout-clutchpacks-worker-e2e-safe",
  ]) assert.equal(isOwnedTemporaryClusterPath(candidate), false, candidate);
});

test("database URLs are socket-only and retain canonical guarded names", () => {
  const provider = new URL(postgresUrl(
    "/tmp/packscout-clutchpacks-worker-e2e-safe",
    "packscout_clutchpacks",
  ));
  const central = new URL(postgresUrl(
    "/tmp/packscout-clutchpacks-worker-e2e-safe",
    "packscout",
  ));
  assert.equal(provider.pathname, "/packscout_clutchpacks");
  assert.equal(central.pathname, "/packscout");
  assert.equal(provider.searchParams.get("host"),
    "/tmp/packscout-clutchpacks-worker-e2e-safe");
  assert.equal(provider.searchParams.get("connection_limit"), "2");
});

test("protected dump boundary requires an external owner-only regular dump", () => {
  const valid = {
    dumpPath: "/tmp/protected.dump",
    resolvedPath: "/tmp/protected.dump",
    repositoryPath: "/workspace/packscout",
    isFile: true,
    isSymbolicLink: false,
    mode: 0o100600,
    size: 42,
    uid: 501,
    processUid: 501,
  };
  assert.doesNotThrow(() => assertProtectedDumpMetadata(valid));
  for (const change of [
    { resolvedPath: "/workspace/packscout/protected.dump" },
    { mode: 0o100640 },
    { isSymbolicLink: true },
    { isFile: false },
    { size: 0 },
    { uid: 502 },
    { resolvedPath: "/tmp/protected.sql" },
  ]) {
    assert.throws(
      () => assertProtectedDumpMetadata({ ...valid, ...change }),
      refusal("PROTECTED_CLUTCHPACKS_DUMP_INVALID"),
    );
  }
});

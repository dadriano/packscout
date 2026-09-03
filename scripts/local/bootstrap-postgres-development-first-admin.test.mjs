import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";

const {
  LOCAL_DEVELOPMENT_ORGANIZATION,
  LOCAL_DEVELOPMENT_PROVIDER_ROOTS,
  LocalFirstAdminBootstrapError,
  assertConnectedLocalDatabaseIdentity,
  assertNoBootstrapArguments,
  readBootstrapPassword,
  readLocalFirstAdminEnvironment,
  safeBootstrapFailure,
} = await tsImport(
  "./bootstrap-postgres-development-first-admin.mts",
  import.meta.url,
);

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const developmentSeed = readFileSync(
  path.join(scriptDirectory, "postgres-development-seed.sql"),
  "utf8",
);

const validEnvironment = Object.freeze({
  NODE_ENV: "development",
  PACKSCOUT_DATABASE_URL:
    "postgresql://packscout:local-only@127.0.0.1:5432/packscout_dev",
  PACKSCOUT_BOOTSTRAP_ADMIN_EMAIL: " First.Admin@Example.test ",
  PACKSCOUT_BOOTSTRAP_ADMIN_DISPLAY_NAME: "First Admin",
});

function hasCode(code) {
  return (error) =>
    error instanceof LocalFirstAdminBootstrapError && error.code === code;
}

test("bootstrap proof is pinned to the exact organization and six normal seed roots", () => {
  assert.ok(
    developmentSeed.includes(`'${LOCAL_DEVELOPMENT_ORGANIZATION.id}'::uuid`),
  );
  assert.equal(LOCAL_DEVELOPMENT_PROVIDER_ROOTS.length, 6);
  for (const provider of LOCAL_DEVELOPMENT_PROVIDER_ROOTS) {
    const row = `('${provider.id}', '${provider.platformKey}', '${provider.displayName}', '${provider.state}')`;
    assert.equal(developmentSeed.split(row).length - 1, 1);
  }
});

test("local first-admin admission requires an exact development loopback target", () => {
  assert.deepEqual(readLocalFirstAdminEnvironment(validEnvironment), {
    databaseUrl: validEnvironment.PACKSCOUT_DATABASE_URL,
    databaseName: "packscout_dev",
    email: "first.admin@example.test",
    displayName: "First Admin",
  });

  const refusals = [
    [{ ...validEnvironment, NODE_ENV: undefined }, "LOCAL_DEVELOPMENT_ENVIRONMENT_REQUIRED"],
    [{ ...validEnvironment, NODE_ENV: "production" }, "LOCAL_DEVELOPMENT_ENVIRONMENT_REQUIRED"],
    [{ ...validEnvironment, NODE_ENV: "test" }, "LOCAL_DEVELOPMENT_ENVIRONMENT_REQUIRED"],
    [
      {
        ...validEnvironment,
        PACKSCOUT_DATABASE_URL:
          "postgresql://packscout@db.example.test:5432/packscout_dev",
      },
      "DATABASE_TARGET_NOT_LOCAL",
    ],
    [
      {
        ...validEnvironment,
        PACKSCOUT_DATABASE_URL:
          "postgresql://packscout@127.0.0.1:5432/packscout_dev?schema=public",
      },
      "DATABASE_TARGET_AMBIGUOUS",
    ],
    [
      {
        ...validEnvironment,
        PACKSCOUT_DATABASE_URL:
          "postgresql://packscout@127.0.0.1:5432/postgres",
      },
      "DATABASE_TARGET_AMBIGUOUS",
    ],
    [
      {
        ...validEnvironment,
        PACKSCOUT_BOOTSTRAP_ADMIN_PASSWORD: "must-not-be-read-from-env",
      },
      "ADMIN_PASSWORD_ENVIRONMENT_FORBIDDEN",
    ],
    [
      { ...validEnvironment, PACKSCOUT_BOOTSTRAP_ADMIN_EMAIL: "not-an-email" },
      "ADMIN_IDENTITY_INVALID",
    ],
  ];
  for (const [environment, code] of refusals) {
    assert.throws(() => readLocalFirstAdminEnvironment(environment), hasCode(code));
  }
});

test("connected database identity independently proves the actual server is loopback", () => {
  for (const serverAddress of [
    "127.0.0.1",
    "127.0.0.1/32",
    "::1",
    "::1/128",
    "0:0:0:0:0:0:0:1/128",
  ]) {
    assert.doesNotThrow(() =>
      assertConnectedLocalDatabaseIdentity(
        { databaseName: "packscout_dev", serverAddress },
        "packscout_dev",
      ),
    );
  }
  for (const identity of [
    undefined,
    { databaseName: "other", serverAddress: "127.0.0.1" },
    { databaseName: "packscout_dev", serverAddress: null },
    { databaseName: "packscout_dev", serverAddress: "10.0.0.8" },
    { databaseName: "packscout_dev", serverAddress: "127.0.0.1/24" },
    { databaseName: "packscout_dev", serverAddress: "::1/64" },
  ]) {
    assert.throws(
      () => assertConnectedLocalDatabaseIdentity(identity, "packscout_dev"),
      hasCode("CONNECTED_DATABASE_IDENTITY_NOT_LOCAL"),
    );
  }
});

test("bootstrap accepts no command arguments and reads one bounded password line from stdin", async () => {
  assert.doesNotThrow(() => assertNoBootstrapArguments([]));
  assert.throws(
    () => assertNoBootstrapArguments(["--password", "not-a-real-secret"]),
    hasCode("ARGUMENTS_FORBIDDEN"),
  );

  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  assert.equal(
    await readBootstrapPassword(
      Readable.from(["a-test-password-with-16-chars\n"]),
      output,
    ),
    "a-test-password-with-16-chars",
  );
  await assert.rejects(
    readBootstrapPassword(Readable.from(["first\nsecond\n"]), output),
    hasCode("ADMIN_PASSWORD_INPUT_MULTIPLE_LINES"),
  );
  await assert.rejects(
    readBootstrapPassword(Readable.from(["x".repeat(1_025)]), output),
    hasCode("ADMIN_PASSWORD_INPUT_TOO_LARGE"),
  );
});

test("CLI refuses argv credentials before database work and never echoes them", () => {
  const script = fileURLToPath(
    new URL("./bootstrap-postgres-development-first-admin.mts", import.meta.url),
  );
  const repositoryRoot = path.resolve(path.dirname(script), "..", "..");
  const dummy = "not-a-real-secret-value";
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", script, `--password=${dummy}`],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, NODE_ENV: "development" },
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /"code":"ARGUMENTS_FORBIDDEN"/u);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(dummy, "u"));
});

test("safe failures collapse unknown exception text instead of logging secrets", () => {
  const result = safeBootstrapFailure(
    new Error("database failed while handling not-a-real-secret-value"),
  );
  assert.deepEqual(result, {
    ok: false,
    operation: "bootstrap_first_admin",
    code: "UNEXPECTED_BOOTSTRAP_FAILURE",
  });
  assert.doesNotMatch(JSON.stringify(result), /not-a-real-secret-value/u);
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildReadOnlyConvexCommandEnvironment,
  canonicalJson,
  CONVEX_APP_TABLES,
  createConvexReadCommandAdapter,
  FORBIDDEN_FRESH_TARGET_ENVIRONMENT_NAMES,
  FreshConvexPreflightError,
  parseFreshConvexPreflightArguments,
  requireExplicitPreproductionDeployment,
  runFreshConvexTargetPreflight,
} from "./verify-fresh-convex-target.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(directory, "verify-fresh-convex-target.mjs");
const schemaPath = path.resolve(directory, "../../convex/schema.ts");
const DEPLOYMENT = "packscout-team:packscout-app:preproduction";

function assertCode(error, code) {
  assert.ok(error instanceof FreshConvexPreflightError);
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  return true;
}

function validCommands(overrides = {}) {
  const calls = [];
  const commands = {
    async listEnvironmentNames(target) {
      calls.push(["listEnvironmentNames", target]);
      return "PACKSCOUT_RUNTIME_ENVIRONMENT\nPACKSCOUT_CLOSED_BETA\n";
    },
    async readRuntimeEnvironment(target) {
      calls.push(["readRuntimeEnvironment", target]);
      return "preproduction\n";
    },
    async inspectAppTables(target) {
      calls.push(["inspectAppTables", target]);
      return JSON.stringify({
        checkedTableCount: CONVEX_APP_TABLES.length,
        nonemptyTables: [],
      });
    },
    async readPublicShell(target) {
      calls.push(["readPublicShell", target]);
      return JSON.stringify({
        ok: false,
        code: "RELEASE_UNAVAILABLE",
        error: "Repack data is temporarily unavailable.",
        retryable: true,
      });
    },
    ...overrides,
  };
  return { calls, commands };
}

test("the preflight table allowlist exactly matches every Convex app table", () => {
  const source = readFileSync(schemaPath, "utf8");
  const schemaTables = [...source.matchAll(
    /^  ([A-Za-z][A-Za-z0-9_]*): defineTable/gmu,
  )].map((match) => match[1]).sort();
  assert.deepEqual(CONVEX_APP_TABLES, schemaTables);
  assert.equal(CONVEX_APP_TABLES.length, 36);
});

test("only an explicit preproduction reference or deployment name is accepted", () => {
  for (const value of [
    "preproduction",
    DEPLOYMENT,
    "joyful-capybara-123",
    "packscout-app:joyful-capybara-123",
  ]) {
    assert.equal(requireExplicitPreproductionDeployment(value), value);
  }
  assert.deepEqual(
    parseFreshConvexPreflightArguments(["--deployment", DEPLOYMENT]),
    { deployment: DEPLOYMENT },
  );

  for (const value of [
    "", "dev", "prod", "default", "local", "production", "live",
    "packscout:prod", "dev/james", "staging", "https://example.test",
    " preproduction", "preproduction ", "preproduction;whoami",
  ]) {
    assert.throws(
      () => requireExplicitPreproductionDeployment(value),
      (error) => assertCode(error, "FRESH_CONVEX_TARGET_INVALID"),
    );
  }
  for (const argv of [
    [], ["--prod"], ["--deployment"],
    ["--deployment", DEPLOYMENT, "--execute"],
  ]) {
    assert.throws(
      () => parseFreshConvexPreflightArguments(argv),
      (error) => assertCode(error, "FRESH_CONVEX_ARGUMENT_INVALID"),
    );
  }
});

test("Convex child commands cannot inherit selectors, deploy keys, or secrets", () => {
  const child = buildReadOnlyConvexCommandEnvironment({
    PATH: "/safe/bin",
    HOME: "/safe/home",
    HTTPS_PROXY: "http://proxy.example.test",
    CONVEX_DEPLOYMENT: "prod",
    CONVEX_DEPLOY_KEY: "deployment-secret",
    PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS: "publication-secret",
    NODE_OPTIONS: "--import=/private/hook.mjs",
  });
  assert.deepEqual(child, {
    PATH: "/safe/bin",
    HOME: "/safe/home",
    HTTPS_PROXY: "http://proxy.example.test",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
  });
});

test("the command adapter constructs only four explicit read operations", async () => {
  const calls = [];
  const adapter = createConvexReadCommandAdapter({
    async runCli(args) {
      calls.push(args);
      return "{}";
    },
  });
  await adapter.listEnvironmentNames(DEPLOYMENT);
  await adapter.readRuntimeEnvironment(DEPLOYMENT);
  await adapter.inspectAppTables(DEPLOYMENT);
  await adapter.readPublicShell(DEPLOYMENT);

  assert.equal(calls.length, 4);
  for (const args of calls) {
    assert.deepEqual(
      args.slice(args.indexOf("--deployment"), args.indexOf("--deployment") + 2),
      ["--deployment", DEPLOYMENT],
    );
    assert.equal(args.includes("--prod"), false);
    assert.equal(args.includes("--push"), false);
    assert.equal(args.includes("set"), false);
    assert.equal(args.includes("remove"), false);
    assert.equal(args.includes("deploy"), false);
    assert.equal(args.includes("import"), false);
  }
  assert.deepEqual(calls[0].slice(0, 2), ["env", "--deployment"]);
  assert.equal(calls[0].includes("--names-only"), true);
  assert.equal(calls[2].includes("--inline-query"), true);
  for (const table of CONVEX_APP_TABLES) {
    assert.equal(calls[2].join("\n").includes(table), true, table);
  }
  assert.equal(calls[3].includes("publicRepacks:getPublicShellStatus"), true);
});

test("a fresh target emits only canonical digest-scoped evidence", async () => {
  const fake = validCommands();
  const result = await runFreshConvexTargetPreflight(
    { deployment: DEPLOYMENT },
    { commands: fake.commands },
  );
  assert.deepEqual(fake.calls, [
    ["listEnvironmentNames", DEPLOYMENT],
    ["readRuntimeEnvironment", DEPLOYMENT],
    ["inspectAppTables", DEPLOYMENT],
    ["readPublicShell", DEPLOYMENT],
  ]);
  assert.match(result.proofDigest, /^[0-9a-f]{64}$/u);
  assert.match(result.proof.scopeDigest, /^[0-9a-f]{64}$/u);
  assert.equal(result.proof.database.appTableCount, 36);
  assert.equal(result.proof.database.nonemptyAppTableCount, 0);
  assert.equal(result.proof.environment.runtimeEnvironment, "preproduction");
  assert.equal(result.proof.environment.forbiddenVariableCount, 0);
  assert.deepEqual(result.proof.publicShell, {
    code: "RELEASE_UNAVAILABLE",
    retryable: true,
  });
  const output = canonicalJson(result);
  assert.equal(output.includes(DEPLOYMENT), false);
  assert.equal(output.includes("PACKSCOUT_CLOSED_BETA"), false);
  assert.equal(output.includes("secret"), false);
});

test("runtime and forbidden deployment configuration fail closed", async (t) => {
  await t.test("runtime must be preproduction", async () => {
    const fake = validCommands({
      async readRuntimeEnvironment() {
        return "production\n";
      },
    });
    await assert.rejects(
      runFreshConvexTargetPreflight(
        { deployment: DEPLOYMENT },
        { commands: fake.commands },
      ),
      (error) => assertCode(error, "FRESH_CONVEX_ENVIRONMENT_INVALID"),
    );
  });

  for (const forbiddenName of FORBIDDEN_FRESH_TARGET_ENVIRONMENT_NAMES) {
    await t.test(`rejects ${forbiddenName}`, async () => {
      const fake = validCommands({
        async listEnvironmentNames() {
          return `PACKSCOUT_RUNTIME_ENVIRONMENT\n${forbiddenName}\n`;
        },
      });
      await assert.rejects(
        runFreshConvexTargetPreflight(
          { deployment: DEPLOYMENT },
          { commands: fake.commands },
        ),
        (error) => assertCode(error, "FRESH_CONVEX_ENVIRONMENT_INVALID"),
      );
    });
  }
});

test("missing schema, nonempty state, and a public release all fail closed", async (t) => {
  await t.test("requires the exact schema table count", async () => {
    const fake = validCommands({
      async inspectAppTables() {
        return JSON.stringify({ checkedTableCount: 35, nonemptyTables: [] });
      },
    });
    await assert.rejects(
      runFreshConvexTargetPreflight(
        { deployment: DEPLOYMENT },
        { commands: fake.commands },
      ),
      (error) => assertCode(error, "FRESH_CONVEX_SCHEMA_INVALID"),
    );
  });

  await t.test("rejects any nonempty app table without exposing its row", async () => {
    const fake = validCommands({
      async inspectAppTables() {
        return JSON.stringify({
          checkedTableCount: CONVEX_APP_TABLES.length,
          nonemptyTables: ["providerCatalogReleases"],
        });
      },
    });
    await assert.rejects(
      runFreshConvexTargetPreflight(
        { deployment: DEPLOYMENT },
        { commands: fake.commands },
      ),
      (error) => assertCode(error, "FRESH_CONVEX_STATE_NOT_EMPTY"),
    );
  });

  await t.test("rejects an active public shell", async () => {
    const fake = validCommands({
      async readPublicShell() {
        return JSON.stringify({ ok: true, data: { protected: "row-secret" } });
      },
    });
    await assert.rejects(
      runFreshConvexTargetPreflight(
        { deployment: DEPLOYMENT },
        { commands: fake.commands },
      ),
      (error) => assertCode(error, "FRESH_CONVEX_PUBLIC_STATE_INVALID"),
    );
  });
});

test("command failures and CLI failures expose only stable codes", async () => {
  const fake = validCommands({
    async inspectAppTables() {
      throw new Error("deployment-secret provider-row-secret");
    },
  });
  await assert.rejects(
    runFreshConvexTargetPreflight(
      { deployment: DEPLOYMENT },
      { commands: fake.commands },
    ),
    (error) => {
      assertCode(error, "FRESH_CONVEX_COMMAND_FAILED");
      assert.equal(error.message.includes("secret"), false);
      return true;
    },
  );

  const result = spawnSync(process.execPath, [scriptPath, "--prod"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "FRESH_CONVEX_ARGUMENT_INVALID\n");
});

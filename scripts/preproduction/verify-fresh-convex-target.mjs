#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export const FRESH_CONVEX_PREFLIGHT_SCHEMA_VERSION =
  "packscout.fresh-convex-target-preflight.v1";

export const CONVEX_APP_TABLES = Object.freeze([
  "activeCatalogManifestState",
  "activeDataReleaseV3State",
  "betaAllowlistEntries",
  "catalogManifestBlocks",
  "catalogManifestOperations",
  "catalogManifestProviderReferences",
  "catalogRetentionOperations",
  "catalogRetentionState",
  "dataReleaseAuthNonces",
  "dataReleaseV3Categories",
  "dataReleaseV3Chases",
  "dataReleaseV3Collectibles",
  "dataReleaseV3Operations",
  "dataReleaseV3ProviderObservations",
  "dataReleaseV3Releases",
  "dataReleaseV3Repacks",
  "dataReleaseV3SearchShards",
  "globalCatalogManifests",
  "productUsers",
  "providerCatalogBatches",
  "providerCatalogCategories",
  "providerCatalogCollectibleReconciliation",
  "providerCatalogCollectibles",
  "providerCatalogCompletedHeads",
  "providerCatalogOperations",
  "providerCatalogPublications",
  "providerCatalogReleaseBlocks",
  "providerCatalogReleaseCompletionProofs",
  "providerCatalogReleases",
  "providerCatalogRepackChases",
  "providerCatalogRepackReconciliation",
  "providerCatalogRepacks",
  "providerCatalogSearchShardProofs",
  "providerCatalogSearchShards",
  "providerCatalogTerminalReceiptProofs",
  "providerCatalogVendors",
  "repackHeatBatches",
  "repackHeatOperations",
  "repackHeatPublications",
  "repackHeatSignalSets",
  "repackHeatSignals",
  "repackHeatSnapshots",
  "repackHeatState",
  "savedCollectibles",
  "savedRepacks",
]);

export const FORBIDDEN_FRESH_TARGET_ENVIRONMENT_NAMES = Object.freeze([
  "PACKSCOUT_CATALOG_MANIFEST_KEY_ROLES",
  "PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS",
  "PACKSCOUT_HEAT_PUBLICATION_KEY_IDS",
  "PACKSCOUT_MOCK_DATA_RELEASE_SEED_ENABLED",
  "PACKSCOUT_MOCK_HEAT_SIMULATION_ENABLED",
  "PACKSCOUT_PROVIDER_RELEASE_KEY_PLATFORMS",
  "PACKSCOUT_PUBLIC_ORIGIN_SET_HASH",
]);

const ERROR_CODES = new Set([
  "FRESH_CONVEX_ARGUMENT_INVALID",
  "FRESH_CONVEX_COMMAND_FAILED",
  "FRESH_CONVEX_ENVIRONMENT_INVALID",
  "FRESH_CONVEX_OUTPUT_INVALID",
  "FRESH_CONVEX_PUBLIC_STATE_INVALID",
  "FRESH_CONVEX_SCHEMA_INVALID",
  "FRESH_CONVEX_STATE_NOT_EMPTY",
  "FRESH_CONVEX_TARGET_INVALID",
  "FRESH_CONVEX_INTERNAL_FAILURE",
]);
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SELECTOR_SEGMENT = "[a-z0-9][a-z0-9-]{0,62}";
const DEPLOYMENT_NAME = "[a-z0-9]+-[a-z0-9]+-[0-9]+";
const EXPLICIT_PREPRODUCTION_SELECTOR_PATTERN = new RegExp(
  `^(?:(?:${SELECTOR_SEGMENT}):){0,2}(?:preproduction|${DEPLOYMENT_NAME})$`,
  "u",
);
const PRODUCTION_TOKEN_PATTERN =
  /(?:^|[./:_-])(?:default|dev|local|prod|production|live)(?=$|[./:_-])/iu;
const MAXIMUM_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MILLISECONDS = 60_000;

export class FreshConvexPreflightError extends Error {
  constructor(code) {
    const safeCode = ERROR_CODES.has(code)
      ? code
      : "FRESH_CONVEX_INTERNAL_FAILURE";
    super(safeCode);
    this.name = "FreshConvexPreflightError";
    this.code = safeCode;
  }
}

function refuse(code) {
  throw new FreshConvexPreflightError(code);
}

function sha256(domain, value) {
  return createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(value, "utf8")
    .digest("hex");
}

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  refuse("FRESH_CONVEX_OUTPUT_INVALID");
}

export function requireExplicitPreproductionDeployment(value) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !EXPLICIT_PREPRODUCTION_SELECTOR_PATTERN.test(value) ||
    PRODUCTION_TOKEN_PATTERN.test(value)
  ) {
    refuse("FRESH_CONVEX_TARGET_INVALID");
  }
  return value;
}

export function parseFreshConvexPreflightArguments(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || argv[0] !== "--deployment") {
    refuse("FRESH_CONVEX_ARGUMENT_INVALID");
  }
  return Object.freeze({
    deployment: requireExplicitPreproductionDeployment(argv[1]),
  });
}

export function buildReadOnlyConvexCommandEnvironment(
  environment = process.env,
) {
  const allowed = new Set([
    "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "SHELL",
    "LANG", "LC_ALL", "TERM", "CI", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "NPM_CONFIG_CACHE",
    "npm_config_cache",
  ]);
  const child = {};
  for (const [name, value] of Object.entries(environment)) {
    if ((allowed.has(name) || name.startsWith("LC_")) && value !== undefined) {
      child[name] = value;
    }
  }
  child.FORCE_COLOR = "0";
  child.NO_COLOR = "1";
  return Object.freeze(child);
}

function createConvexCliRunner({
  cwd = repositoryRoot,
  environment = process.env,
} = {}) {
  return (args) => new Promise((resolve, reject) => {
    execFile(
      "npx",
      ["--no-install", "convex", ...args],
      {
        cwd,
        encoding: "utf8",
        env: buildReadOnlyConvexCommandEnvironment(environment),
        maxBuffer: MAXIMUM_COMMAND_OUTPUT_BYTES,
        timeout: COMMAND_TIMEOUT_MILLISECONDS,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) reject(new FreshConvexPreflightError("FRESH_CONVEX_COMMAND_FAILED"));
        else resolve(stdout);
      },
    );
  });
}

const EMPTY_TABLE_QUERY = `const tables=${JSON.stringify(CONVEX_APP_TABLES)};
const nonemptyTables=[];
for (const table of tables) {
  if (await ctx.db.query(table).first() !== null) nonemptyTables.push(table);
}
return {checkedTableCount:tables.length,nonemptyTables};`;

export function createConvexReadCommandAdapter({ runCli } = {}) {
  const run = runCli ?? createConvexCliRunner();
  return Object.freeze({
    listEnvironmentNames(deployment) {
      return run(["env", "--deployment", deployment, "list", "--names-only"]);
    },
    readRuntimeEnvironment(deployment) {
      return run([
        "env", "--deployment", deployment, "get",
        "PACKSCOUT_RUNTIME_ENVIRONMENT",
      ]);
    },
    inspectAppTables(deployment) {
      return run([
        "run", "--deployment", deployment, "--inline-query", EMPTY_TABLE_QUERY,
      ]);
    },
    readPublicShell(deployment) {
      return run([
        "run", "--deployment", deployment,
        "publicRepacks:getPublicShellStatus", "{}",
      ]);
    },
  });
}

function parseEnvironmentNames(output) {
  const names = output.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
  if (
    names.some((name) => !ENVIRONMENT_NAME_PATTERN.test(name)) ||
    new Set(names).size !== names.length
  ) {
    refuse("FRESH_CONVEX_ENVIRONMENT_INVALID");
  }
  return names;
}

function parseJsonObject(output, errorCode) {
  let value;
  try {
    value = JSON.parse(output);
  } catch {
    refuse(errorCode);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    refuse(errorCode);
  }
  return value;
}

export async function runFreshConvexTargetPreflight(
  { deployment },
  { commands = createConvexReadCommandAdapter() } = {},
) {
  const target = requireExplicitPreproductionDeployment(deployment);
  let namesOutput;
  let runtimeOutput;
  try {
    namesOutput = await commands.listEnvironmentNames(target);
    runtimeOutput = await commands.readRuntimeEnvironment(target);
  } catch {
    refuse("FRESH_CONVEX_COMMAND_FAILED");
  }
  const environmentNames = parseEnvironmentNames(namesOutput);
  if (
    runtimeOutput.trim() !== "preproduction" ||
    !environmentNames.includes("PACKSCOUT_RUNTIME_ENVIRONMENT") ||
    FORBIDDEN_FRESH_TARGET_ENVIRONMENT_NAMES.some((name) =>
      environmentNames.includes(name)
    )
  ) {
    refuse("FRESH_CONVEX_ENVIRONMENT_INVALID");
  }

  let tableOutput;
  let publicShellOutput;
  try {
    tableOutput = await commands.inspectAppTables(target);
    publicShellOutput = await commands.readPublicShell(target);
  } catch {
    refuse("FRESH_CONVEX_COMMAND_FAILED");
  }
  const tables = parseJsonObject(tableOutput, "FRESH_CONVEX_SCHEMA_INVALID");
  if (
    tables.checkedTableCount !== CONVEX_APP_TABLES.length ||
    !Array.isArray(tables.nonemptyTables) ||
    tables.nonemptyTables.some((name) => !CONVEX_APP_TABLES.includes(name))
  ) {
    refuse("FRESH_CONVEX_SCHEMA_INVALID");
  }
  if (tables.nonemptyTables.length !== 0) {
    refuse("FRESH_CONVEX_STATE_NOT_EMPTY");
  }
  const shell = parseJsonObject(
    publicShellOutput,
    "FRESH_CONVEX_PUBLIC_STATE_INVALID",
  );
  if (
    shell.ok !== false || shell.code !== "RELEASE_UNAVAILABLE" ||
    shell.retryable !== true ||
    shell.error !== "Repack data is temporarily unavailable."
  ) {
    refuse("FRESH_CONVEX_PUBLIC_STATE_INVALID");
  }

  const proof = Object.freeze({
    database: Object.freeze({
      appTableCount: CONVEX_APP_TABLES.length,
      nonemptyAppTableCount: 0,
      tableSetHash: sha256(
        "packscout.fresh-convex-target.table-set.v1",
        canonicalJson(CONVEX_APP_TABLES),
      ),
    }),
    environment: Object.freeze({
      configuredVariableCount: environmentNames.length,
      forbiddenVariableCount: 0,
      runtimeEnvironment: "preproduction",
    }),
    evidenceLevel: "preproduction",
    publicShell: Object.freeze({
      code: "RELEASE_UNAVAILABLE",
      retryable: true,
    }),
    readOnly: true,
    schemaVersion: FRESH_CONVEX_PREFLIGHT_SCHEMA_VERSION,
    scopeDigest: sha256("packscout.fresh-convex-target.scope.v1", target),
    status: "passed",
  });
  return Object.freeze({
    proof,
    proofDigest: sha256(
      "packscout.fresh-convex-target.proof.v1",
      canonicalJson(proof),
    ),
  });
}

function helpText() {
  return `Usage: npm run cutover:preflight:fresh-convex:preproduction -- --deployment <explicit-selector-or-name>

Runs read-only Convex CLI inspection against one explicit preproduction target.
Reserved dev, prod, default, local, production, and live selectors are refused.`;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && new Set(["--help", "-h"]).has(argv[0])) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  const result = await runFreshConvexTargetPreflight(
    parseFreshConvexPreflightArguments(argv),
  );
  process.stdout.write(`${canonicalJson(result)}\n`);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    const failure = error instanceof FreshConvexPreflightError
      ? error
      : new FreshConvexPreflightError("FRESH_CONVEX_INTERNAL_FAILURE");
    process.stderr.write(`${failure.code}\n`);
    process.exitCode = 1;
  });
}

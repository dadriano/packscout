#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Local buyback-adjusted EV backfill reconciliation and readiness ledger
 * generator (task buyback-adjusted-ev/012). Run with:
 *
 *   node --import tsx scripts/local/backfill-buyback-ev.mjs \
 *     --organization <uuid> --read-at <iso-utc>
 *
 * The run enumerates every canonical repack at the requested settled read
 * clock, classifies each one from the real recomputation boundary (optionally
 * recomputing through a supplied evidence module), reconciles the ledger
 * against a staged — never activated — data_release_v3 publish plan built by
 * the real assembler against an in-memory protocol double, composes the
 * strict readiness ledger, and writes it as a generated JSON artifact
 * (default `docs/evidence/buyback-adjusted-ev-readiness-ledger.json`, a
 * gitignored path).
 *
 * Local safety is enforced inside the script: the PostgreSQL host must be a
 * loopback address, nothing is published to any external system, and the
 * public release pointer is never touched. A blocked ledger exits nonzero;
 * blocked cannot waive a criterion.
 */

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export const DEFAULT_LEDGER_ARTIFACT_PATH =
  "docs/evidence/buyback-adjusted-ev-readiness-ledger.json";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/u;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "[::1]"]);

export function parseBackfillArguments(args) {
  const values = {
    organizationId: null,
    readAt: null,
    outPath: DEFAULT_LEDGER_ARTIFACT_PATH,
    applicationCommit: null,
    databaseUrl: null,
    evidenceModule: null,
    verificationJsonPath: null,
    alertsJsonPath: null,
    drillJsonPath: null,
    gatedAt: null,
    reopenedAt: null,
  };
  const setters = {
    "--organization": (value) => {
      values.organizationId = value;
    },
    "--read-at": (value) => {
      values.readAt = value;
    },
    "--out": (value) => {
      values.outPath = value;
    },
    "--application-commit": (value) => {
      values.applicationCommit = value;
    },
    "--database-url": (value) => {
      values.databaseUrl = value;
    },
    "--evidence-module": (value) => {
      values.evidenceModule = value;
    },
    "--verification-json": (value) => {
      values.verificationJsonPath = value;
    },
    "--alerts-json": (value) => {
      values.alertsJsonPath = value;
    },
    "--drill-json": (value) => {
      values.drillJsonPath = value;
    },
    "--gated-at": (value) => {
      values.gatedAt = value;
    },
    "--reopened-at": (value) => {
      values.reopenedAt = value;
    },
  };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const setter = setters[flag];
    if (setter === undefined) {
      throw new Error(`Unknown backfill option: ${flag}`);
    }
    if (seen.has(flag)) throw new Error(`${flag} may be provided only once.`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} requires a value.`);
    }
    seen.add(flag);
    setter(value);
    index += 1;
  }
  if (values.organizationId === null || !UUID_PATTERN.test(values.organizationId)) {
    throw new Error("--organization must be a canonical lowercase UUID.");
  }
  if (
    values.readAt === null ||
    !Number.isFinite(Date.parse(values.readAt)) ||
    new Date(values.readAt).toISOString() !== values.readAt
  ) {
    throw new Error("--read-at must be a canonical UTC millisecond timestamp.");
  }
  if (
    values.applicationCommit !== null &&
    !COMMIT_PATTERN.test(values.applicationCommit)
  ) {
    throw new Error("--application-commit must be a git commit sha.");
  }
  if ((values.gatedAt === null) !== (values.reopenedAt === null)) {
    throw new Error("--gated-at and --reopened-at must be provided together.");
  }
  return Object.freeze(values);
}

/**
 * The backfill writes canonical revisions, so it may only ever run against a
 * loopback PostgreSQL. The check is enforced here, never trusted to callers.
 */
export function assertLoopbackDatabaseUrl(databaseUrl) {
  if (typeof databaseUrl !== "string" || databaseUrl.trim() === "") {
    throw new Error(
      "A database URL is required (set PACKSCOUT_DATABASE_URL or pass --database-url).",
    );
  }
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("The database URL is not a valid URL.");
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error("The database URL must be a PostgreSQL URL.");
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(
      "Refusing a non-loopback database host; the local backfill only runs against 127.0.0.1, ::1, or localhost.",
    );
  }
  return databaseUrl;
}

export function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Deterministic JSON for fingerprinting values that may carry BigInt. */
export function stableJson(value) {
  return JSON.stringify(value, (key, entry) =>
    typeof entry === "bigint" ? entry.toString() : entry,
  );
}

async function readJsonArray(filePath, label) {
  if (filePath === null) return [];
  const raw = await readFile(path.resolve(repositoryRoot, filePath), "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} must contain a JSON array.`);
  }
  return parsed;
}

async function readJsonObject(filePath) {
  if (filePath === null) return null;
  const raw = await readFile(path.resolve(repositoryRoot, filePath), "utf8");
  const parsed = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--drill-json must contain a JSON object.");
  }
  return parsed;
}

async function loadModules() {
  const database = await import("../../packages/database/src/index.ts");
  const databaseLifecycle = await import(
    "../../packages/database/src/database.ts"
  );
  const services = await import("../../packages/services/src/index.ts");
  const releaseTestSupport = await import(
    "../../packages/services/src/buyback-adjusted-ev-release.test-support.ts"
  );
  return { database, databaseLifecycle, services, releaseTestSupport };
}

export async function runLocalBuybackEvBackfill(options, dependencies = {}) {
  const log = dependencies.log ?? console.log;
  const modules = await (dependencies.loadModules ?? loadModules)();
  const databaseUrl = assertLoopbackDatabaseUrl(
    options.databaseUrl ?? process.env.PACKSCOUT_DATABASE_URL,
  );
  const applicationCommit =
    options.applicationCommit ??
    (dependencies.resolveCommit
      ? await dependencies.resolveCommit()
      : null);
  if (applicationCommit === null || !COMMIT_PATTERN.test(applicationCommit)) {
    throw new Error(
      "An application commit is required (pass --application-commit).",
    );
  }
  const lifecycle = modules.databaseLifecycle.createPrismaClientLifecycle({
    databaseUrl,
  });
  await lifecycle.start();
  try {
    const source = new modules.database.PrismaDataReleaseV3CanonicalCatalogSource(
      lifecycle.client,
      options.organizationId,
    );
    const catalog = new modules.services.DataReleaseV3CanonicalCatalogAdapter(
      source,
    );
    const store = new modules.services.PackScoutBuybackEvRevisionStore(
      new modules.database.BuybackEvRevisionRepository(lifecycle.client),
    );
    const service =
      new modules.services.PackScoutBuybackAdjustedEvRecomputationService(store);
    const assembler = new modules.services.DataReleaseV3ReleaseAssembler(
      catalog,
      service,
    );
    const stagingPort =
      dependencies.stagingPort ??
      new modules.releaseTestSupport.InMemoryDataReleaseV3Port();
    const evidence =
      options.evidenceModule === null
        ? undefined
        : (await import(
            pathToFileURL(path.resolve(repositoryRoot, options.evidenceModule))
              .href
          )).default;
    const runner =
      new modules.services.PackScoutBuybackEvBackfillReconciliationRunnerV1({
        catalog,
        recomputation: service,
        assembler,
        evidence,
        publication: stagingPort,
      });
    const backfill = await runner.run({ readAt: options.readAt });

    const rawSnapshot = await source.loadSourceSnapshot({
      readAt: options.readAt,
    });
    const configurationFingerprintSha256 = sha256Hex(
      stableJson(rawSnapshot.configuration ?? null),
    );
    const drill = await readJsonObject(options.drillJsonPath);
    const evidenceRecord = {
      generatedAt: new Date().toISOString(),
      applicationCommit,
      configurationFingerprintSha256,
      candidate:
        backfill.ledger.staging === null
          ? null
          : {
              publicReleaseId: backfill.ledger.staging.publicReleaseId,
              releaseFingerprint: backfill.ledger.staging.releaseFingerprint,
              dataAsOf: options.readAt,
            },
      prior: null,
      backfill: backfill.ledger,
      maintenance:
        options.gatedAt === null
          ? null
          : { gatedAt: options.gatedAt, reopenedAt: options.reopenedAt },
      verificationCommands: await readJsonArray(
        options.verificationJsonPath,
        "--verification-json",
      ),
      alerts: await readJsonArray(options.alertsJsonPath, "--alerts-json"),
      promotion: {
        outcome: "not_executed",
        publicReleaseId: null,
        failedStep: null,
        steps: [],
      },
      rollbackDrill:
        drill ?? {
          executed: false,
          failedStep: null,
          steps: [],
          restoredActivePublicReleaseId: null,
        },
    };
    const ledger =
      modules.services.composePackScoutBuybackEvReadinessLedgerV1(
        evidenceRecord,
      );
    const artifactPath = path.resolve(repositoryRoot, options.outPath);
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(
      artifactPath,
      modules.services.serializePackScoutBuybackEvReadinessLedgerV1(ledger),
      "utf8",
    );
    log(
      `Backfill ${backfill.classification}: ${ledger.backfill.counts.total} repacks — ` +
        `${ledger.backfill.counts.recomputedAvailable} available, ` +
        `${ledger.backfill.counts.deterministicUnavailable} unavailable, ` +
        `${ledger.backfill.counts.soldOutHistorical} sold-out historical.`,
    );
    log(
      `Readiness ${ledger.readiness}; ledger digest ${ledger.ledgerDigest} ` +
        `written to ${path.relative(repositoryRoot, artifactPath)}.`,
    );
    for (const criterion of ledger.criteria) {
      log(`  [${criterion.status === "pass" ? "pass" : "BLOCKED"}] ${criterion.criterion}: ${criterion.evidence}`);
    }
    return ledger;
  } finally {
    await lifecycle.close();
  }
}

async function main() {
  const options = parseBackfillArguments(process.argv.slice(2));
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const ledger = await runLocalBuybackEvBackfill(options, {
    resolveCommit: async () => {
      const { stdout } = await promisify(execFile)(
        "git",
        ["rev-parse", "HEAD"],
        { cwd: repositoryRoot },
      );
      return stdout.trim();
    },
  });
  if (ledger.readiness !== "pass") {
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(
      error instanceof Error
        ? error.message
        : "Local buyback EV backfill failed.",
    );
    process.exitCode = 1;
  });
}

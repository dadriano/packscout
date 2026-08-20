#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Local buyback-adjusted EV launch-certification generator
 * (task buyback-adjusted-ev/013). Run with:
 *
 *   node --import tsx scripts/local/certify-buyback-ev-launch.mjs \
 *     [--readiness-ledger docs/evidence/buyback-adjusted-ev-readiness-ledger.json] \
 *     [--verification-json <path>] [--application-commit <sha>] [--out <path>]
 *
 * The run executes the shared certification harness against a throwaway
 * migrated PostgreSQL database (loopback only, created and dropped by the
 * database test-support factory): eight sanitized provider examples traced
 * source revision -> normalized evidence -> fingerprint -> canonical metrics
 * -> confidence -> staged public release -> query projection -> rendered
 * frontend presentation. It then verifies the product-experience manifest,
 * links the task-012 readiness ledger, and composes the strict certification
 * record with the deploy-stage browser checklist PENDING and every human
 * owner approval UNRECORDED.
 *
 * The record is written to the gitignored
 * `docs/evidence/buyback-adjusted-ev-launch-certification.json`. A blocked
 * certification exits nonzero; the expected pre-approval state is BLOCKED on
 * the browser checklist and the four human approvals, which only a human can
 * flip — this script never records an approval.
 */

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export const DEFAULT_CERTIFICATION_ARTIFACT_PATH =
  "docs/evidence/buyback-adjusted-ev-launch-certification.json";
export const DEFAULT_READINESS_LEDGER_PATH =
  "docs/evidence/buyback-adjusted-ev-readiness-ledger.json";

const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export function parseCertifyArguments(args) {
  const values = {
    outPath: DEFAULT_CERTIFICATION_ARTIFACT_PATH,
    readinessLedgerPath: DEFAULT_READINESS_LEDGER_PATH,
    verificationJsonPath: null,
    applicationCommit: null,
  };
  const setters = {
    "--out": (value) => {
      values.outPath = value;
    },
    "--readiness-ledger": (value) => {
      values.readinessLedgerPath = value;
    },
    "--verification-json": (value) => {
      values.verificationJsonPath = value;
    },
    "--application-commit": (value) => {
      values.applicationCommit = value;
    },
  };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const setter = setters[flag];
    if (setter === undefined) {
      throw new Error(`Unknown certification option: ${flag}`);
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
  if (
    values.applicationCommit !== null &&
    !COMMIT_PATTERN.test(values.applicationCommit)
  ) {
    throw new Error("--application-commit must be a git commit sha.");
  }
  return Object.freeze(values);
}

/**
 * Extracts the bounded task-012 ledger link from a generated readiness-ledger
 * artifact. Anything malformed fails closed instead of linking partial
 * operational evidence.
 */
export function ledgerLinkFromArtifact(artifact, artifactPath) {
  if (
    artifact === null ||
    typeof artifact !== "object" ||
    typeof artifact.ledgerDigest !== "string" ||
    !SHA256_PATTERN.test(artifact.ledgerDigest) ||
    (artifact.readiness !== "pass" && artifact.readiness !== "blocked") ||
    typeof artifact.generatedAt !== "string" ||
    typeof artifact.rollbackDrill !== "object" ||
    artifact.rollbackDrill === null
  ) {
    throw new Error(
      "The readiness-ledger artifact is not a composed task-012 ledger.",
    );
  }
  return {
    ledgerDigest: artifact.ledgerDigest,
    readiness: artifact.readiness,
    generatedAt: artifact.generatedAt,
    rollbackDrillExecuted: artifact.rollbackDrill.executed === true,
    artifactPath,
  };
}

/**
 * Verifies every product-experience manifest claim still points at an
 * existing evidence file that contains the named test.
 */
export async function verifyCertificationManifest(
  manifest,
  readEvidenceFile,
  verifiedAt,
) {
  const missing = [];
  let entriesVerified = 0;
  for (const entry of manifest) {
    let entryHolds = entry.evidence.length > 0;
    for (const { file, testName } of entry.evidence) {
      let content = null;
      try {
        content = await readEvidenceFile(file);
      } catch {
        content = null;
      }
      if (content === null || !content.includes(testName)) {
        missing.push(`${file} :: ${testName}`);
        entryHolds = false;
      }
    }
    if (entryHolds) entriesVerified += 1;
  }
  return { verifiedAt, entriesVerified, missing };
}

async function loadModules() {
  const services = await import("../../packages/services/src/index.ts");
  const certificationSupport = await import(
    "../../packages/services/src/buyback-adjusted-ev-launch-certification.test-support.ts"
  );
  const databaseTestSupport = await import(
    "../../packages/database/src/test-support.ts"
  );
  return { services, certificationSupport, databaseTestSupport };
}

export async function runLocalBuybackEvLaunchCertification(
  options,
  dependencies = {},
) {
  const log = dependencies.log ?? console.log;
  const modules = await (dependencies.loadModules ?? loadModules)();
  const applicationCommit =
    options.applicationCommit ??
    (dependencies.resolveCommit ? await dependencies.resolveCommit() : null);
  if (applicationCommit === null || !COMMIT_PATTERN.test(applicationCommit)) {
    throw new Error(
      "An application commit is required (pass --application-commit).",
    );
  }
  const readinessRaw = await readFile(
    path.resolve(repositoryRoot, options.readinessLedgerPath),
    "utf8",
  );
  const operationalLedger = ledgerLinkFromArtifact(
    JSON.parse(readinessRaw),
    options.readinessLedgerPath,
  );
  const verificationCommands =
    options.verificationJsonPath === null
      ? []
      : JSON.parse(
          await readFile(
            path.resolve(repositoryRoot, options.verificationJsonPath),
            "utf8",
          ),
        );
  if (!Array.isArray(verificationCommands)) {
    throw new Error("--verification-json must contain a JSON array.");
  }

  const harness =
    dependencies.harness ??
    (await modules.databaseTestSupport.createMigratedTestDatabase());
  let harnessResult;
  try {
    const presentation =
      dependencies.presentation ??
      (await modules.certificationSupport.loadPackScoutEvPresentationBoundary());
    harnessResult =
      await modules.certificationSupport.runBuybackEvLaunchCertificationHarness(
        harness,
        {
          organizationId: "9c000000-0000-4000-8000-00000000c137",
          slug: "buyback-ev-launch-certification-run",
          presentation,
        },
      );
  } finally {
    if (dependencies.harness === undefined) await harness.close();
  }

  const manifestVerification = await verifyCertificationManifest(
    modules.services.PACKSCOUT_BUYBACK_EV_CERTIFICATION_MANIFEST_V1,
    (file) => readFile(path.resolve(repositoryRoot, file), "utf8"),
    new Date().toISOString(),
  );

  const certification =
    modules.services.composePackScoutBuybackEvLaunchCertificationV1({
      generatedAt: new Date().toISOString(),
      candidateCommit: applicationCommit,
      operationalLedger,
      providerTraces: harnessResult.traces,
      vendorEvSeparationProven: harnessResult.vendorEvSeparationProven,
      pullsVerifiedInventoryOnly: harnessResult.pullsVerifiedInventoryOnly,
      publicBoundaryScan: harnessResult.publicBoundaryScan,
      manifestVerification,
      verificationCommands,
      candidateRelease: harnessResult.candidateRelease,
      browserEvidence:
        modules.services.PACKSCOUT_BUYBACK_EV_BROWSER_EVIDENCE_PENDING_V1,
      humanApprovals:
        modules.services.packScoutBuybackEvUnrecordedHumanApprovalsV1(),
    });
  const artifactPath = path.resolve(repositoryRoot, options.outPath);
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await writeFile(
    artifactPath,
    modules.services.serializePackScoutBuybackEvLaunchCertificationV1(
      certification,
    ),
    "utf8",
  );
  log(
    `Launch certification ${certification.certification}; digest ` +
      `${certification.certificationDigest} written to ` +
      `${path.relative(repositoryRoot, artifactPath)}.`,
  );
  for (const criterion of certification.criteria) {
    log(
      `  [${criterion.status === "pass" ? "pass" : "BLOCKED"}]` +
        `${criterion.kind === "human" ? " (human)" : ""} ` +
        `${criterion.criterion}: ${criterion.evidence}`,
    );
  }
  return certification;
}

async function main() {
  const options = parseCertifyArguments(process.argv.slice(2));
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const certification = await runLocalBuybackEvLaunchCertification(options, {
    resolveCommit: async () => {
      const { stdout } = await promisify(execFile)(
        "git",
        ["rev-parse", "HEAD"],
        { cwd: repositoryRoot },
      );
      return stdout.trim();
    },
  });
  if (certification.certification !== "pass") {
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
        : "Local buyback EV launch certification failed.",
    );
    process.exitCode = 1;
  });
}

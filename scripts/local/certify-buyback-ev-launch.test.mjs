import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_CERTIFICATION_ARTIFACT_PATH,
  DEFAULT_READINESS_LEDGER_PATH,
  ledgerLinkFromArtifact,
  parseCertifyArguments,
  verifyCertificationManifest,
} from "./certify-buyback-ev-launch.mjs";

test("certification arguments parse with strict validation and safe defaults", () => {
  const parsed = parseCertifyArguments([]);
  assert.equal(parsed.outPath, DEFAULT_CERTIFICATION_ARTIFACT_PATH);
  assert.equal(parsed.readinessLedgerPath, DEFAULT_READINESS_LEDGER_PATH);
  assert.equal(parsed.verificationJsonPath, null);
  assert.equal(parsed.applicationCommit, null);

  const custom = parseCertifyArguments([
    "--out",
    "docs/evidence/custom.json",
    "--readiness-ledger",
    "docs/evidence/ledger.json",
    "--verification-json",
    "docs/evidence/commands.json",
    "--application-commit",
    "0123456789abcdef0123456789abcdef01234567",
  ]);
  assert.equal(custom.outPath, "docs/evidence/custom.json");
  assert.equal(custom.readinessLedgerPath, "docs/evidence/ledger.json");
  assert.equal(custom.verificationJsonPath, "docs/evidence/commands.json");

  assert.throws(() => parseCertifyArguments(["--unknown", "x"]), /Unknown/);
  assert.throws(() => parseCertifyArguments(["--out"]), /requires a value/);
  assert.throws(
    () => parseCertifyArguments(["--out", "a.json", "--out", "b.json"]),
    /only once/,
  );
  assert.throws(
    () => parseCertifyArguments(["--application-commit", "not-a-sha!"]),
    /--application-commit/,
  );
});

test("the readiness-ledger link fails closed on anything but a composed task-012 ledger", () => {
  const artifact = {
    ledgerDigest: "a".repeat(64),
    readiness: "pass",
    generatedAt: "2026-08-20T00:00:00.000Z",
    rollbackDrill: { executed: true },
  };
  const link = ledgerLinkFromArtifact(artifact, "docs/evidence/ledger.json");
  assert.deepEqual(link, {
    ledgerDigest: "a".repeat(64),
    readiness: "pass",
    generatedAt: "2026-08-20T00:00:00.000Z",
    rollbackDrillExecuted: true,
    artifactPath: "docs/evidence/ledger.json",
  });

  const blocked = ledgerLinkFromArtifact(
    { ...artifact, readiness: "blocked", rollbackDrill: { executed: false } },
    "docs/evidence/ledger.json",
  );
  assert.equal(blocked.readiness, "blocked");
  assert.equal(blocked.rollbackDrillExecuted, false);

  assert.throws(() => ledgerLinkFromArtifact(null, "x"), /task-012 ledger/);
  assert.throws(
    () => ledgerLinkFromArtifact({ ...artifact, ledgerDigest: "short" }, "x"),
    /task-012 ledger/,
  );
  assert.throws(
    () => ledgerLinkFromArtifact({ ...artifact, readiness: "waived" }, "x"),
    /task-012 ledger/,
  );
  assert.throws(
    () => ledgerLinkFromArtifact({ ...artifact, rollbackDrill: null }, "x"),
    /task-012 ledger/,
  );
});

test("manifest verification reports every missing file and renamed test, never waiving one", async () => {
  const manifest = [
    {
      claim: "states present",
      evidence: [
        { file: "a.test.ts", testName: "renders states" },
        { file: "a.test.ts", testName: "renamed away" },
      ],
    },
    {
      claim: "rankings hold",
      evidence: [{ file: "missing.test.ts", testName: "ranks by EV" }],
    },
    { claim: "empty evidence is never verified", evidence: [] },
    {
      claim: "verified claim",
      evidence: [{ file: "a.test.ts", testName: "renders states" }],
    },
  ];
  const files = new Map([["a.test.ts", 'test("renders states", () => {});']]);
  const result = await verifyCertificationManifest(
    manifest,
    async (file) => {
      const content = files.get(file);
      if (content === undefined) throw new Error("missing");
      return content;
    },
    "2026-08-20T00:00:00.000Z",
  );
  assert.equal(result.verifiedAt, "2026-08-20T00:00:00.000Z");
  assert.equal(result.entriesVerified, 1);
  assert.deepEqual(result.missing, [
    "a.test.ts :: renamed away",
    "missing.test.ts :: ranks by EV",
  ]);
});

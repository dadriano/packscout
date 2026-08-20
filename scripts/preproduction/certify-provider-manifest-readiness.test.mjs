import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  EVIDENCE_SCHEMA_VERSION,
  NEAREST_RANK_RULE,
  ReadinessEvidenceError,
  canonicalJson,
  certifyProviderManifestReadiness,
  nearestRank,
  summarizeTimingSamples,
} from "./certify-provider-manifest-readiness.mjs";

const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "certify-provider-manifest-readiness.mjs",
);

function digest(character) {
  return character.repeat(64);
}

function successSamples(offset = 0) {
  return Array.from({ length: 20 }, (_, index) => ({
    durationMs: offset + ((index + 1) * 1_000),
    outcome: "success",
  }));
}

function providerCounts() {
  return {
    batches: 80,
    categories: 4,
    collectibles: 4_000,
    repackChases: 4_000,
    repacks: 4_000,
    searchShards: 40,
    vendors: 1,
  };
}

function validEvidence() {
  const commit = "a".repeat(40);
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    evidenceLevel: "preproduction",
    fixture: {
      name: "provider-manifest-8k",
      version: "2026.08.18-v1",
    },
    scope: {
      organizationDigest: digest("0"),
      deploymentDigest: digest("1"),
    },
    configuration: {
      epochSequence: "42",
      epochHash: digest("2"),
      enabledPlatforms: ["alpha", "beta"],
    },
    providers: [
      {
        platformKey: "alpha",
        affectedSettledWatermark: "100",
        completedWatermark: "100",
        activeWatermark: "100",
        requestDigest: digest("3"),
        receiptDigest: digest("4"),
        contentHash: digest("5"),
        counts: providerCounts(),
      },
      {
        platformKey: "beta",
        affectedSettledWatermark: "110",
        completedWatermark: "108",
        activeWatermark: "105",
        requestDigest: digest("6"),
        receiptDigest: digest("7"),
        contentHash: digest("8"),
        counts: providerCounts(),
      },
    ],
    manifest: {
      requestedSequence: "12",
      confirmedSequence: "12",
      activeManifestHash: digest("9"),
      previousManifestHash: digest("a"),
      providerReferenceSetHash: digest("b"),
      aggregateHash: digest("c"),
      publicDtoHash: digest("d"),
      requestDigest: digest("e"),
      receiptDigest: digest("f"),
      pointerResult: "activated",
      counts: {
        ...providerCounts(),
        batches: 160,
        collectibles: 8_000,
        providers: 2,
        repackChases: 8_000,
        repacks: 8_000,
        searchShards: 80,
        vendors: 2,
      },
    },
    heat: {
      frameSequence: "500",
      sourceWatermark: "110",
      manifestHash: digest("9"),
      providerReferenceSetHash: digest("b"),
      frameHash: digest("0"),
      signalSetHash: digest("1"),
      signalCount: 8_000,
      requestDigest: digest("2"),
      receiptDigest: digest("3"),
      expiryOutcome: "unavailable_after_15_minutes",
    },
    reset: {
      proofDigest: digest("4"),
      backupDigest: digest("5"),
      obsoleteConvexDocumentCount: 12,
      obsoletePostgresRowCount: 7,
      canonicalPostgresBeforeHash: digest("6"),
      canonicalPostgresAfterHash: digest("6"),
      causalSettlementBeforeHash: digest("7"),
      causalSettlementAfterHash: digest("7"),
      approvedConfigurationBeforeHash: digest("8"),
      approvedConfigurationAfterHash: digest("8"),
      normalizedHeatBeforeHash: digest("9"),
      normalizedHeatAfterHash: digest("9"),
      newPublicationState: "proven_empty",
    },
    retention: {
      proofDigest: digest("a"),
      receiptDigest: digest("b"),
      activeAndPreviousProtected: true,
      completedHeadsProtected: true,
      inFlightProtected: true,
      sharedReferencesProtected: true,
      rollbackAndBlockTargetsProtected: true,
      maximumDocumentsPerMutation: 100,
      abandonedCleanupHours: 24,
      additionalManifestCount: 3,
      retentionDays: 7,
    },
    timing: {
      rule: NEAREST_RANK_RULE,
      providerToManifestMs: successSamples(),
      heatMs: successSamples(500),
    },
    monitor: {
      processDown: {
        failureObservedAt: "2026-08-18T12:00:00.000Z",
        firedAt: "2026-08-18T12:02:00.000Z",
        recoveryObservedAt: "2026-08-18T12:03:00.000Z",
        resolvedAt: "2026-08-18T12:04:00.000Z",
      },
      heatNotAdvancing: {
        failureObservedAt: "2026-08-18T12:05:00.000Z",
        firedAt: "2026-08-18T12:06:00.000Z",
        recoveryObservedAt: "2026-08-18T12:07:00.000Z",
        resolvedAt: "2026-08-18T12:08:00.000Z",
      },
    },
    rotation: {
      role: "manifest_publish",
      overlapStartedAt: "2026-08-18T11:00:00.000Z",
      newKeyTerminalAt: "2026-08-18T11:01:00.000Z",
      oldKeyRetiredAt: "2026-08-18T11:17:00.000Z",
      overlapProofDigest: digest("c"),
      newKeyTerminalReceiptDigest: digest("d"),
      oldKeyRetirementProofDigest: digest("e"),
      retryableOperationCountAtRetirement: 0,
    },
    rollback: {
      beforePointerHash: digest("f"),
      rollbackTargetHash: digest("0"),
      afterPointerHash: digest("0"),
      receiptDigest: digest("1"),
      targetRestored: true,
    },
    certification: {
      commit,
      commands: [{
        command: "npm run verify:framework",
        commit,
        exitCode: 0,
        resultDigest: digest("2"),
      }],
    },
  };
}

function clone(value) {
  return structuredClone(value);
}

function captureError(callback) {
  try {
    callback();
  } catch (error) {
    assert.ok(error instanceof ReadinessEvidenceError);
    assert.equal(error.message, error.code);
    assert.match(error.code, /^EVIDENCE_[A-Z0-9_]+$/u);
    return error;
  }
  assert.fail("Expected evidence certification to fail.");
}

function expectCode(callback, code) {
  assert.equal(captureError(callback).code, code);
}

test("certifies strict preproduction evidence and emits canonical sanitized output", () => {
  const input = validEvidence();
  const result = certifyProviderManifestReadiness(input);

  assert.equal(result.artifact.certificationStatus, "passed");
  assert.equal(result.artifact.evidence.evidenceLevel, "preproduction");
  assert.equal(result.artifact.timingResults.providerToManifest.p50Ms, 10_000);
  assert.equal(result.artifact.timingResults.providerToManifest.p95Ms, 19_000);
  assert.equal(result.artifact.timingResults.heat.p95Ms, 19_500);
  assert.equal(result.artifact.monitorResults.processDownFireLatencyMs, 120_000);
  assert.equal(result.canonicalArtifact, canonicalJson(result.artifact));
  assert.equal(
    result.artifactSha256,
    createHash("sha256").update(result.canonicalArtifact).digest("hex"),
  );
  assert.equal(
    result.canonicalEnvelope,
    canonicalJson({
      artifact: result.artifact,
      artifactSha256: result.artifactSha256,
    }),
  );
  assert.match(result.summary, /preproduction readiness PASS/u);
  assert.doesNotMatch(result.summary, new RegExp(input.scope.organizationDigest, "u"));
  assert.doesNotMatch(result.canonicalEnvelope, /https?:\/\//u);
});

test("nearest-rank percentiles are deterministic and order-independent", () => {
  const samples = successSamples();
  const forward = summarizeTimingSamples(samples);
  const reverse = summarizeTimingSamples([...samples].reverse());

  assert.deepEqual(reverse, forward);
  assert.deepEqual(forward, {
    errorCount: 0,
    maxMs: 20_000,
    p50Ms: 10_000,
    p95Ms: 19_000,
    rule: NEAREST_RANK_RULE,
    sampleCount: 20,
    successCount: 20,
  });
  assert.equal(nearestRank([4, 1, 3, 2], 50), 2);
  assert.equal(nearestRank([4, 1, 3, 2], 95), 4);

  const forwardArtifact = certifyProviderManifestReadiness(validEvidence());
  const reversedInput = validEvidence();
  reversedInput.timing.providerToManifestMs.reverse();
  reversedInput.timing.heatMs.reverse();
  const reverseArtifact = certifyProviderManifestReadiness(reversedInput);
  assert.equal(reverseArtifact.canonicalArtifact, forwardArtifact.canonicalArtifact);
  assert.equal(reverseArtifact.artifactSha256, forwardArtifact.artifactSha256);
});

test("local evidence cannot certify launch readiness", () => {
  const input = validEvidence();
  input.evidenceLevel = "local";
  expectCode(
    () => certifyProviderManifestReadiness(input),
    "EVIDENCE_LOCAL_NOT_CERTIFIABLE",
  );
});

test("production evidence retains its explicit evidence level", () => {
  const input = validEvidence();
  input.evidenceLevel = "production";
  const result = certifyProviderManifestReadiness(input);
  assert.equal(result.artifact.evidence.evidenceLevel, "production");
  assert.match(result.summary, /production readiness PASS/u);
});

test("the certifier is an offline supplied-input validator", () => {
  const source = readFileSync(scriptPath, "utf8");
  assert.doesNotMatch(source, /\bfetch\s*\(/u);
  assert.doesNotMatch(source, /node:(?:http|https|net|tls)/u);
  assert.doesNotMatch(source, /child_process/u);
});

test("the latest manifest evaluation must be fully confirmed", () => {
  const input = validEvidence();
  input.manifest.confirmedSequence = "0";
  expectCode(
    () => certifyProviderManifestReadiness(input),
    "EVIDENCE_MANIFEST_SEQUENCE_INVALID",
  );
});

test("publication counts cannot exceed the versioned launch contracts", async (t) => {
  for (const [name, mutate] of [
    ["provider vendor cardinality", (input) => {
      input.providers[0].counts.vendors = 2;
    }],
    ["provider batch count", (input) => {
      input.providers[0].counts.batches = 4_097;
    }],
    ["provider repack count", (input) => {
      input.providers[0].counts.repacks = 8_001;
    }],
    ["provider search shard count", (input) => {
      input.providers[0].counts.searchShards = 251;
    }],
    ["manifest vendor cardinality", (input) => {
      input.manifest.counts.vendors = 9;
    }],
    ["manifest aggregate batch count", (input) => {
      input.manifest.counts.batches = 8_193;
    }],
    ["manifest aggregate provider count mismatch", (input) => {
      input.manifest.counts.searchShards = 79;
    }],
    ["Heat signal count", (input) => {
      input.heat.signalCount = 8_001;
    }],
    ["Heat coverage count", (input) => {
      input.heat.signalCount = 0;
    }],
  ]) {
    await t.test(`rejects ${name}`, () => {
      const input = validEvidence();
      mutate(input);
      expectCode(
        () => certifyProviderManifestReadiness(input),
        "EVIDENCE_COUNT_INVALID",
      );
    });
  }
});

test("reset, monitor, and rotation evidence are mandatory", async (t) => {
  for (const [field, code] of [
    ["reset", "EVIDENCE_RESET_MISSING"],
    ["monitor", "EVIDENCE_MONITOR_MISSING"],
    ["rotation", "EVIDENCE_ROTATION_MISSING"],
  ]) {
    await t.test(`rejects missing ${field}`, () => {
      const input = validEvidence();
      delete input[field];
      expectCode(() => certifyProviderManifestReadiness(input), code);
    });
  }
});

test("commands must succeed on the exact certified commit", async (t) => {
  await t.test("rejects a command recorded for another commit", () => {
    const input = validEvidence();
    input.certification.commands[0].commit = "b".repeat(40);
    expectCode(
      () => certifyProviderManifestReadiness(input),
      "EVIDENCE_COMMIT_MISMATCH",
    );
  });

  await t.test("requires the canonical verifier command", () => {
    const input = validEvidence();
    input.certification.commands[0].command = "npm run test:services";
    expectCode(
      () => certifyProviderManifestReadiness(input),
      "EVIDENCE_VERIFY_COMMAND_MISSING",
    );
  });

  await t.test("rejects a failed command", () => {
    const input = validEvidence();
    input.certification.commands[0].exitCode = 1;
    expectCode(
      () => certifyProviderManifestReadiness(input),
      "EVIDENCE_COMMAND_FAILED",
    );
  });
});

test("protected, URL-bearing, and orphan fields fail closed", async (t) => {
  await t.test("rejects a secret-bearing key at any depth", () => {
    const input = validEvidence();
    input.fixture.apiKey = "must-never-appear";
    expectCode(
      () => certifyProviderManifestReadiness(input),
      "EVIDENCE_PROTECTED_FIELD",
    );
  });

  await t.test("rejects a URL even under an otherwise unknown key", () => {
    const input = validEvidence();
    input.endpoint = "https://deployment.example.test";
    expectCode(
      () => certifyProviderManifestReadiness(input),
      "EVIDENCE_PROTECTED_FIELD",
    );
  });

  await t.test("rejects harmless-looking orphan fields", () => {
    const input = validEvidence();
    input.orphan = "not-allowlisted";
    expectCode(
      () => certifyProviderManifestReadiness(input),
      "EVIDENCE_FIELD_UNKNOWN",
    );
  });
});

test("malformed hashes, platforms, and provider ordering are rejected", async (t) => {
  await t.test("rejects a malformed scope digest", () => {
    const input = validEvidence();
    input.scope.deploymentDigest = "not-a-digest";
    expectCode(
      () => certifyProviderManifestReadiness(input),
      "EVIDENCE_DIGEST_INVALID",
    );
  });

  await t.test("rejects a noncanonical platform", () => {
    const input = validEvidence();
    input.configuration.enabledPlatforms[0] = "Alpha";
    expectCode(
      () => certifyProviderManifestReadiness(input),
      "EVIDENCE_PLATFORM_SET_INVALID",
    );
  });

  await t.test("rejects a platform with a trailing separator", () => {
    const input = validEvidence();
    input.configuration.enabledPlatforms[0] = "alpha_";
    expectCode(
      () => certifyProviderManifestReadiness(input),
      "EVIDENCE_PLATFORM_SET_INVALID",
    );
  });

  await t.test("rejects platform arrays that are not canonical", () => {
    const input = validEvidence();
    input.configuration.enabledPlatforms.reverse();
    input.providers.reverse();
    expectCode(
      () => certifyProviderManifestReadiness(input),
      "EVIDENCE_PLATFORM_SET_INVALID",
    );
  });
});

test("failure samples are counted deterministically and block certification", () => {
  const input = validEvidence();
  input.timing.providerToManifestMs[0] = {
    outcome: "error",
    errorCode: "PUBLICATION_TIMEOUT",
  };
  const summary = summarizeTimingSamples(input.timing.providerToManifestMs);
  assert.equal(summary.errorCount, 1);
  assert.equal(summary.successCount, 19);
  expectCode(
    () => certifyProviderManifestReadiness(input),
    "EVIDENCE_TIMING_FAILURES_PRESENT",
  );
});

test("the provider and Heat p95 gates are strictly below one minute", async (t) => {
  await t.test("rejects provider p95 at exactly sixty seconds", () => {
    const input = validEvidence();
    input.timing.providerToManifestMs = successSamples().map((sample) => ({
      ...sample,
      durationMs: 60_000,
    }));
    expectCode(
      () => certifyProviderManifestReadiness(input),
      "EVIDENCE_PROVIDER_P95_EXCEEDED",
    );
  });

  await t.test("rejects Heat p95 at exactly sixty seconds", () => {
    const input = validEvidence();
    input.timing.heatMs = successSamples().map((sample) => ({
      ...sample,
      durationMs: 60_000,
    }));
    expectCode(
      () => certifyProviderManifestReadiness(input),
      "EVIDENCE_HEAT_P95_EXCEEDED",
    );
  });
});

test("reset preservation, monitor deadline, and rotation overlap fail closed", async (t) => {
  await t.test("rejects changed canonical PostgreSQL evidence", () => {
    const input = validEvidence();
    input.reset.canonicalPostgresAfterHash = digest("f");
    expectCode(
      () => certifyProviderManifestReadiness(input),
      "EVIDENCE_RESET_PRESERVATION_FAILED",
    );
  });

  await t.test("rejects a monitor firing at the Heat expiry boundary", () => {
    const input = validEvidence();
    input.monitor.processDown.firedAt = "2026-08-18T12:15:00.000Z";
    input.monitor.processDown.recoveryObservedAt = "2026-08-18T12:16:00.000Z";
    input.monitor.processDown.resolvedAt = "2026-08-18T12:17:00.000Z";
    expectCode(
      () => certifyProviderManifestReadiness(input),
      "EVIDENCE_MONITOR_INVALID",
    );
  });

  await t.test("rejects retiring an old key before the overlap window", () => {
    const input = validEvidence();
    input.rotation.oldKeyRetiredAt = "2026-08-18T11:15:59.999Z";
    expectCode(
      () => certifyProviderManifestReadiness(input),
      "EVIDENCE_ROTATION_INVALID",
    );
  });
});

test("retention evidence proves the exact launch bounds", async (t) => {
  for (const [field, value] of [
    ["abandonedCleanupHours", 23],
    ["additionalManifestCount", 2],
    ["maximumDocumentsPerMutation", 99],
    ["retentionDays", 6],
  ]) {
    await t.test(`rejects ${field} drift`, () => {
      const input = validEvidence();
      input.retention[field] = value;
      expectCode(
        () => certifyProviderManifestReadiness(input),
        "EVIDENCE_RETENTION_INVALID",
      );
    });
  }
});

test("CLI emits only a canonical envelope plus a concise summary", (t) => {
  const temporary = mkdtempSync(path.join(tmpdir(), "packscout-certify-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const inputPath = path.join(temporary, "evidence.json");
  writeFileSync(inputPath, JSON.stringify(validEvidence()));

  const result = spawnSync(process.execPath, [scriptPath, inputPath], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const envelope = JSON.parse(result.stdout);
  assert.equal(`${canonicalJson(envelope)}\n`, result.stdout);
  assert.equal(
    envelope.artifactSha256,
    createHash("sha256")
      .update(canonicalJson(envelope.artifact))
      .digest("hex"),
  );
  assert.match(result.stderr, /^Task014 preproduction readiness PASS;/u);
  assert.doesNotMatch(result.stderr, /https?:\/\//u);
});

test("stable CLI failures expose only an error code", (t) => {
  const temporary = mkdtempSync(path.join(tmpdir(), "packscout-certify-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const inputPath = path.join(temporary, "invalid.json");
  writeFileSync(inputPath, "{not-json");

  const result = spawnSync(process.execPath, [scriptPath, inputPath], {
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "EVIDENCE_JSON_INVALID\n");
});

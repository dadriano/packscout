import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateAuditReport,
  isPinnedNpmVersion,
} from "./check-dependencies.mjs";

const exception = {
  id: "GHSA-abcd-1234-efgh",
  package: "dependency-a",
  reason: "Fixture exception with a bounded remediation plan.",
  owner: "tests",
  expires: "2026-12-31",
};
const configuration = {
  minimumSeverity: "high",
  exceptions: [exception],
};
const report = {
  vulnerabilities: {
    "dependency-a": {
      severity: "high",
      via: [
        {
          name: "dependency-a",
          title: "Fixture advisory",
          url: "https://github.com/advisories/GHSA-abcd-1234-efgh",
        },
      ],
    },
    "consumer-a": {
      severity: "high",
      via: ["dependency-a"],
    },
  },
};

test("allows a direct and transitive finding covered by one current exception", () => {
  const result = evaluateAuditReport(report, configuration, "2026-08-01");
  assert.deepEqual(result.unapproved, []);
  assert.equal(result.allowed.length, 2);
  assert.deepEqual(result.staleExceptions, []);
  assert.deepEqual(result.expiredExceptions, []);
});

test("rejects a high-severity advisory without an exception", () => {
  const result = evaluateAuditReport(
    report,
    { minimumSeverity: "high", exceptions: [] },
    "2026-08-01",
  );
  assert.equal(result.unapproved.length, 2);
});

test("rejects expired exceptions", () => {
  const result = evaluateAuditReport(report, configuration, "2027-01-01");
  assert.equal(result.expiredExceptions.length, 1);
  assert.equal(result.unapproved.length, 2);
});

test("rejects stale exceptions after the advisory disappears", () => {
  const result = evaluateAuditReport(
    { vulnerabilities: {} },
    configuration,
    "2026-08-01",
  );
  assert.equal(result.staleExceptions.length, 1);
});

test("ignores findings below the configured threshold", () => {
  const result = evaluateAuditReport(
    {
      vulnerabilities: {
        "dependency-b": {
          severity: "moderate",
          via: [
            {
              name: "dependency-b",
              title: "Moderate fixture",
              url: "https://github.com/advisories/GHSA-zzzz-1111-yyyy",
            },
          ],
        },
      },
    },
    { minimumSeverity: "high", exceptions: [] },
    "2026-08-01",
  );
  assert.deepEqual(result.unapproved, []);
});

test("reports malformed configuration without throwing", () => {
  const result = evaluateAuditReport(report, null, "2026-08-01");
  assert.match(result.configurationErrors[0], /must contain an object/);
});

test("rejects impossible exception expiry dates", () => {
  const result = evaluateAuditReport(
    report,
    {
      minimumSeverity: "high",
      exceptions: [{ ...exception, expires: "2026-02-31" }],
    },
    "2026-08-01",
  );
  assert.match(result.configurationErrors.join("\n"), /valid YYYY-MM-DD/);
});

test("rejects case-variant duplicate advisory exceptions", () => {
  const result = evaluateAuditReport(
    report,
    {
      minimumSeverity: "high",
      exceptions: [
        exception,
        { ...exception, id: exception.id.toLowerCase() },
      ],
    },
    "2026-08-01",
  );
  assert.match(result.configurationErrors.join("\n"), /duplicate exception/);
});

test("accepts only exact npm semantic-version packageManager pins", () => {
  assert.equal(isPinnedNpmVersion("npm@10.9.8"), true);
  assert.equal(isPinnedNpmVersion("npm@10"), false);
  assert.equal(isPinnedNpmVersion("npm@latest"), false);
  assert.equal(isPinnedNpmVersion("pnpm@10.9.8"), false);
});

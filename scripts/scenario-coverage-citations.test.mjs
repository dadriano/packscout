import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Citation integrity for the closed-beta behavior record (closed-beta-access/011).
 *
 * A scenario marked "Coverage: Automated" is a promise that named checks exist.
 * This suite makes that promise structural for the closed-beta feature's
 * behavior-spec surface — the feature's own scenario set, the authentication
 * feature file it rewrote, and the operations runbook whose proof column names
 * the same tests: every backtick-quoted test-file citation must exist on disk,
 * every scenario must carry exactly one recognized coverage marker, and every
 * "Automated" claim in the closed-beta set must cite at least one real test
 * file rather than resting on prose. Liveness assertions keep the parsing
 * honest: a regex drift that discovers nothing fails loudly instead of
 * passing vacuously.
 *
 * Deliberately scoped to the closed-beta feature's documents rather than every
 * scenario file in the repository, so this suite states this feature's
 * guarantee without adopting other features' historical citations.
 */

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const scenarioDocuments = [
  ".tasks/closed-beta-access/scenarios/closed-beta-access.feature.md",
  ".tasks/privy-auth/scenarios/privy-auth.feature.md",
  ".tasks/messaging/scenarios/messaging.feature.md",
];
const citationOnlyDocuments = [
  "docs/closed-beta-operations.md",
  "docs/messaging-operations.md",
];

const coverageMarker =
  /^Coverage: (Automated|Manual gap|Partial automation|Not applicable)\b/u;
const testFileReference = /^[\w./-]+\.test\.(?:ts|tsx|mjs|cjs|js|jsx)$/u;

function readDocument(relativePath) {
  const fullPath = path.join(repositoryRoot, relativePath);
  assert.ok(existsSync(fullPath), `${relativePath} is missing`);
  return readFileSync(fullPath, "utf8");
}

function backtickedTestFiles(text) {
  return [...text.matchAll(/`([^`\n]+)`/gu)]
    .map((match) => match[1].trim())
    .filter((reference) => testFileReference.test(reference));
}

/** Scenario blocks with their coverage paragraphs (a paragraph starting "Coverage:"). */
function parseScenarios(content) {
  const blocks = content.split(/^## Scenario: /mu).slice(1);
  return blocks.map((block) => {
    const [titleLine] = block.split("\n", 1);
    const paragraphs = block.split(/\n[ \t]*\n/u);
    const coverage = paragraphs
      .map((paragraph) => paragraph.trim())
      .filter((paragraph) => paragraph.startsWith("Coverage:"));
    return { title: titleLine.trim(), coverage };
  });
}

test("every scenario in the closed-beta behavior record carries exactly one recognized coverage marker", () => {
  for (const document of scenarioDocuments) {
    const scenarios = parseScenarios(readDocument(document));
    assert.ok(scenarios.length > 0, `${document} declares no scenarios`);
    for (const scenario of scenarios) {
      assert.equal(
        scenario.coverage.length,
        1,
        `${document} — "${scenario.title}" must have exactly one Coverage paragraph`,
      );
      assert.match(
        scenario.coverage[0],
        coverageMarker,
        `${document} — "${scenario.title}" coverage must start with Automated, Manual gap, Partial automation, or Not applicable`,
      );
    }
  }
});

test("every cited test file in the closed-beta behavior record exists on disk", () => {
  let citationsSeen = 0;
  for (const document of [...scenarioDocuments, ...citationOnlyDocuments]) {
    for (const reference of backtickedTestFiles(readDocument(document))) {
      citationsSeen += 1;
      assert.ok(
        existsSync(path.join(repositoryRoot, reference)),
        `${document} cites ${reference}, which does not exist`,
      );
    }
  }
  // Liveness: the record cites dozens of files; discovering almost none means
  // the citation regex drifted, not that the record went quiet.
  assert.ok(
    citationsSeen >= 20,
    `expected at least 20 test-file citations across the record, found ${citationsSeen}`,
  );
});

test("every Automated claim in the closed-beta scenario set names at least one test file", () => {
  const document = scenarioDocuments[0];
  const scenarios = parseScenarios(readDocument(document));
  // Liveness: the spec requires at least the nine end-to-end journeys.
  assert.ok(
    scenarios.length >= 9,
    `${document} must keep every required journey; found ${scenarios.length}`,
  );
  let automatedSeen = 0;
  for (const scenario of scenarios) {
    const [coverage] = scenario.coverage;
    if (!/^Coverage: Automated\b/u.test(coverage)) continue;
    automatedSeen += 1;
    assert.ok(
      backtickedTestFiles(coverage).length > 0,
      `${document} — "${scenario.title}" claims automation without naming a test file`,
    );
  }
  assert.ok(
    automatedSeen > 0,
    `${document} contains no Automated coverage — the parser or the record is broken`,
  );
});

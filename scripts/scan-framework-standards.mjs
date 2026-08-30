#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createDirectorySkipPredicate } from "./ignored-directories.mjs";

const root = process.cwd();
const summaryOnly = process.argv.includes("--summary");
const failOnNew = process.argv.includes("--fail-on-new");
const baselineArgument = readOption("--baseline");
const writeBaselineArgument = readOption("--write-baseline");
const growthToleranceLinesArgument = readOption("--growth-tolerance-lines");
const growthTolerancePercentArgument = readOption("--growth-tolerance-pct");
const growthToleranceLines = Number(
  growthToleranceLinesArgument ?? 40,
);
const growthTolerancePercent = Number(
  growthTolerancePercentArgument ?? 2,
);

const optionErrors = [];
for (const [name, value] of [
  ["--baseline", baselineArgument],
  ["--write-baseline", writeBaselineArgument],
  ["--growth-tolerance-lines", growthToleranceLinesArgument],
  ["--growth-tolerance-pct", growthTolerancePercentArgument],
]) {
  if (process.argv.includes(name) && value === null) {
    optionErrors.push(`${name} requires a value`);
  }
}
if (!Number.isFinite(growthToleranceLines) || growthToleranceLines < 0) {
  optionErrors.push("--growth-tolerance-lines must be a non-negative number");
}
if (!Number.isFinite(growthTolerancePercent) || growthTolerancePercent < 0) {
  optionErrors.push("--growth-tolerance-pct must be a non-negative number");
}
if (optionErrors.length > 0) {
  for (const error of optionErrors) console.error(`scan:framework: ${error}`);
  process.exit(2);
}

const surfaces = [
  { name: "frontend", directory: "apps/frontend" },
  { name: "admin", directory: "apps/admin" },
  { name: "worker", directory: "apps/worker" },
  { name: "ops-panel", directory: "apps/ops-panel" },
  { name: "contracts", directory: "packages/contracts" },
  { name: "database", directory: "packages/database" },
  { name: "services", directory: "packages/services" },
];

function surfaceForFile(relativePath) {
  const surface = surfaces.find(({ directory }) =>
    relativePath.startsWith(`${directory}/`),
  );
  return surface ? surface.name : relativePath.split("/")[0];
}
const shouldIgnoreDirectory = createDirectorySkipPredicate([
  "_generated",
]);
const sourceExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".md",
]);
const oversizedStandard =
  "SOLID boundaries require modules with cohesive responsibilities.";
const findings = [];
const checks = [];
const oversizedFiles = {};

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return !value || value.startsWith("--") ? null : value;
}

function relative(filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function walk(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (
      entry.isDirectory() &&
      !shouldIgnoreDirectory(entry.name) &&
      relative(entryPath) !== "packages/database/prisma/generated"
    ) {
      files.push(...walk(entryPath));
    } else if (
      entry.isFile() &&
      sourceExtensions.has(path.extname(entry.name))
    ) {
      files.push(entryPath);
    }
  }
  return files;
}

function read(filePath) {
  return readFileSync(filePath, "utf8");
}

function lineCount(content) {
  return content.split(/\r?\n/).length;
}

function lineNumber(content, index) {
  return content.slice(0, index).split(/\r?\n/).length;
}

function isTestFile(filePath) {
  return /(?:^|[./])(?:__tests__|test|tests)(?:[./]|$)/.test(filePath) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(filePath);
}

function addFinding({ severity, surface, file, standard, evidence, recommendation }) {
  findings.push({
    severity,
    surface,
    file,
    standard,
    evidence,
    ownerTask: "framework-foundation",
    recommendation,
  });
}

function findingKey(finding) {
  return [
    finding.severity,
    finding.surface,
    finding.file,
    finding.standard,
    finding.ownerTask,
  ].join(" | ");
}

function countBy(items, key) {
  return items.reduce((counts, item) => {
    counts[item[key]] = (counts[item[key]] ?? 0) + 1;
    return counts;
  }, {});
}

function invokesNpmScript(command, scriptName) {
  const escapedName = scriptName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:^|&&|\\|\\||;)\\s*npm\\s+run\\s+${escapedName}(?=\\s|&&|\\|\\||;|$)`,
  ).test(command);
}

function buildBaseline() {
  return {
    version: 2,
    description:
      "Known framework findings. The ratchet rejects new findings and growth of tracked oversized modules.",
    command: "npm run scan:framework-standards:baseline",
    findingCount: findings.length,
    counts: {
      severity: countBy(findings, "severity"),
      surface: countBy(findings, "surface"),
    },
    metrics: {
      growthTolerance: {
        lines: growthToleranceLines,
        percent: growthTolerancePercent,
      },
      oversizedFiles: Object.fromEntries(
        Object.entries(oversizedFiles).sort((left, right) =>
          left[0].localeCompare(right[0]),
        ),
      ),
    },
    findings: findings.map(findingKey),
  };
}

function printFindingsTable(rows) {
  if (rows.length === 0) {
    console.log("No findings.");
    return;
  }
  console.log(
    "| Severity | Surface | File | Standard | Evidence | Owner | Recommendation |",
  );
  console.log("|---|---|---|---|---|---|---|");
  for (const finding of rows) {
    console.log(
      `| ${finding.severity} | ${finding.surface} | \`${finding.file}\` | ${finding.standard} | ${finding.evidence} | ${finding.ownerTask} | ${finding.recommendation} |`,
    );
  }
}

function printSummary() {
  console.log("# Framework Standards Conformance Scan");
  console.log("");
  console.log(`Findings: ${findings.length}`);
  console.log(`By severity: ${JSON.stringify(countBy(findings, "severity"))}`);
  console.log(`By surface: ${JSON.stringify(countBy(findings, "surface"))}`);
}

function checkBaseline() {
  if (!baselineArgument) return;
  const baselinePath = path.resolve(root, baselineArgument);
  if (!existsSync(baselinePath)) {
    console.error(`Baseline file not found: ${baselineArgument}`);
    process.exitCode = 1;
    return;
  }

  const baseline = JSON.parse(read(baselinePath));
  const baselineFindings = Array.isArray(baseline.findings)
    ? baseline.findings
    : [];
  const baselineIsValid =
    baseline.version === 2 &&
    Array.isArray(baseline.findings) &&
    baseline.findingCount === baselineFindings.length;
  if (!baselineIsValid) {
    console.error(
      "Framework baseline is invalid; regenerate the schema v2 zero-debt baseline.",
    );
    process.exitCode = 1;
  }
  if (baseline.findingCount !== 0 || baselineFindings.length > 0) {
    console.error(
      "Framework baseline contains accepted findings; Packscout requires a zero-debt baseline.",
    );
    process.exitCode = 1;
  }

  const baselineKeys = new Set(baselineFindings);
  const alternateOversizedKey = (finding) =>
    [
      finding.severity === "P2" ? "P3" : "P2",
      finding.surface,
      finding.file,
      finding.standard,
      finding.ownerTask,
    ].join(" | ");
  const currentKeys = new Set(findings.map(findingKey));
  for (const finding of findings) {
    if (finding.standard === oversizedStandard) {
      currentKeys.add(alternateOversizedKey(finding));
    }
  }

  const newFindings = findings.filter((finding) => {
    if (baselineKeys.has(findingKey(finding))) return false;
    return !(
      finding.standard === oversizedStandard &&
      baselineKeys.has(alternateOversizedKey(finding))
    );
  });
  const resolvedFindings = [...baselineKeys].filter(
    (key) => !currentKeys.has(key),
  );

  console.log("");
  console.log("## Ratchet");
  console.log(`Baseline findings: ${baselineKeys.size}`);
  console.log(`Current findings: ${findings.length}`);
  console.log(`Resolved baseline findings: ${resolvedFindings.length}`);
  console.log(`New findings: ${newFindings.length}`);

  const baselineOversized = baseline.metrics?.oversizedFiles;
  const grownModules = [];
  const shrunkModules = [];
  if (baselineOversized) {
    for (const [file, lines] of Object.entries(oversizedFiles)) {
      const baselineLines = baselineOversized[file];
      if (typeof baselineLines !== "number") continue;
      const allowance = Math.max(
        growthToleranceLines,
        Math.ceil((growthTolerancePercent / 100) * baselineLines),
      );
      if (lines > baselineLines + allowance) {
        grownModules.push({
          file,
          baselineLines,
          lines,
          allowedMaximum: baselineLines + allowance,
        });
      } else if (lines < baselineLines) {
        shrunkModules.push({ file, baselineLines, lines });
      }
    }
    console.log(`Grown oversized modules: ${grownModules.length}`);
    console.log(`Shrunk oversized modules: ${shrunkModules.length}`);
    for (const item of shrunkModules) {
      console.log(
        `- burn-down: ${item.file} ${item.baselineLines} -> ${item.lines} lines`,
      );
    }
    for (const item of grownModules) {
      console.log(
        `- growth: ${item.file} ${item.baselineLines} -> ${item.lines} lines (allowed ${item.allowedMaximum})`,
      );
    }
    if (grownModules.length > 0 && failOnNew) process.exitCode = 1;
  } else if (failOnNew) {
    console.log(
      "Growth guard inactive: baseline has no size metrics. Regenerate it deliberately to activate the guard.",
    );
  }

  if (newFindings.length > 0) {
    console.log("");
    console.log("### New Findings");
    printFindingsTable(newFindings);
    if (failOnNew) process.exitCode = 1;
  }
}

function findNestedLockfiles(directory, results = []) {
  if (!existsSync(directory)) return results;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (shouldIgnoreDirectory(entry.name)) {
      continue;
    }
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      findNestedLockfiles(entryPath, results);
    } else if (
      entry.name === "package-lock.json" &&
      entryPath !== path.join(root, "package-lock.json")
    ) {
      results.push(relative(entryPath));
    }
  }
  return results;
}

const filesBySurface = new Map();
for (const surface of surfaces) {
  const files = walk(path.join(root, surface.directory)).map((filePath) => ({
    path: filePath,
    relative: relative(filePath),
    content: read(filePath),
  }));
  filesBySurface.set(surface.name, files);
  checks.push(`${surface.name}: scanned ${files.length} source/document files`);
}
const allFiles = [...filesBySurface.values()].flat();

for (const file of allFiles) {
  const internalImport = file.content.match(
    /(?:from|import)\s+["']@packscout\/[^"']+\/src(?:\/|["'])/,
  );
  if (internalImport) {
    addFinding({
      severity: "P1",
      surface: surfaceForFile(file.relative),
      file: file.relative,
      standard: "Package boundaries must use public exports.",
      evidence: `Line ${lineNumber(file.content, internalImport.index ?? 0)} imports an internal package path.`,
      recommendation: "Promote the API through the owning package entry point.",
    });
  }

  if (!isTestFile(file.relative) && /\.[cm]?[jt]sx?$/.test(file.relative)) {
    const lines = lineCount(file.content);
    if (lines >= 1500) {
      oversizedFiles[file.relative] = lines;
      addFinding({
        severity: lines >= 2500 ? "P2" : "P3",
        surface: surfaceForFile(file.relative),
        file: file.relative,
        standard: oversizedStandard,
        evidence: `${lines} lines in one active source file.`,
        recommendation:
          "Split transport, state, pure helpers, and presentation into cohesive modules.",
      });
    }
  }

  if (
    /^apps\/(?:frontend|admin)\//.test(file.relative) &&
    /\.(?:tsx|jsx)$/.test(file.relative)
  ) {
    const inlineStyles = [...file.content.matchAll(/style=\{\{/g)];
    if (inlineStyles.length >= 5) {
      addFinding({
        severity: "P3",
        surface: surfaceForFile(file.relative),
        file: file.relative,
        standard:
          "UI work should use shared classes and tokens before inline styles.",
        evidence: `${inlineStyles.length} inline style objects.`,
        recommendation:
          "Move stable rules into the surface styling system; keep only dynamic values inline.",
      });
    }
  }
}

const frontendRoutes = allFiles.filter(
  (file) =>
    /^apps\/frontend\/app\/api\/.+\/route\.ts$/.test(file.relative) &&
    !isTestFile(file.relative),
);
const frontendRouteTests = allFiles.filter((file) =>
  /^apps\/frontend\/app\/api\/.+\/route(?:\.[^.]+)*\.test\.ts$/.test(
    file.relative,
  ),
);
if (
  frontendRoutes.length > 0 &&
  frontendRouteTests.length < Math.max(1, Math.ceil(frontendRoutes.length * 0.25))
) {
  addFinding({
    severity: "P2",
    surface: "frontend",
    file: "apps/frontend/app/api",
    standard: "Frontend routes need direct route coverage.",
    evidence: `${frontendRouteTests.length} route test file(s) for ${frontendRoutes.length} route file(s).`,
    recommendation:
      "Add route-level tests for validation, access, failures, and stable responses.",
  });
}

const adminRoutes = allFiles.filter(
  (file) =>
    /^apps\/admin\/server\/routes\/.+\.ts$/.test(file.relative) &&
    !isTestFile(file.relative),
);
const adminRouteTests = allFiles.filter((file) =>
  /^apps\/admin\/server\/routes\/.+\.test\.ts$/.test(file.relative),
);
if (
  adminRoutes.length > 0 &&
  adminRouteTests.length < Math.max(1, Math.ceil(adminRoutes.length * 0.25))
) {
  addFinding({
    severity: "P2",
    surface: "admin",
    file: "apps/admin/server/routes",
    standard: "Admin routes need direct route coverage.",
    evidence: `${adminRouteTests.length} route test file(s) for ${adminRoutes.length} route file(s).`,
    recommendation:
      "Add route tests, prioritizing auth, tenant, destructive, and error-mapping behavior.",
  });
}

const scenarioFiles = existsSync(path.join(root, ".tasks"))
  ? walk(path.join(root, ".tasks")).filter((file) =>
      file.includes(`${path.sep}scenarios${path.sep}`),
    )
  : [];
if (scenarioFiles.length === 0) {
  addFinding({
    severity: "P2",
    surface: "tasks",
    file: ".tasks",
    standard: "Functional requirements map to BDD scenarios or explicit gaps.",
    evidence: "No .tasks/*/scenarios/*.feature.md files were found.",
    recommendation: "Add a scenario file using the repository template.",
  });
}

const rootPackagePath = path.join(root, "package.json");
if (existsSync(rootPackagePath)) {
  const rootPackage = JSON.parse(read(rootPackagePath));
  const workspaces = new Set(rootPackage.workspaces ?? []);
  for (const workspace of ["apps/frontend", "apps/admin"]) {
    if (!workspaces.has(workspace)) {
      addFinding({
        severity: "P2",
        surface: workspace,
        file: "package.json",
        standard: "Every application participates in the root workspace.",
        evidence: `${workspace} is missing from root workspaces.`,
        recommendation: `Add ${workspace} to the root workspace list.`,
      });
    }
  }

  const gateRequirements = [
    {
      script: "check:framework",
      requiredScripts: [
        "check:boundaries",
        "check:dependencies",
        "check:docs",
        "check:scripts",
      ],
    },
    {
      script: "verify:framework",
      requiredScripts: [
        "check:framework",
        "scan:framework-standards:ratchet",
        "lint",
        "typecheck",
        "test",
        "build",
      ],
    },
  ];
  for (const { script, requiredScripts } of gateRequirements) {
    const command = rootPackage.scripts?.[script];
    const missingScripts =
      typeof command === "string"
        ? requiredScripts.filter(
            (requiredScript) => !invokesNpmScript(command, requiredScript),
          )
        : requiredScripts;
    if (missingScripts.length > 0) {
      addFinding({
        severity: "P1",
        surface: "root",
        file: "package.json",
        standard: `${script} must compose every required quality gate.`,
        evidence:
          typeof command === "string"
            ? `${script} does not invoke: ${missingScripts.join(", ")}.`
            : `Root script ${script} is missing.`,
        recommendation: `Compose ${script} from the canonical focused scripts rather than duplicating their commands.`,
      });
    }
  }
}

for (const workspace of ["apps/frontend", "apps/admin"]) {
  const packagePath = path.join(root, workspace, "package.json");
  if (!existsSync(packagePath)) continue;
  const packageDocument = JSON.parse(read(packagePath));
  for (const script of ["lint", "typecheck", "test", "build"]) {
    if (!packageDocument.scripts?.[script]) {
      addFinding({
        severity: "P2",
        surface: workspace,
        file: `${workspace}/package.json`,
        standard: "Each application exposes focused quality commands.",
        evidence: `${script} script is missing.`,
        recommendation: `Add a focused ${script} command for ${workspace}.`,
      });
    }
  }
}

for (const lockfile of findNestedLockfiles(root)) {
  addFinding({
    severity: "P2",
    surface: "root",
    file: lockfile,
    standard: "The npm workspace uses one root lockfile.",
    evidence: "Nested package-lock.json found.",
    recommendation: "Remove the nested lockfile and install from the root.",
  });
}

findings.sort((left, right) => {
  const severity = { P1: 0, P2: 1, P3: 2 };
  return (
    severity[left.severity] - severity[right.severity] ||
    left.surface.localeCompare(right.surface) ||
    left.file.localeCompare(right.file)
  );
});

if (writeBaselineArgument) {
  if (findings.length > 0) {
    console.error(
      `Refusing to write a framework baseline with ${findings.length} finding(s); Packscout baselines must remain zero-debt.`,
    );
    process.exitCode = 1;
  } else {
    const baselinePath = path.resolve(root, writeBaselineArgument);
    writeFileSync(baselinePath, `${JSON.stringify(buildBaseline(), null, 2)}\n`);
    console.log(`Wrote baseline: ${relative(baselinePath)}`);
  }
}

if (summaryOnly) {
  printSummary();
} else {
  console.log("# Framework Standards Conformance Scan");
  console.log("");
  console.log(`Scanned at: ${new Date().toISOString()}`);
  console.log("");
  console.log("## Checks");
  for (const check of checks) console.log(`- ${check}`);
  console.log("");
  console.log("## Findings");
  printFindingsTable(findings);
}

checkBaseline();

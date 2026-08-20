#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isIgnoredDirectoryName } from "./ignored-directories.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const severityOrder = new Map([
  ["info", 0],
  ["low", 1],
  ["moderate", 2],
  ["high", 3],
  ["critical", 4],
]);
const advisoryIdPattern = /^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/i;

function advisoryId(value) {
  const match = String(value ?? "").match(
    /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i,
  );
  return match?.[0].toUpperCase() ?? null;
}

function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function validateConfiguration(configuration) {
  const errors = [];
  if (
    !configuration ||
    typeof configuration !== "object" ||
    Array.isArray(configuration)
  ) {
    return ["dependency-audit.json must contain an object"];
  }
  if (!severityOrder.has(configuration.minimumSeverity)) {
    errors.push("minimumSeverity must be info, low, moderate, high, or critical");
  }
  if (!Array.isArray(configuration.exceptions)) {
    errors.push("exceptions must be an array");
    return errors;
  }

  const seen = new Set();
  for (const [index, exception] of configuration.exceptions.entries()) {
    for (const field of ["id", "package", "reason", "owner", "expires"]) {
      if (typeof exception?.[field] !== "string" || !exception[field].trim()) {
        errors.push(`exception ${index + 1} requires a non-empty ${field}`);
      }
    }
    if (
      typeof exception?.id === "string" &&
      exception.id.trim() &&
      !advisoryIdPattern.test(exception.id.trim())
    ) {
      errors.push(`exception ${index + 1} id must use GHSA-xxxx-xxxx-xxxx`);
    }
    if (
      typeof exception?.expires === "string" &&
      !isCalendarDate(exception.expires.trim())
    ) {
      errors.push(
        `exception ${index + 1} expires must be a valid YYYY-MM-DD date`,
      );
    }

    if (
      typeof exception?.id === "string" &&
      exception.id.trim() &&
      typeof exception?.package === "string" &&
      exception.package.trim()
    ) {
      const key = `${exception.id.trim().toUpperCase()}|${exception.package.trim()}`;
      if (seen.has(key)) errors.push(`duplicate exception: ${key}`);
      seen.add(key);
    }
  }
  return errors;
}

function collectAdvisories(packageName, vulnerabilities, visiting = new Set()) {
  if (visiting.has(packageName)) return [];
  visiting.add(packageName);
  const vulnerability = vulnerabilities[packageName];
  if (!vulnerability) return [];

  const collected = [];
  for (const via of vulnerability.via ?? []) {
    if (typeof via === "string") {
      collected.push(...collectAdvisories(via, vulnerabilities, new Set(visiting)));
      continue;
    }
    const id = advisoryId(via.url) ?? advisoryId(via.title);
    collected.push({
      id: id ?? `source:${via.source ?? "unknown"}`,
      package: via.name ?? packageName,
      title: via.title ?? "Unknown advisory",
      url: via.url ?? null,
    });
  }
  return collected;
}

export function evaluateAuditReport(
  report,
  configuration,
  today = new Date().toISOString().slice(0, 10),
) {
  const configurationErrors = validateConfiguration(configuration);
  if (configurationErrors.length > 0) {
    return {
      configurationErrors,
      unapproved: [],
      allowed: [],
      staleExceptions: [],
      expiredExceptions: [],
    };
  }

  const vulnerabilities = report.vulnerabilities ?? {};
  const minimum = severityOrder.get(configuration.minimumSeverity);
  const exceptionMap = new Map(
    configuration.exceptions.map((exception) => [
      `${exception.id.trim().toUpperCase()}|${exception.package.trim()}`,
      exception,
    ]),
  );
  const seenExceptions = new Set();
  const unapproved = [];
  const allowed = [];

  for (const [packageName, vulnerability] of Object.entries(vulnerabilities)) {
    const severity = severityOrder.get(vulnerability.severity) ?? 0;
    if (severity < minimum) continue;

    const advisories = collectAdvisories(packageName, vulnerabilities);
    const unresolved = [];
    for (const advisory of advisories) {
      const key = `${advisory.id.toUpperCase()}|${advisory.package}`;
      const exception = exceptionMap.get(key);
      if (exception && exception.expires.trim() >= today) {
        seenExceptions.add(key);
      } else {
        unresolved.push(advisory);
      }
    }

    if (advisories.length > 0 && unresolved.length === 0) {
      allowed.push({ package: packageName, severity: vulnerability.severity, advisories });
    } else {
      unapproved.push({
        package: packageName,
        severity: vulnerability.severity,
        advisories: unresolved.length > 0 ? unresolved : advisories,
      });
    }
  }

  const expiredExceptions = configuration.exceptions.filter(
    (exception) => exception.expires.trim() < today,
  );
  const staleExceptions = configuration.exceptions.filter((exception) => {
    const key = `${exception.id.trim().toUpperCase()}|${exception.package.trim()}`;
    return exception.expires.trim() >= today && !seenExceptions.has(key);
  });

  return {
    configurationErrors,
    unapproved,
    allowed,
    staleExceptions,
    expiredExceptions,
  };
}

function findNestedLockfiles(directory, results = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (isIgnoredDirectoryName(entry.name)) {
      continue;
    }
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      findNestedLockfiles(entryPath, results);
    } else if (
      entry.name === "package-lock.json" &&
      entryPath !== path.join(repositoryRoot, "package-lock.json")
    ) {
      results.push(path.relative(repositoryRoot, entryPath));
    }
  }
  return results;
}

function requiresNode22OrNewer(range) {
  if (typeof range !== "string" || range.includes("||")) return false;
  const match = range.trim().match(/^>=\s*(\d+)(?:\.\d+){0,2}(?:\s|$)/);
  return Boolean(match && Number(match[1]) >= 22);
}

export function isPinnedNpmVersion(value) {
  return (
    typeof value === "string" &&
    /^npm@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
      value,
    )
  );
}

function checkWorkspaceMetadata() {
  const errors = [];
  const packagePath = path.join(repositoryRoot, "package.json");
  const lockPath = path.join(repositoryRoot, "package-lock.json");
  if (!existsSync(lockPath)) {
    errors.push("root package-lock.json is missing");
    return errors;
  }

  const packageDocument = JSON.parse(readFileSync(packagePath, "utf8"));
  const lockDocument = JSON.parse(readFileSync(lockPath, "utf8"));
  const workspaces = new Set(packageDocument.workspaces ?? []);
  for (const workspace of ["apps/frontend", "apps/admin"]) {
    if (!workspaces.has(workspace)) errors.push(`missing root workspace: ${workspace}`);
  }
  if ((lockDocument.lockfileVersion ?? 0) < 3) {
    errors.push("package-lock.json must use lockfileVersion 3 or newer");
  }
  if (!requiresNode22OrNewer(packageDocument.engines?.node)) {
    errors.push("package.json engines.node must require Node.js 22 or newer");
  }
  if (!isPinnedNpmVersion(packageDocument.packageManager)) {
    errors.push(
      "package.json must pin an exact npm version through packageManager",
    );
  }
  for (const lockfile of findNestedLockfiles(repositoryRoot)) {
    errors.push(`nested lockfile is not allowed: ${lockfile}`);
  }
  return errors;
}

function main() {
  const metadataErrors = checkWorkspaceMetadata();
  const configuration = JSON.parse(
    readFileSync(path.join(repositoryRoot, "dependency-audit.json"), "utf8"),
  );
  const audit = spawnSync("npm", ["audit", "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });

  if (audit.error) {
    console.error("check:dependencies could not run npm audit:", audit.error);
    process.exit(2);
  }

  let report;
  try {
    report = JSON.parse(audit.stdout);
  } catch {
    console.error("check:dependencies received invalid npm audit output.");
    console.error(audit.stderr);
    process.exit(2);
  }
  if (report.error) {
    console.error("check:dependencies npm audit failed:", report.error.summary ?? report.error);
    process.exit(2);
  }

  const evaluation = evaluateAuditReport(report, configuration);
  const failures = [
    ...metadataErrors,
    ...evaluation.configurationErrors,
    ...evaluation.expiredExceptions.map(
      (item) => `expired dependency exception: ${item.id} for ${item.package}`,
    ),
    ...evaluation.staleExceptions.map(
      (item) => `stale dependency exception: ${item.id} for ${item.package}`,
    ),
    ...evaluation.unapproved.map((item) => {
      const ids = item.advisories.map((advisory) => advisory.id).join(", ") || "unknown advisory";
      return `unapproved ${item.severity} vulnerability in ${item.package}: ${ids}`;
    }),
  ];

  if (failures.length > 0) {
    console.error(`Dependency check failed with ${failures.length} finding(s):`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(
    `check:dependencies ok — ${evaluation.allowed.length} package finding(s) covered by current, explicit exceptions`,
  );
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMain) {
  try {
    main();
  } catch (error) {
    console.error("check:dependencies failed:", error);
    process.exit(2);
  }
}

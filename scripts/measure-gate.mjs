#!/usr/bin/env node

/**
 * Times every phase of the canonical verification gate and reports where the
 * wall-clock actually goes.
 *
 * Claims about gate cost are only worth as much as the measurement behind them.
 * This runs each phase in isolation, records its duration and exit status, and
 * writes a machine-readable record that can be diffed against a committed
 * baseline — so an optimization can be shown to have worked, and a regression
 * shows up as a number rather than as a vague sense that things got slower.
 *
 * Phases that fail are still timed and reported. The gate has failed for tooling
 * reasons before, and an instrument that aborts on the first failure cannot
 * measure the very situation worth measuring.
 *
 *   node scripts/measure-gate.mjs                      # human-readable table
 *   node scripts/measure-gate.mjs --json               # machine-readable record
 *   node scripts/measure-gate.mjs --out <path>         # write the record to disk
 *   node scripts/measure-gate.mjs --group typecheck    # time one group only
 *   node scripts/measure-gate.mjs --baseline <path>    # compare against a baseline
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareToBaseline,
  formatDuration,
  GATE_PHASE_GROUPS,
  selectPhases,
  summarize,
} from "./gate-phases.mjs";

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const jsonOnly = process.argv.includes("--json");
const outputPath = readOption("--out");
const baselinePath = readOption("--baseline");
const requestedGroup = readOption("--group");

if (requestedGroup && !GATE_PHASE_GROUPS.includes(requestedGroup)) {
  console.error(
    `Unknown group "${requestedGroup}". Available: ${GATE_PHASE_GROUPS.join(", ")}`,
  );
  process.exit(1);
}

function measure(phase) {
  const startedAt = process.hrtime.bigint();
  const result = spawnSync("npm", ["run", phase.name], {
    cwd: repositoryRoot,
    stdio: "ignore",
  });
  const durationMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);

  return {
    phase: phase.name,
    group: phase.group,
    durationMs,
    exitCode: result.status ?? 1,
    ok: result.status === 0,
  };
}

function report(results) {
  const width = Math.max(...results.map((entry) => entry.phase.length));
  let currentGroup = null;
  let groupTotal = 0;

  const flushGroup = () => {
    if (currentGroup !== null) {
      console.log(`  ${"".padEnd(width)}  ${formatDuration(groupTotal).padStart(8)}  group total`);
    }
  };

  for (const entry of results) {
    if (entry.group !== currentGroup) {
      flushGroup();
      console.log(`\n${entry.group}`);
      currentGroup = entry.group;
      groupTotal = 0;
    }
    groupTotal += entry.durationMs;
    console.log(
      `  ${entry.phase.padEnd(width)}  ${formatDuration(entry.durationMs).padStart(8)}  ${entry.ok ? "ok" : "FAIL"}`,
    );
  }
  flushGroup();
}

function reportComparison(baseline, record) {
  const rows = compareToBaseline(baseline, record).filter(
    (row) => row.status !== "compared" || Math.abs(row.deltaMs) >= 100,
  );
  if (rows.length === 0) {
    console.log("\nno phase moved by more than 100ms against the baseline");
    return;
  }

  console.log("\nagainst baseline (changes over 100ms)");
  const width = Math.max(...rows.map((row) => row.phase.length));
  for (const row of rows) {
    if (row.status !== "compared") {
      console.log(`  ${row.phase.padEnd(width)}  ${row.status}`);
      continue;
    }
    const sign = row.deltaMs > 0 ? "+" : "";
    console.log(
      `  ${row.phase.padEnd(width)}  ${(sign + formatDuration(Math.abs(row.deltaMs))).padStart(9)}`,
    );
  }
  const delta = record.totalMs - (baseline?.totalMs ?? 0);
  console.log(
    `  total ${delta > 0 ? "+" : "-"}${formatDuration(Math.abs(delta))} (${formatDuration(baseline?.totalMs ?? 0)} -> ${formatDuration(record.totalMs)})`,
  );
}

const results = [];
for (const phase of selectPhases(requestedGroup)) {
  if (!jsonOnly) process.stderr.write(`[measure-gate] ${phase.name}\n`);
  results.push(measure(phase));
}

const record = summarize(results);

if (jsonOnly) {
  console.log(JSON.stringify(record, null, 2));
} else {
  report(results);
  console.log(
    `\ngate total ${formatDuration(record.totalMs)} across ${results.length} phase(s)`,
  );
  if (record.failingPhases.length > 0) {
    console.log(
      `failing phases (${record.failingPhases.length}): ${record.failingPhases.join(", ")}`,
    );
  }
}

if (baselinePath) {
  try {
    const baseline = JSON.parse(
      readFileSync(path.resolve(repositoryRoot, baselinePath), "utf8"),
    );
    if (!jsonOnly) reportComparison(baseline, record);
  } catch (error) {
    console.error(`[measure-gate] could not read baseline: ${error.message}`);
  }
}

if (outputPath) {
  const resolved = path.resolve(repositoryRoot, outputPath);
  writeFileSync(resolved, `${JSON.stringify(record, null, 2)}\n`);
  if (!jsonOnly) {
    console.log(`\nwrote ${path.relative(repositoryRoot, resolved)}`);
  }
}

// The instrument succeeds even when the phases it measured did not. Reporting a
// failing gate is the tool working, not the tool failing.
process.exit(0);

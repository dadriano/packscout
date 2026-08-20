import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * Structural proof for task buyback-adjusted-ev/010: no public surface
 * recalculates the business formula. The shared presentation boundary is the
 * single consumer of raw public EV numerics, and components render only
 * pre-formatted presentation values.
 */

const frontendRoot = path.dirname(fileURLToPath(import.meta.url));

// Raw PackScout EV numerics. Heat and chase-match confidence carry their own
// separately named scores, so this vocabulary is exclusive to the EV metrics.
const RAW_EV_TOKENS =
  /grossEvMoney|grossReturnBasisPoints|evPercentBasisPoints|evDollars\.minorUnits|rateBasisPoints/;

function walk(directory: string, files: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "public"].includes(entry.name)) continue;
      if (entry.name.startsWith(".next")) continue;
      walk(entryPath, files);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

function relative(file: string): string {
  return path.relative(frontendRoot, file).split(path.sep).join("/");
}

const sourceFiles = [
  ...walk(path.join(frontendRoot, "app")),
  ...walk(path.join(frontendRoot, "components")),
  ...walk(path.join(frontendRoot, "lib")),
].filter(
  (file) => !/\.test\.(ts|tsx)$/.test(file) && !file.includes(".test-support."),
);

test("only the presentation boundary consumes raw public EV numerics", () => {
  const consumers = sourceFiles
    .filter((file) => RAW_EV_TOKENS.test(readFileSync(file, "utf8")))
    .map(relative)
    .sort();

  assert.deepEqual(consumers, ["lib/packscout-ev-presentation.ts"]);
});

test("no component imports the calculator or the contract consistency helper", () => {
  for (const file of sourceFiles) {
    const source = readFileSync(file, "utf8");
    const name = relative(file);
    if (name !== "lib/packscout-ev-presentation.ts") {
      assert.doesNotMatch(
        source,
        /packScoutBuybackEvMetricsAreConsistentV1/,
        name,
      );
    }
    assert.doesNotMatch(source, /buyback-adjusted-ev-v1/, name);
  }
});

test("components never format EV numbers or own break-even thresholds", () => {
  const componentFiles = sourceFiles.filter(
    (file) => file.endsWith(".tsx") && !relative(file).startsWith("lib/"),
  );
  assert.ok(componentFiles.length >= 10, "component sweep must cover the UI");
  for (const file of componentFiles) {
    const source = readFileSync(file, "utf8");
    const name = relative(file);
    // Raw metric access and re-derivation stay behind the boundary.
    assert.doesNotMatch(source, /\.metrics\./, name);
    assert.doesNotMatch(source, RAW_EV_TOKENS, name);
    // Semantic thresholds come from the boundary, never recomputed inline.
    assert.doesNotMatch(source, /semanticStateForSignedBasisPoints/, name);
    // Components must not build their own number formatters for EV values.
    assert.doesNotMatch(source, /Intl\.NumberFormat/, name);
  }
});

test("public surfaces resolve deadlines through the shared client store only", () => {
  for (const name of [
    "components/catalog/OpportunityTable.client.tsx",
    "components/catalog/AllRepacksTable.client.tsx",
    "components/catalog/PackInspector.client.tsx",
  ]) {
    const source = readFileSync(path.join(frontendRoot, name), "utf8");
    assert.match(source, /useDeadlineBoundPackScoutEv/, name);
    assert.doesNotMatch(source, /Date\.now|setInterval/, name);
    // No passive clock-tick live regions around EV state.
    assert.doesNotMatch(source, /aria-live="assertive"/, name);
  }
});

test("the deadline hook is hydration-safe with a stable server snapshot", () => {
  const source = readFileSync(
    path.join(frontendRoot, "lib/packscout-ev-deadline.client.ts"),
    "utf8",
  );
  assert.match(source, /useSyncExternalStore/);
  assert.match(source, /getServerSnapshot/);
  assert.match(source, /function serverDeadlineSnapshot\(\): false/);
  assert.doesNotMatch(source, /aria-live/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scannerPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "scan-framework-standards.mjs",
);

function createFixture(t, bigFileLines) {
  const root = mkdtempSync(path.join(tmpdir(), "packscout-scan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        private: true,
        workspaces: ["apps/frontend", "apps/admin"],
        scripts: {
          "check:framework":
            "npm run check:boundaries && npm run check:dependencies && npm run check:docs && npm run check:scripts",
          "verify:framework":
            "npm run check:framework && npm run scan:framework-standards:ratchet && npm run lint && npm run typecheck && npm run test && npm run build",
        },
      },
      null,
      2,
    ),
  );
  for (const workspace of ["apps/frontend", "apps/admin"]) {
    mkdirSync(path.join(root, workspace), { recursive: true });
    writeFileSync(
      path.join(root, workspace, "package.json"),
      JSON.stringify({
        scripts: {
          lint: "eslint .",
          typecheck: "tsc --noEmit",
          test: "node --test",
          build: "tsc",
        },
      }),
    );
  }
  mkdirSync(path.join(root, ".tasks", "fixture", "scenarios"), {
    recursive: true,
  });
  writeFileSync(
    path.join(root, ".tasks", "fixture", "scenarios", "fixture.feature.md"),
    "# Fixture scenario\n",
  );
  writeBigFile(root, bigFileLines);
  return root;
}

function writeBigFile(root, lines) {
  const content = Array.from(
    { length: lines },
    (_, index) => `export const value${index} = ${index};`,
  ).join("\n");
  writeFileSync(path.join(root, "apps", "frontend", "big.ts"), `${content}\n`);
}

function runScanner(root, argumentsList) {
  const result = spawnSync(process.execPath, [scannerPath, ...argumentsList], {
    cwd: root,
    encoding: "utf8",
  });
  return {
    status: result.status,
    output: `${result.stdout}\n${result.stderr}`,
  };
}

function writeBaseline(root) {
  const result = runScanner(root, [
    "--summary",
    "--write-baseline",
    "baseline.json",
  ]);
  assert.equal(result.status, 0, result.output);
  return JSON.parse(readFileSync(path.join(root, "baseline.json"), "utf8"));
}

const ratchetArguments = [
  "--summary",
  "--baseline",
  "baseline.json",
  "--fail-on-new",
];

test("baseline writer records a schema v2 zero-debt baseline", (t) => {
  const root = createFixture(t, 20);
  const baseline = writeBaseline(root);
  assert.equal(baseline.version, 2);
  assert.equal(baseline.findingCount, 0);
  assert.deepEqual(baseline.metrics.oversizedFiles, {});
  const ratchet = runScanner(root, ratchetArguments);
  assert.equal(ratchet.status, 0, ratchet.output);
});

test("baseline writer refuses to capture existing findings", (t) => {
  const root = createFixture(t, 2600);
  const result = runScanner(root, [
    "--summary",
    "--write-baseline",
    "baseline.json",
  ]);

  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /baselines must remain zero-debt/);
  assert.equal(existsSync(path.join(root, "baseline.json")), false);
});

test("a newly oversized module fails a zero-debt baseline", (t) => {
  const root = createFixture(t, 20);
  writeBaseline(root);
  writeBigFile(root, 2600);
  const result = runScanner(root, ratchetArguments);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /SOLID boundaries require modules/);
});

test("a new uncovered API route fails a zero-debt baseline", (t) => {
  const root = createFixture(t, 20);
  writeBaseline(root);
  const routeDirectory = path.join(root, "apps", "frontend", "app", "api", "example");
  mkdirSync(routeDirectory, { recursive: true });
  writeFileSync(
    path.join(routeDirectory, "route.ts"),
    "export function GET() { return new Response(); }\n",
  );
  const result = runScanner(root, ratchetArguments);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /Frontend routes need direct route coverage/);
});

test("invalid growth tolerances fail closed", (t) => {
  const root = createFixture(t, 20);
  const result = runScanner(root, [
    "--summary",
    "--growth-tolerance-lines",
    "not-a-number",
  ]);

  assert.equal(result.status, 2, result.output);
  assert.match(result.output, /must be a non-negative number/);
});

test("framework gates must compose every required focused script", (t) => {
  const root = createFixture(t, 20);
  writeBaseline(root);
  const packagePath = path.join(root, "package.json");
  const packageDocument = JSON.parse(readFileSync(packagePath, "utf8"));
  packageDocument.scripts["check:framework"] =
    "npm run check:boundaries && npm run check:dependencies && npm run check:scripts";
  writeFileSync(packagePath, `${JSON.stringify(packageDocument, null, 2)}\n`);

  const result = runScanner(root, ratchetArguments);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /check:framework does not invoke: check:docs/);
});

test("ratchet rejects a manually edited nonzero baseline", (t) => {
  const root = createFixture(t, 20);
  const baseline = writeBaseline(root);
  baseline.findingCount = 1;
  baseline.findings = ["P3 | fake | fake.ts | Accepted debt | fake-owner"];
  writeFileSync(
    path.join(root, "baseline.json"),
    `${JSON.stringify(baseline, null, 2)}\n`,
  );

  const result = runScanner(root, ratchetArguments);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /requires a zero-debt baseline/);
});

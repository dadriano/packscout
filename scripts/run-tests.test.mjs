import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const runnerPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "run-tests.mjs",
);

function createFixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "packscout-run-tests-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "apps", "frontend", "e2e"), { recursive: true });
  mkdirSync(path.join(root, "apps", "admin", "src"), { recursive: true });
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  writeFileSync(path.join(root, "test-quarantine.json"), "[]\n");
  return root;
}

function runList(root, target) {
  return spawnSync(
    process.execPath,
    [runnerPath, target, "--list", "--root", root],
    { encoding: "utf8" },
  );
}

function runTarget(root, target) {
  return spawnSync(
    process.execPath,
    [runnerPath, target, "--root", root],
    { encoding: "utf8" },
  );
}

test("discovers root-level frontend tests and excludes the e2e directory", (t) => {
  const root = createFixture(t);
  writeFileSync(
    path.join(root, "apps", "frontend", "proxy.test.ts"),
    'import test from "node:test"; test("proxy", () => {});\n',
  );
  writeFileSync(
    path.join(root, "apps", "frontend", "e2e", "browser.test.ts"),
    'import test from "node:test"; test("browser", () => {});\n',
  );

  const result = runList(root, "frontend");
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /proxy\.test\.ts/);
  assert.doesNotMatch(result.stdout, /browser\.test\.ts/);
});

test("rejects quarantine entries that no test lane discovers", (t) => {
  const root = createFixture(t);
  writeFileSync(
    path.join(root, "apps", "frontend", "proxy.test.ts"),
    'import test from "node:test"; test("proxy", () => {});\n',
  );
  writeFileSync(path.join(root, "apps", "frontend", "not-a-test.ts"), "export {};\n");
  writeFileSync(
    path.join(root, "test-quarantine.json"),
    `${JSON.stringify([
      {
        file: "apps/frontend/not-a-test.ts",
        reason: "Fixture",
        owner: "tests",
      },
    ])}\n`,
  );

  const result = runList(root, "frontend");
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /not discovered by any test lane/);
});

test("fails when every discovered test in a lane is quarantined", (t) => {
  const root = createFixture(t);
  writeFileSync(
    path.join(root, "apps", "frontend", "proxy.test.ts"),
    'import test from "node:test"; test("proxy", () => {});\n',
  );
  writeFileSync(
    path.join(root, "test-quarantine.json"),
    `${JSON.stringify([
      {
        file: "apps/frontend/proxy.test.ts",
        reason: "Fixture",
        owner: "tests",
      },
    ])}\n`,
  );

  const result = runList(root, "frontend");
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /every discovered test quarantined/);
});

test("runs process integration files only after the parallel tooling lane", (t) => {
  const root = createFixture(t);
  const markerPath = path.join(root, "parallel-complete");
  writeFileSync(
    path.join(root, "scripts", "parallel.test.mjs"),
    `import { writeFileSync } from "node:fs";\n` +
      `import test from "node:test";\n` +
      `test("parallel", () => writeFileSync(${JSON.stringify(markerPath)}, "done"));\n`,
  );
  writeFileSync(
    path.join(root, "scripts", "start-admin-embedded.test.mjs"),
    `import { existsSync } from "node:fs";\n` +
      `import assert from "node:assert/strict";\n` +
      `import test from "node:test";\n` +
      `test("isolated", () => assert.equal(existsSync(${JSON.stringify(markerPath)}), true));\n`,
  );

  const result = runTarget(root, "tooling");
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(
    result.stdout,
    /executing isolated scripts\/start-admin-embedded\.test\.mjs/,
  );
});

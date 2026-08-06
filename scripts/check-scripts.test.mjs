import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const checkerPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "check-scripts.mjs",
);

function runFixture(t, scripts) {
  const root = mkdtempSync(path.join(tmpdir(), "packscout-scripts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({ private: true, scripts }, null, 2)}\n`,
  );
  return spawnSync(process.execPath, [checkerPath, "--root", root], {
    encoding: "utf8",
  });
}

test("does not treat arbitrary names beginning with test as safe", (t) => {
  const result = runFixture(t, {
    "testing-reset": "node scripts/reset-fixture.mjs",
  });

  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /testing-reset/);
});

test("requires an exact environment qualifier segment", (t) => {
  const result = runFixture(t, {
    "db:reset:productive": "node scripts/reset-fixture.mjs",
  });

  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /db:reset:productive/);
});

test("accepts explicitly scoped destructive scripts", (t) => {
  const result = runFixture(t, {
    "db:reset:local": "prisma migrate reset --force",
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("does not let a safe script prefix hide a destructive command", (t) => {
  const result = runFixture(t, {
    "test:database": "prisma migrate reset --force",
  });

  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /database reset commands/);
});

test("does not let conventional prefixes hide destructive script names", (t) => {
  const result = runFixture(t, {
    "lint-reset": "eslint .",
    "test:db-reset": "node --test",
  });

  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /lint-reset/);
  assert.match(result.stderr, /test:db-reset/);
});

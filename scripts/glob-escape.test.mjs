import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { escapeGlobPath } from "./glob-escape.mjs";

test("escapes dynamic-route brackets into literal-matching character classes", () => {
  assert.equal(
    escapeGlobPath("app/products/[productId]/route.test.ts"),
    "app/products/[[]productId[]]/route.test.ts",
  );
});

test("leaves route groups and plain paths untouched", () => {
  assert.equal(
    escapeGlobPath("app/(protected)/dashboard/page.test.ts"),
    "app/(protected)/dashboard/page.test.ts",
  );
  assert.equal(escapeGlobPath("lib/plain.test.ts"), "lib/plain.test.ts");
});

test("escapes every remaining glob metacharacter", () => {
  assert.equal(escapeGlobPath("a[b]*c?.{ts}"), "a[[]b[]][*]c[?].[{]ts[}]");
});

test("node --test executes a test inside a bracket directory only when escaped", () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "packscout-glob-"));
  const relativeTest = "[id]/probe.test.mjs";
  const markerPath = path.join(fixtureRoot, "ran.marker");
  mkdirSync(path.join(fixtureRoot, "[id]"), { recursive: true });
  writeFileSync(
    path.join(fixtureRoot, relativeTest),
    `import { test } from "node:test";\n` +
      `import { writeFileSync } from "node:fs";\n` +
      `test("probe", () => writeFileSync(${JSON.stringify(markerPath)}, "ran"));\n`,
  );

  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_TEST_CONTEXT;
  delete childEnvironment.NODE_OPTIONS;
  const options = {
    cwd: fixtureRoot,
    encoding: "utf8",
    env: childEnvironment,
  };

  spawnSync(process.execPath, ["--test", relativeTest], options);
  assert.equal(existsSync(markerPath), false);

  spawnSync(process.execPath, ["--test", escapeGlobPath(relativeTest)], options);
  assert.equal(existsSync(markerPath), true);

  rmSync(fixtureRoot, { recursive: true, force: true });
});

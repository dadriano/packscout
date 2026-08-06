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

const checkerPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "check-boundaries.mjs",
);

function createFixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "packscout-boundaries-"));
  mkdirSync(path.join(root, "apps", "frontend", "app"), { recursive: true });
  mkdirSync(path.join(root, "apps", "admin", "src"), { recursive: true });
  mkdirSync(path.join(root, "apps", "admin", "server"), { recursive: true });
  mkdirSync(path.join(root, "packages", "contracts", "src"), { recursive: true });
  mkdirSync(path.join(root, "packages", "services", "src"), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function runChecker(root) {
  return spawnSync(process.execPath, [checkerPath, "--root", root], {
    encoding: "utf8",
  });
}

test("passes when frontend and admin keep their runtime boundaries", (t) => {
  const root = createFixture(t);
  writeFileSync(
    path.join(root, "apps", "frontend", "app", "page.tsx"),
    'export default function Page() { return <main>Safe</main>; }\n',
  );
  writeFileSync(
    path.join(root, "apps", "admin", "src", "App.tsx"),
    'import { useState } from "react";\nexport function App() { return useState(0)[0]; }\n',
  );
  writeFileSync(
    path.join(root, "apps", "admin", "server", "index.ts"),
    'import express from "express";\nexport const app = express();\n',
  );

  const result = runChecker(root);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("rejects Node-only imports from frontend client components", (t) => {
  const root = createFixture(t);
  writeFileSync(
    path.join(root, "apps", "frontend", "app", "Client.tsx"),
    '"use client";\nimport fs from "node:fs";\nexport const value = fs;\n',
  );

  const result = runChecker(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /frontend-client-no-server-imports/);
});

test("rejects admin browser imports from the Express server", (t) => {
  const root = createFixture(t);
  writeFileSync(
    path.join(root, "apps", "admin", "server", "secret.ts"),
    'export const secret = "server";\n',
  );
  writeFileSync(
    path.join(root, "apps", "admin", "src", "App.tsx"),
    'import { secret } from "../server/secret";\nexport const value = secret;\n',
  );

  const result = runChecker(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no-cross-zone-relative-imports/);
});

test("rejects package aliases that cross between applications", (t) => {
  const root = createFixture(t);
  writeFileSync(
    path.join(root, "apps", "frontend", "app", "page.tsx"),
    'import "@packscout/admin";\nexport default function Page() { return null; }\n',
  );

  const result = runChecker(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no-cross-app-imports/);
});

test("does not confuse similarly prefixed external packages with an app alias", (t) => {
  const root = createFixture(t);
  writeFileSync(
    path.join(root, "apps", "frontend", "app", "page.tsx"),
    'import "@packscout/admin-tools";\nexport default function Page() { return null; }\n',
  );

  const result = runChecker(root);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("rejects admin browser imports that use the admin server package alias", (t) => {
  const root = createFixture(t);
  writeFileSync(
    path.join(root, "apps", "admin", "src", "App.tsx"),
    'import { secret } from "@packscout/admin/server/secret";\nexport const value = secret;\n',
  );

  const result = runChecker(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no-cross-zone-package-imports/);
});

test("rejects server service imports from the admin browser", (t) => {
  const root = createFixture(t);
  writeFileSync(
    path.join(root, "apps", "admin", "src", "App.tsx"),
    'import { secretWorkflow } from "@packscout/services";\nexport const value = secretWorkflow;\n',
  );

  const result = runChecker(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /admin-client-no-server-packages/);
});

test("keeps the shared contracts package runtime neutral", (t) => {
  const root = createFixture(t);
  writeFileSync(
    path.join(root, "packages", "contracts", "src", "index.ts"),
    'import crypto from "node:crypto";\nexport const value = crypto;\n',
  );

  const result = runChecker(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /contracts-runtime-neutral/);
});

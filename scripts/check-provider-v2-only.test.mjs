import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const checker = fileURLToPath(new URL("./check-provider-v2-only.mjs", import.meta.url));
const legacyAdapterKey = ["http", "-cursor-v1"].join("");
const legacyContract = ["Provider", "FeedPageV1"].join("");
const legacyFileName = ["provider", "-feed.ts"].join("");

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "packscout-provider-v2-only-"));
  await mkdir(path.join(root, "apps", "worker"), { recursive: true });
  await mkdir(path.join(root, "packages", "contracts"), { recursive: true });
  await writeFile(
    path.join(root, "apps", "worker", "index.ts"),
    'export const adapter = "http-cursor-v2";\n',
  );
  return root;
}

test("provider V2-only check accepts the clean executable surface", async () => {
  const root = await createFixture();
  try {
    const result = await execFileAsync(process.execPath, [checker, "--root", root]);
    assert.match(result.stdout, /check:provider-v2-only ok/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider V2-only check rejects legacy contracts, keys, and source paths", async () => {
  const root = await createFixture();
  try {
    await writeFile(
      path.join(root, "apps", "worker", "index.ts"),
      `export const adapter = "${legacyAdapterKey}";\n`,
    );
    await writeFile(
      path.join(root, "packages", "contracts", "legacy.ts"),
      `export type Page = ${legacyContract};\n`,
    );
    await writeFile(
      path.join(root, "packages", "contracts", legacyFileName),
      "export const historical = true;\n",
    );
    await assert.rejects(
      execFileAsync(process.execPath, [checker, "--root", root]),
      (error) => {
        assert.match(error.stderr, /Provider V2-only check failed/);
        assert.match(error.stderr, /index\.ts/);
        assert.match(error.stderr, /legacy\.ts/);
        assert.match(error.stderr, new RegExp(legacyFileName.replace(".", "\\.")));
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider V2-only check rejects active legacy task artifacts", async () => {
  const root = await createFixture();
  try {
    const tasks = path.join(root, ".tasks", "data-pipeline");
    await mkdir(tasks, { recursive: true });
    await writeFile(path.join(tasks, "_index.md"), "# Active aggregate V1 plan\n");
    await assert.rejects(
      execFileAsync(process.execPath, [checker, "--root", root]),
      (error) => {
        assert.match(error.stderr, /legacy design must stay explicitly superseded/);
        assert.match(error.stderr, /_index\.md/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

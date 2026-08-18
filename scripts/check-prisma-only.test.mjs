import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const checker = fileURLToPath(new URL("./check-prisma-only.mjs", import.meta.url));
const legacyName = ["driz", "zle"].join("");

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "packscout-prisma-only-"));
  await mkdir(path.join(root, "apps", "worker"), { recursive: true });
  await mkdir(path.join(root, "packages", "database"), { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"name":"fixture"}\n');
  await writeFile(path.join(root, "package-lock.json"), '{"name":"fixture"}\n');
  await writeFile(
    path.join(root, "apps", "worker", "index.ts"),
    'export const persistence = "prisma";\n',
  );
  return root;
}

test("Prisma-only check accepts a clean executable surface", async () => {
  const root = await createFixture();
  try {
    const result = await execFileAsync(process.execPath, [checker, "--root", root]);
    assert.match(result.stdout, /check:prisma-only ok/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Prisma-only check rejects legacy dependency content and paths", async () => {
  const root = await createFixture();
  try {
    await mkdir(
      path.join(root, "packages", "database", legacyName, "migrations"),
      { recursive: true },
    );
    await writeFile(
      path.join(root, "packages", "database", "package.json"),
      JSON.stringify({ dependencies: { [`${legacyName}-orm`]: "1.0.0" } }),
    );
    await writeFile(
      path.join(root, "packages", "database", `${legacyName}.config.ts`),
      "export default {};\n",
    );
    await writeFile(
      path.join(
        root,
        "packages",
        "database",
        legacyName,
        "migrations",
        "0000_legacy.sql",
      ),
      "create table legacy_table (id integer primary key);\n",
    );
    await assert.rejects(
      execFileAsync(process.execPath, [checker, "--root", root]),
      (error) => {
        assert.match(error.stderr, /Prisma-only persistence check failed/);
        assert.match(error.stderr, /package\.json/);
        assert.match(error.stderr, /config\.ts/);
        assert.match(error.stderr, /0000_legacy\.sql/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Prisma-only check skips only generated Next build directories", async () => {
  const root = await createFixture();
  try {
    for (const generatedDirectory of [".next", ".next-build", ".next-dev"]) {
      const generatedRoot = path.join(
        root,
        "apps",
        "frontend",
        generatedDirectory,
        "static",
      );
      await mkdir(generatedRoot, { recursive: true });
      await writeFile(
        path.join(generatedRoot, "third-party.js"),
        `export const generated = "${legacyName}";\n`,
      );
    }

    const result = await execFileAsync(process.execPath, [checker, "--root", root]);
    assert.match(result.stdout, /check:prisma-only ok/);

    await writeFile(
      path.join(root, "apps", "frontend", "source.ts"),
      `export const forbidden = "${legacyName}";\n`,
    );
    await assert.rejects(
      execFileAsync(process.execPath, [checker, "--root", root]),
      (error) => {
        assert.match(error.stderr, /apps\/frontend\/source\.ts/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

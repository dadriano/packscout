import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  isMigrationDirectoryName,
  readRepositoryMigrations,
  resolvePrismaWorkspacePaths,
} from "./repository-migrations.ts";

const directories: string[] = [];

after(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "ops-panel-migrations-"));
  directories.push(directory);
  return directory;
}

test("the ORM's schema and migrations are derived from the workspace root", () => {
  const paths = resolvePrismaWorkspacePaths("/workspace");
  assert.equal(paths.schemaFile, "/workspace/packages/database/prisma/schema.prisma");
  assert.equal(paths.migrationsDirectory, "/workspace/packages/database/prisma/migrations");
});

test("only directories named like migrations are counted", () => {
  assert.equal(isMigrationDirectoryName("20260812000000_clean_baseline"), true);
  assert.equal(isMigrationDirectoryName("migration_lock.toml"), false);
  assert.equal(isMigrationDirectoryName("notes"), false);
  assert.equal(isMigrationDirectoryName(""), false);
  assert.equal(isMigrationDirectoryName(undefined), false);
});

test("migration names are read from disk and sorted", async () => {
  const directory = await temporaryDirectory();
  await mkdir(path.join(directory, "20260815010000_second"));
  await mkdir(path.join(directory, "20260812000000_first"));
  await mkdir(path.join(directory, "scratch"));
  await writeFile(path.join(directory, "migration_lock.toml"), "provider = 'postgresql'\n");

  assert.deepEqual(await readRepositoryMigrations(directory), [
    "20260812000000_first",
    "20260815010000_second",
  ]);
});

test("a missing migrations directory reads as none, not as a failure", async () => {
  const directory = path.join(await temporaryDirectory(), "absent");
  assert.deepEqual(await readRepositoryMigrations(directory), []);
});

import { readdir } from "node:fs/promises";
import path from "node:path";

/**
 * The migrations the repository contains, read from the ORM's own migration
 * directory. This is one half of the migration comparison; the other half is
 * the history the database recorded.
 *
 * The path is derived from the workspace root the panel already knows. No
 * caller-supplied path ever reaches this module — that is a permanent design
 * invariant of the panel, not an incidental property of today's routes.
 */

/** The ORM directory the workspace's database package owns. */
export const PRISMA_DIRECTORY_SEGMENTS = ["packages", "database", "prisma"] as const;

/** Prisma names a migration `<timestamp>_<slug>`; anything else is not one. */
const MIGRATION_DIRECTORY_PATTERN = /^\d{8,}_[A-Za-z0-9][A-Za-z0-9_-]*$/u;

export interface PrismaWorkspacePaths {
  readonly schemaFile: string;
  readonly migrationsDirectory: string;
}

export function resolvePrismaWorkspacePaths(
  workspaceRoot: string,
): PrismaWorkspacePaths {
  const prismaDirectory = path.join(workspaceRoot, ...PRISMA_DIRECTORY_SEGMENTS);
  return {
    schemaFile: path.join(prismaDirectory, "schema.prisma"),
    migrationsDirectory: path.join(prismaDirectory, "migrations"),
  };
}

export function isMigrationDirectoryName(value: unknown): value is string {
  return typeof value === "string" && MIGRATION_DIRECTORY_PATTERN.test(value);
}

/**
 * List repository migration names, sorted. A missing directory yields an empty
 * list rather than an error: a workspace without migrations is a state to
 * report, not a failure to read.
 */
export async function readRepositoryMigrations(
  migrationsDirectory: string,
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(migrationsDirectory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && isMigrationDirectoryName(entry.name))
    .map((entry) => entry.name)
    .sort();
}

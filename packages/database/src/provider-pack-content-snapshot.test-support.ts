import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "pg";
import { PrismaClient } from "../prisma/generated/provider/index.js";
import { ProviderCanonicalRepository } from "./provider-canonical-repository.ts";
import { initializeProviderDatabaseIdentity } from "./provider-database.ts";

const execFileAsync = promisify(execFile);

export async function postgresBinDirectory(): Promise<string | null> {
  const configured = process.env.PACKSCOUT_TEST_POSTGRES_BIN_DIRECTORY;
  const directories = configured ? [configured] : [
    await execFileAsync("pg_config", ["--bindir"]).then(({ stdout }) => stdout.trim()).catch(() => ""),
    "/opt/homebrew/opt/postgresql@16/bin",
    "/usr/lib/postgresql/16/bin",
  ];
  for (const directory of directories.filter(Boolean)) {
    try {
      await Promise.all([access(join(directory, "initdb")), access(join(directory, "pg_ctl"))]);
      return directory;
    } catch (error) {
      if (configured) throw error;
    }
  }
  return null;
}

/** An isolated socket-only cluster permits the real immutable provider identity. */
export async function createMembershipHarness(binDirectory: string, providerId: string) {
  // /tmp keeps the Unix socket below PostgreSQL's path length limit on macOS.
  const directory = await mkdtemp("/tmp/packscout-membership-test-");
  const dataDirectory = join(directory, "data");
  const pgCtl = join(binDirectory, "pg_ctl");
  const user = "packscout_membership_test";
  let started = false;
  let client: PrismaClient | undefined;
  let admin: Client | undefined;
  async function close() {
    await client?.$disconnect();
    await admin?.end();
    if (started) {
      await execFileAsync(pgCtl, ["stop", "-D", dataDirectory, "-m", "fast", "-w", "-t", "15"]);
      started = false;
    }
    await rm(directory, { recursive: true, force: true });
  }
  try {
    await execFileAsync(join(binDirectory, "initdb"), [
      "-D", dataDirectory, "-A", "trust", "-U", user, "--no-locale", "-E", "UTF8",
    ]);
    await execFileAsync(pgCtl, [
      "start", "-D", dataDirectory, "-l", join(directory, "postgres.log"), "-w", "-t", "15",
      "-o", `-F -k ${directory} -c listen_addresses='' -c unix_socket_permissions=0700`,
    ]);
    started = true;
    admin = new Client({ host: directory, user, database: "postgres", port: 5432 });
    await admin.connect();
    await admin.query('create database "packscout_clutchpacks"');
    // Client.end waits for the socket to close. Pool.end can resolve while an
    // idle backend is still disconnecting, racing the owned cluster shutdown.
    await admin.end();
    admin = undefined;
    const databaseUrl = new URL(`postgresql://${user}@localhost:5432/packscout_clutchpacks`);
    databaseUrl.searchParams.set("host", directory);
    await execFileAsync(process.execPath, [
      fileURLToPath(new URL("../../../node_modules/prisma/build/index.js", import.meta.url)),
      "migrate", "deploy", "--schema",
      fileURLToPath(new URL("../prisma/provider/schema.prisma", import.meta.url)),
    ], { env: { ...process.env, PACKSCOUT_PROVIDER_DATABASE_URL: databaseUrl.toString() } });
    client = new PrismaClient({ datasources: { db: { url: databaseUrl.toString() } } });
    await initializeProviderDatabaseIdentity({ client, providerId, providerKey: "clutchpacks" });
    return { client, repository: new ProviderCanonicalRepository(client), close };
  } catch (error) {
    await close();
    throw error;
  }
}

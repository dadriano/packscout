import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  appendFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { Pool } from "pg";
import {
  CLUTCHPACKS_REVIEW_CLUSTER_MARKER,
  CLUTCHPACKS_REVIEW_CLUSTER_ROOT,
  CLUTCHPACKS_REVIEW_DATABASES,
  ClutchpacksReviewProvisionError,
  assertClusterMarker,
  assertCreateClusterInventory,
  buildClusterMarker,
  type ClutchpacksReviewDatabaseTarget,
  type ClusterMarker,
  type ClusterMarkerState,
} from "./clutchpacks-review-database-plan.mjs";

export const POSTGRES_16_BINARIES = Object.freeze({
  initdb: "/opt/homebrew/opt/postgresql@16/bin/initdb",
  pgControlData: "/opt/homebrew/opt/postgresql@16/bin/pg_controldata",
  pgCtl: "/opt/homebrew/opt/postgresql@16/bin/pg_ctl",
});

const MANAGED_CONFIG_FILE = "packscout-local.conf";
const MANAGED_CONFIG_INCLUDE = `include = '${MANAGED_CONFIG_FILE}'`;
const POSTGRES_LOG_FILE = "packscout-postgres.log";

export interface ClusterFilesystemProof {
  readonly clusterKey: "control" | "clutchpacks";
  readonly dataDirectory: string;
  readonly databaseName: string;
  readonly directoryState: "absent" | "empty" | ClusterMarkerState;
  readonly marker: Readonly<ClusterMarker> | null;
  readonly port: number;
  readonly running: boolean;
  readonly systemIdentifier: string | null;
}

export interface ConnectedClusterProof {
  readonly clusterKey: "control" | "clutchpacks";
  readonly dataDirectory: string;
  readonly databaseName: string;
  readonly databaseRole: "central" | "provider";
  readonly port: number;
  readonly schemaVersion: string;
  readonly systemIdentifier: string;
}

function refuse(code: string): never {
  throw new ClutchpacksReviewProvisionError(code);
}

function childEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: "/opt/homebrew/opt/postgresql@16/bin:/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
  };
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r").catch(() =>
    refuse("CLUSTER_DIRECTORY_SYNC_FAILED")
  );
  try {
    await handle.sync().catch(() => refuse("CLUSTER_DIRECTORY_SYNC_FAILED"));
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function fsyncFile(file: string): Promise<void> {
  const handle = await open(file, "r+").catch(() =>
    refuse("CLUSTER_FILE_SYNC_FAILED")
  );
  try {
    await handle.sync().catch(() => refuse("CLUSTER_FILE_SYNC_FAILED"));
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function privateDirectory(directory: string): Promise<boolean> {
  try {
    const details = await lstat(directory);
    const canonical = await realpath(directory);
    return details.isDirectory() &&
      !details.isSymbolicLink() &&
      canonical === directory &&
      (details.mode & 0o777) === 0o700 &&
      (typeof process.getuid !== "function" || details.uid === process.getuid());
  } catch {
    return false;
  }
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await lstat(value);
    return true;
  } catch (error) {
    if (
      typeof error === "object" && error !== null &&
      "code" in error && error.code === "ENOENT"
    ) return false;
    refuse("CLUSTER_FILESYSTEM_UNAVAILABLE");
  }
}

export async function assertFixedPg16Binaries(): Promise<void> {
  for (const binary of Object.values(POSTGRES_16_BINARIES)) {
    if (!existsSync(binary)) refuse("POSTGRES_16_BINARY_UNAVAILABLE");
  }
  const version = spawnSync(POSTGRES_16_BINARIES.initdb, ["--version"], {
    encoding: "utf8",
    env: childEnvironment(),
    maxBuffer: 16_384,
  });
  if (
    version.error || version.status !== 0 ||
    !/^initdb \(PostgreSQL\) 16\.[0-9]+(?: \(Homebrew\))?\s*$/u.test(
      version.stdout,
    )
  ) {
    refuse("POSTGRES_16_BINARY_UNAVAILABLE");
  }
}

export async function isFixedPortOccupied(port: number): Promise<boolean> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(true);
      else reject(new ClutchpacksReviewProvisionError("CLUSTER_PORT_PROBE_FAILED"));
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => {
        if (error) reject(new ClutchpacksReviewProvisionError("CLUSTER_PORT_PROBE_FAILED"));
        else resolve(false);
      });
    });
  });
}

async function dataDirectoryState(
  cluster: ClutchpacksReviewDatabaseTarget,
): Promise<"absent" | "empty" | "nonempty" | "unsafe"> {
  if (!await pathExists(cluster.dataDirectory)) return "absent";
  if (!await privateDirectory(cluster.dataDirectory)) return "unsafe";
  return (await readdir(cluster.dataDirectory)).length === 0
    ? "empty"
    : "nonempty";
}

export async function assertProvisionClusterLayout(): Promise<void> {
  const fixedParent = path.dirname(CLUTCHPACKS_REVIEW_CLUSTER_ROOT);
  if (!await privateDirectory(fixedParent)) {
    refuse("CLUSTER_PRIVATE_PARENT_REQUIRED");
  }
  const rootExists = await pathExists(CLUTCHPACKS_REVIEW_CLUSTER_ROOT);
  if (rootExists) {
    if (!await privateDirectory(CLUTCHPACKS_REVIEW_CLUSTER_ROOT)) {
      refuse("CLUSTER_PRIVATE_ROOT_REQUIRED");
    }
    const allowed = new Set(["control", "clutchpacks"]);
    const entries = await readdir(CLUTCHPACKS_REVIEW_CLUSTER_ROOT);
    if (entries.some((entry) => !allowed.has(entry))) {
      refuse("CLUSTER_CREATE_TARGET_UNSAFE");
    }
  }
  for (const cluster of [
    CLUTCHPACKS_REVIEW_DATABASES.central,
    CLUTCHPACKS_REVIEW_DATABASES.provider,
  ]) {
    const state = await dataDirectoryState(cluster);
    if (state === "nonempty") {
      const owned = await inspectFixedCluster(cluster);
      if (!owned.running && await isFixedPortOccupied(cluster.port)) {
        refuse("CLUSTER_PORT_OCCUPIED_BY_OTHER_PROCESS");
      }
    } else {
      assertCreateClusterInventory({
        parentPrivate: !rootExists ||
          await privateDirectory(CLUTCHPACKS_REVIEW_CLUSTER_ROOT),
        portOccupied: await isFixedPortOccupied(cluster.port),
        directoryState: state,
      });
    }
  }
}

export async function ensureFixedClusterRoot(): Promise<void> {
  if (!await pathExists(CLUTCHPACKS_REVIEW_CLUSTER_ROOT)) {
    await mkdir(CLUTCHPACKS_REVIEW_CLUSTER_ROOT, { mode: 0o700 });
    await fsyncDirectory(path.dirname(CLUTCHPACKS_REVIEW_CLUSTER_ROOT));
  }
  if (!await privateDirectory(CLUTCHPACKS_REVIEW_CLUSTER_ROOT)) {
    refuse("CLUSTER_PRIVATE_ROOT_REQUIRED");
  }
}

function managedConfiguration(cluster: ClutchpacksReviewDatabaseTarget): string {
  return [
    "# Managed by PackScout local PG16 review-cluster tooling.",
    "listen_addresses = '127.0.0.1'",
    `port = ${cluster.port}`,
    `unix_socket_directories = '${cluster.dataDirectory}'`,
    "ssl = off",
    "password_encryption = 'scram-sha-256'",
    "",
  ].join("\n");
}

async function controlSystemIdentifier(dataDirectory: string): Promise<string> {
  const result = spawnSync(
    POSTGRES_16_BINARIES.pgControlData,
    ["-D", dataDirectory],
    {
      encoding: "utf8",
      env: childEnvironment(),
      maxBuffer: 1_048_576,
    },
  );
  const match = /Database system identifier:\s*([1-9][0-9]*)/u.exec(
    result.stdout ?? "",
  );
  if (result.error || result.status !== 0 || match?.[1] === undefined) {
    refuse("CLUSTER_CONTROL_IDENTITY_UNAVAILABLE");
  }
  return match[1];
}

async function writeMarker(
  cluster: ClutchpacksReviewDatabaseTarget,
  marker: Readonly<ClusterMarker>,
): Promise<void> {
  const markerPath = path.join(cluster.dataDirectory, CLUTCHPACKS_REVIEW_CLUSTER_MARKER);
  const temporaryPath = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(marker)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  }).catch(() => refuse("CLUSTER_MARKER_WRITE_FAILED"));
  const handle = await open(temporaryPath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
  await rename(temporaryPath, markerPath).catch(() =>
    refuse("CLUSTER_MARKER_WRITE_FAILED")
  );
  await fsyncDirectory(cluster.dataDirectory);
}

export async function initializeFixedCluster(
  cluster: ClutchpacksReviewDatabaseTarget,
  clusterAdminPassword: string,
): Promise<Readonly<ClusterMarker>> {
  const state = await dataDirectoryState(cluster);
  if (state === "nonempty") {
    const owned = await inspectFixedCluster(cluster);
    if (owned.marker === null) refuse("CLUSTER_NOT_OWNED");
    return owned.marker;
  }
  if (!["absent", "empty"].includes(state)) {
    refuse("CLUSTER_CREATE_TARGET_UNSAFE");
  }
  const result = spawnSync(
    POSTGRES_16_BINARIES.initdb,
    [
      "-D",
      cluster.dataDirectory,
      `--username=${cluster.clusterAdminRoleName}`,
      "--pwfile=/dev/fd/0",
      "--auth-local=scram-sha-256",
      "--auth-host=scram-sha-256",
      "--encoding=UTF8",
      "--locale=C",
      "--data-checksums",
      "--no-instructions",
    ],
    {
      encoding: "utf8",
      env: childEnvironment(),
      input: `${clusterAdminPassword}\n`,
      maxBuffer: 2 * 1_048_576,
    },
  );
  if (result.error || result.status !== 0) refuse("CLUSTER_INITDB_FAILED");
  if (!await privateDirectory(cluster.dataDirectory)) {
    refuse("CLUSTER_INITIALIZED_DIRECTORY_UNSAFE");
  }
  const version = await readFile(
    path.join(cluster.dataDirectory, "PG_VERSION"),
    "utf8",
  ).catch(() => refuse("CLUSTER_VERSION_PROOF_FAILED"));
  if (version !== "16\n") refuse("CLUSTER_VERSION_PROOF_FAILED");
  const managedConfigPath = path.join(
    cluster.dataDirectory,
    MANAGED_CONFIG_FILE,
  );
  const mainConfigPath = path.join(cluster.dataDirectory, "postgresql.conf");
  await writeFile(
    managedConfigPath,
    managedConfiguration(cluster),
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  ).catch(() => refuse("CLUSTER_CONFIG_WRITE_FAILED"));
  await appendFile(
    mainConfigPath,
    `\n${MANAGED_CONFIG_INCLUDE}\n`,
    { encoding: "utf8" },
  ).catch(() => refuse("CLUSTER_CONFIG_WRITE_FAILED"));
  await fsyncFile(managedConfigPath);
  await fsyncFile(mainConfigPath);
  const systemIdentifier = await controlSystemIdentifier(cluster.dataDirectory);
  const marker = buildClusterMarker(cluster, systemIdentifier, "initialized");
  await writeMarker(cluster, marker);
  return marker;
}

async function readOwnedMarker(
  cluster: ClutchpacksReviewDatabaseTarget,
): Promise<Readonly<ClusterMarker>> {
  const markerPath = path.join(cluster.dataDirectory, CLUTCHPACKS_REVIEW_CLUSTER_MARKER);
  let details;
  try {
    details = await lstat(markerPath);
  } catch {
    refuse("CLUSTER_NOT_OWNED");
  }
  if (
    !details.isFile() || details.isSymbolicLink() ||
    (details.mode & 0o777) !== 0o600 || details.size < 2 || details.size > 4_096 ||
    (typeof process.getuid === "function" && details.uid !== process.getuid())
  ) {
    refuse("CLUSTER_NOT_OWNED");
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(markerPath, "utf8"));
  } catch {
    refuse("CLUSTER_NOT_OWNED");
  }
  const marker = assertClusterMarker(parsed, cluster);
  if (await controlSystemIdentifier(cluster.dataDirectory) !== marker.systemIdentifier) {
    refuse("CLUSTER_SYSTEM_IDENTIFIER_MISMATCH");
  }
  const version = await readFile(
    path.join(cluster.dataDirectory, "PG_VERSION"),
    "utf8",
  ).catch(() => refuse("CLUSTER_VERSION_PROOF_FAILED"));
  const config = await readFile(
    path.join(cluster.dataDirectory, MANAGED_CONFIG_FILE),
    "utf8",
  ).catch(() => refuse("CLUSTER_CONFIG_PROOF_FAILED"));
  const mainConfig = await readFile(
    path.join(cluster.dataDirectory, "postgresql.conf"),
    "utf8",
  ).catch(() => refuse("CLUSTER_CONFIG_PROOF_FAILED"));
  if (
    version !== "16\n" ||
    config !== managedConfiguration(cluster) ||
    mainConfig.split(MANAGED_CONFIG_INCLUDE).length !== 2
  ) {
    refuse("CLUSTER_CONFIG_PROOF_FAILED");
  }
  return marker;
}

function pgCtlRunning(dataDirectory: string): boolean {
  const result = spawnSync(
    POSTGRES_16_BINARIES.pgCtl,
    ["status", "-D", dataDirectory],
    { encoding: "utf8", env: childEnvironment(), maxBuffer: 1_048_576 },
  );
  if (result.error || ![0, 3].includes(result.status ?? -1)) {
    refuse("CLUSTER_STATUS_UNAVAILABLE");
  }
  return result.status === 0;
}

async function assertPostmasterBinding(
  cluster: ClutchpacksReviewDatabaseTarget,
): Promise<void> {
  const lines = (await readFile(
    path.join(cluster.dataDirectory, "postmaster.pid"),
    "utf8",
  ).catch(() => refuse("CLUSTER_POSTMASTER_PROOF_FAILED"))).split("\n");
  if (
    lines[1] !== cluster.dataDirectory ||
    lines[3] !== String(cluster.port)
  ) {
    refuse("CLUSTER_POSTMASTER_PROOF_FAILED");
  }
}

export async function inspectFixedCluster(
  cluster: ClutchpacksReviewDatabaseTarget,
): Promise<Readonly<ClusterFilesystemProof>> {
  const state = await dataDirectoryState(cluster);
  if (state === "absent" || state === "empty") {
    return Object.freeze({
      clusterKey: cluster.clusterKey,
      dataDirectory: cluster.dataDirectory,
      databaseName: cluster.databaseName,
      directoryState: state,
      marker: null,
      port: cluster.port,
      running: false,
      systemIdentifier: null,
    });
  }
  if (state !== "nonempty") refuse("CLUSTER_NOT_OWNED");
  const marker = await readOwnedMarker(cluster);
  const running = pgCtlRunning(cluster.dataDirectory);
  if (running) await assertPostmasterBinding(cluster);
  return Object.freeze({
    clusterKey: cluster.clusterKey,
    dataDirectory: cluster.dataDirectory,
    databaseName: cluster.databaseName,
    directoryState: marker.state,
    marker,
    port: cluster.port,
    running,
    systemIdentifier: marker.systemIdentifier,
  });
}

export async function startFixedCluster(
  cluster: ClutchpacksReviewDatabaseTarget,
): Promise<Readonly<ClusterFilesystemProof>> {
  const before = await inspectFixedCluster(cluster);
  if (before.marker === null) refuse("CLUSTER_NOT_INITIALIZED");
  if (!before.running) {
    if (await isFixedPortOccupied(cluster.port)) {
      refuse("CLUSTER_PORT_OCCUPIED_BY_OTHER_PROCESS");
    }
    const result = spawnSync(
      POSTGRES_16_BINARIES.pgCtl,
      [
        "-D",
        cluster.dataDirectory,
        "-l",
        path.join(cluster.dataDirectory, POSTGRES_LOG_FILE),
        "-w",
        "-t",
        "30",
        "start",
      ],
      { encoding: "utf8", env: childEnvironment(), maxBuffer: 2 * 1_048_576 },
    );
    if (result.error || result.status !== 0) refuse("CLUSTER_START_FAILED");
  }
  const after = await inspectFixedCluster(cluster);
  if (!after.running) refuse("CLUSTER_START_FAILED");
  return after;
}

export async function stopFixedCluster(
  cluster: ClutchpacksReviewDatabaseTarget,
): Promise<Readonly<ClusterFilesystemProof>> {
  const before = await inspectFixedCluster(cluster);
  if (before.marker === null) refuse("CLUSTER_NOT_INITIALIZED");
  if (before.running) {
    const result = spawnSync(
      POSTGRES_16_BINARIES.pgCtl,
      ["-D", cluster.dataDirectory, "-w", "-t", "30", "stop", "-m", "fast"],
      { encoding: "utf8", env: childEnvironment(), maxBuffer: 2 * 1_048_576 },
    );
    if (result.error || result.status !== 0) refuse("CLUSTER_STOP_FAILED");
  }
  const after = await inspectFixedCluster(cluster);
  if (after.running) refuse("CLUSTER_STOP_FAILED");
  return after;
}

export function clusterDatabaseUrl(input: {
  readonly cluster: ClutchpacksReviewDatabaseTarget;
  readonly username: string;
  readonly password: string;
  readonly databaseName?: string;
}): string {
  const url = new URL(
    `postgresql://127.0.0.1:${input.cluster.port}/${
      input.databaseName ?? input.cluster.databaseName
    }`,
  );
  url.username = input.username;
  url.password = input.password;
  return url.toString();
}

export function clusterMigrationUrl(input: {
  readonly cluster: ClutchpacksReviewDatabaseTarget;
  readonly clusterAdminPassword: string;
}): string {
  const url = new URL(clusterDatabaseUrl({
    cluster: input.cluster,
    username: input.cluster.clusterAdminRoleName,
    password: input.clusterAdminPassword,
  }));
  url.searchParams.set("options", `-c role=${input.cluster.ownerRoleName}`);
  return url.toString();
}

export async function readConnectedClusterProof(input: {
  readonly cluster: ClutchpacksReviewDatabaseTarget;
  readonly appPassword: string;
}): Promise<Readonly<ConnectedClusterProof>> {
  const filesystem = await inspectFixedCluster(input.cluster);
  if (!filesystem.running || filesystem.marker?.state !== "provisioned") {
    refuse("CLUSTER_NOT_READY");
  }
  const pool = new Pool({
    connectionString: clusterDatabaseUrl({
      cluster: input.cluster,
      username: input.cluster.appRoleName,
      password: input.appPassword,
    }),
    connectionTimeoutMillis: 2_000,
    max: 1,
  });
  try {
    const connection = await pool.query<{
      app_is_owner_member: boolean;
      app_connect_databases: string[];
      current_database: string;
      current_role: string;
      port: number;
      server_address: string;
      system_identifier: string;
    }>(`
      select current_database(), current_user as current_role,
             host(inet_server_addr()) as server_address,
             inet_server_port() as port,
             (pg_control_system()).system_identifier::text as system_identifier,
             pg_has_role(current_user, $1, 'MEMBER') as app_is_owner_member,
             array(
               select database.datname::text
               from pg_catalog.pg_database database
               where has_database_privilege(current_user, database.datname, 'CONNECT')
               order by database.datname
             ) as app_connect_databases
    `, [input.cluster.ownerRoleName]);
    const identity = await pool.query<{
      database_role: "central" | "provider";
      provider_key: string | null;
      schema_version: string;
    }>(`
      select database_role, provider_key, schema_version
      from public.database_identity where singleton_key = true
    `);
    const roles = await pool.query<{
      rolcanlogin: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolname: string;
      rolsuper: boolean;
    }>(`
      select rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole
      from pg_catalog.pg_roles
      where rolname !~ '^pg_'
      order by rolname
    `);
    const databases = await pool.query<{
      datallowconn: boolean;
      datname: string;
      owner_name: string;
    }>(`
      select datname, datallowconn, pg_catalog.pg_get_userbyid(datdba) as owner_name
      from pg_catalog.pg_database order by datname
    `);
    const row = connection.rows[0];
    const identityRow = identity.rows[0];
    const expectedDatabaseRole = input.cluster.clusterKey === "control"
      ? "central"
      : "provider";
    const expectedProviderKey = input.cluster.clusterKey === "control"
      ? null
      : "clutchpacks";
    const expectedRoles = [
      {
        rolname: input.cluster.appRoleName,
        rolcanlogin: true,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
      },
      {
        rolname: input.cluster.clusterAdminRoleName,
        rolcanlogin: true,
        rolsuper: true,
        rolcreatedb: true,
        rolcreaterole: true,
      },
      {
        rolname: input.cluster.ownerRoleName,
        rolcanlogin: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
      },
    ].sort((left, right) => left.rolname.localeCompare(right.rolname));
    const expectedDatabases = [
      {
        datname: input.cluster.databaseName,
        datallowconn: true,
        owner_name: input.cluster.ownerRoleName,
      },
      {
        datname: "postgres",
        datallowconn: true,
        owner_name: input.cluster.clusterAdminRoleName,
      },
      {
        datname: "template0",
        datallowconn: false,
        owner_name: input.cluster.clusterAdminRoleName,
      },
      {
        datname: "template1",
        datallowconn: true,
        owner_name: input.cluster.clusterAdminRoleName,
      },
    ].sort((left, right) => left.datname.localeCompare(right.datname));
    if (
      connection.rows.length !== 1 ||
      row?.current_database !== input.cluster.databaseName ||
      row.current_role !== input.cluster.appRoleName ||
      row.server_address !== "127.0.0.1" ||
      row.port !== input.cluster.port ||
      row.system_identifier !== filesystem.systemIdentifier ||
      row.app_is_owner_member ||
      JSON.stringify(row.app_connect_databases) !==
        JSON.stringify([input.cluster.databaseName]) ||
      identity.rows.length !== 1 ||
      identityRow?.database_role !== expectedDatabaseRole ||
      identityRow.schema_version !== input.cluster.schemaVersion ||
      identityRow.provider_key !== expectedProviderKey ||
      JSON.stringify(roles.rows) !== JSON.stringify(expectedRoles) ||
      JSON.stringify(databases.rows) !== JSON.stringify(expectedDatabases)
    ) {
      refuse("CLUSTER_CONNECTED_PROOF_FAILED");
    }
    return Object.freeze({
      clusterKey: input.cluster.clusterKey,
      dataDirectory: input.cluster.dataDirectory,
      databaseName: input.cluster.databaseName,
      databaseRole: expectedDatabaseRole,
      port: input.cluster.port,
      schemaVersion: identityRow.schema_version,
      systemIdentifier: row.system_identifier,
    });
  } catch (error) {
    if (error instanceof ClutchpacksReviewProvisionError) throw error;
    refuse("CLUSTER_CONNECTED_PROOF_FAILED");
  } finally {
    await pool.end().catch(() => undefined);
  }
}

export async function markFixedClusterProvisioned(
  cluster: ClutchpacksReviewDatabaseTarget,
): Promise<void> {
  const marker = await readOwnedMarker(cluster);
  await writeMarker(
    cluster,
    buildClusterMarker(cluster, marker.systemIdentifier, "provisioned"),
  );
}

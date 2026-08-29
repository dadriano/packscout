#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { lstat, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { createNodePasswordHasher } from
  "../../apps/admin/server/auth/crypto.ts";
import { directProvisionOperatorRequestSchema } from
  "../../packages/contracts/src/auth.ts";
import { AesGcmProviderCredentialCipher } from
  "../../packages/services/src/provider-credential-cipher.ts";
import {
  CLUTCHPACKS_REVIEW_DATABASES,
  ClutchpacksReviewProvisionError,
  assertCreateOnlyInventory,
  assertNoClutchpacksProvisionArguments,
  assertProvisionedReviewInventory,
  assertRebuildRoleInventory,
  assertVerifiedBackupProofs,
  buildClutchpacksProvisionPlan,
  readClutchpacksProvisionEnvironment,
  safeClutchpacksProvisionFailure,
} from "./clutchpacks-review-database-plan.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const migrationFiles = Object.freeze({
  central: path.join(
    repositoryRoot,
    "packages/database/prisma/central/migrations",
    CLUTCHPACKS_REVIEW_DATABASES.central.migrationName,
    "migration.sql",
  ),
  provider: path.join(
    repositoryRoot,
    "packages/database/prisma/provider/migrations",
    CLUTCHPACKS_REVIEW_DATABASES.provider.migrationName,
    "migration.sql",
  ),
});
const schemaFiles = Object.freeze({
  central: path.join(
    repositoryRoot,
    "packages/database/prisma/central/schema.prisma",
  ),
  provider: path.join(
    repositoryRoot,
    "packages/database/prisma/provider/schema.prisma",
  ),
});
const prismaExecutable = path.join(
  repositoryRoot,
  "node_modules/prisma/build/index.js",
);
const pgDumpExecutable = [
  "/opt/homebrew/opt/postgresql@16/bin/pg_dump",
  "/usr/local/opt/postgresql@16/bin/pg_dump",
].find((candidate) => existsSync(candidate));

interface DatabaseInventory {
  readonly databaseName: string;
  readonly exists: boolean;
  readonly owner: string | null;
  readonly tableCount: number | null;
  readonly migrationState:
    | "absent"
    | "missing"
    | "ready"
    | "checksum_mismatch"
    | "unexpected";
  readonly identityState: "absent" | "ready" | "unexpected";
}

interface RoleInventory {
  readonly roleName: string;
  readonly exists: boolean;
  readonly login: boolean;
  readonly superuser: boolean;
  readonly createRole: boolean;
  readonly createDatabase: boolean;
  readonly replication: boolean;
  readonly bypassRls: boolean;
  readonly membershipCount: number;
  readonly foreignOwnedDatabaseCount: number;
}

interface ReviewInventory {
  readonly postgresMajorVersion: number;
  readonly adminIsSuperuser: boolean;
  readonly databases: readonly DatabaseInventory[];
  readonly roles: readonly RoleInventory[];
}

function refuse(code: string): never {
  throw new ClutchpacksReviewProvisionError(code);
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(value)) {
    refuse("POSTGRES_IDENTIFIER_INVALID");
  }
  return `"${value}"`;
}

function quoteLiteral(value: string): string {
  if (value.includes("\0") || /[\r\n]/u.test(value)) {
    refuse("PROVISION_CREDENTIAL_INVALID");
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function databaseUrl(input: {
  readonly adminUrl: string;
  readonly databaseName: string;
  readonly username?: string;
  readonly password?: string;
}): string {
  const url = new URL(input.adminUrl);
  url.pathname = `/${input.databaseName}`;
  url.search = "";
  url.hash = "";
  if (input.username !== undefined) url.username = input.username;
  if (input.password !== undefined) url.password = input.password;
  return url.toString();
}

function migrationOwnerUrl(input: {
  readonly adminUrl: string;
  readonly databaseName: string;
  readonly ownerRoleName: string;
}): string {
  const url = new URL(databaseUrl({
    adminUrl: input.adminUrl,
    databaseName: input.databaseName,
  }));
  url.searchParams.set("options", `-c role=${input.ownerRoleName}`);
  return url.toString();
}

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function databaseInventory(input: {
  readonly adminUrl: string;
  readonly databaseName: string;
  readonly owner: string | null;
  readonly expectedMigration: string;
  readonly expectedChecksum: string;
  readonly expectedRole: "central" | "provider";
  readonly expectedSchemaVersion: string;
  readonly expectedProviderKey: string | null;
}): Promise<DatabaseInventory> {
  if (input.owner === null) {
    return {
      databaseName: input.databaseName,
      exists: false,
      owner: null,
      tableCount: null,
      migrationState: "absent",
      identityState: "absent",
    };
  }
  const pool = new Pool({
    connectionString: databaseUrl({
      adminUrl: input.adminUrl,
      databaseName: input.databaseName,
    }),
    connectionTimeoutMillis: 2_000,
    max: 1,
  });
  try {
    const tableResult = await pool.query<{ table_count: string }>(`
      select count(*)::text as table_count
      from information_schema.tables
      where table_schema = 'public'
    `);
    const relationResult = await pool.query<{ migration_table: string | null; identity_table: string | null }>(`
      select to_regclass('public._prisma_migrations')::text as migration_table,
             to_regclass('public.database_identity')::text as identity_table
    `);
    let migrationState: DatabaseInventory["migrationState"] = "missing";
    if (relationResult.rows[0]?.migration_table !== null) {
      const migrations = await pool.query<{
        checksum: string;
        migration_name: string;
        finished: boolean;
        rolled_back: boolean;
      }>(`
        select checksum, migration_name,
               finished_at is not null as finished,
               rolled_back_at is not null as rolled_back
        from public._prisma_migrations
        order by started_at
      `);
      if (
        migrations.rows.length === 1 &&
        migrations.rows[0]?.migration_name === input.expectedMigration &&
        migrations.rows[0]?.finished &&
        !migrations.rows[0]?.rolled_back
      ) {
        migrationState = migrations.rows[0].checksum === input.expectedChecksum
          ? "ready"
          : "checksum_mismatch";
      } else {
        migrationState = "unexpected";
      }
    }
    let identityState: DatabaseInventory["identityState"] = "absent";
    if (relationResult.rows[0]?.identity_table !== null) {
      const identity = await pool.query<{
        database_role: string;
        schema_version: string;
        provider_key: string | null;
      }>(`
        select database_role, schema_version, provider_key
        from public.database_identity
        where singleton_key = true
      `);
      identityState = identity.rows.length === 1 &&
          identity.rows[0]?.database_role === input.expectedRole &&
          identity.rows[0]?.schema_version === input.expectedSchemaVersion &&
          identity.rows[0]?.provider_key === input.expectedProviderKey
        ? "ready"
        : "unexpected";
    }
    return {
      databaseName: input.databaseName,
      exists: true,
      owner: input.owner,
      tableCount: Number(tableResult.rows[0]?.table_count ?? "0"),
      migrationState,
      identityState,
    };
  } catch {
    refuse("DATABASE_INVENTORY_UNAVAILABLE");
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function readInventory(
  admin: Pool,
  adminUrl: string,
): Promise<ReviewInventory> {
  const version = await admin.query<{ server_version_num: string }>(
    "show server_version_num",
  );
  const adminRole = await admin.query<{ rolsuper: boolean }>(`
    select role.rolsuper
    from pg_catalog.pg_roles as role
    where role.rolname = current_user
  `);
  const postgresMajorVersion = Math.floor(
    Number(version.rows[0]?.server_version_num ?? "0") / 10_000,
  );
  const databaseNames = [
    CLUTCHPACKS_REVIEW_DATABASES.central.databaseName,
    CLUTCHPACKS_REVIEW_DATABASES.provider.databaseName,
  ];
  const roleNames = [
    CLUTCHPACKS_REVIEW_DATABASES.central.ownerRoleName,
    CLUTCHPACKS_REVIEW_DATABASES.central.appRoleName,
    CLUTCHPACKS_REVIEW_DATABASES.provider.ownerRoleName,
    CLUTCHPACKS_REVIEW_DATABASES.provider.appRoleName,
  ];
  const databaseRows = await admin.query<{ datname: string; owner: string }>(`
    select database.datname, pg_catalog.pg_get_userbyid(database.datdba) as owner
    from pg_catalog.pg_database as database
    where database.datname = any($1::text[])
  `, [databaseNames]);
  const ownerByDatabase = new Map(
    databaseRows.rows.map((row) => [row.datname, row.owner]),
  );
  const expectedChecksums = {
    central: await sha256(migrationFiles.central),
    provider: await sha256(migrationFiles.provider),
  };
  const databases = await Promise.all([
    databaseInventory({
      adminUrl,
      databaseName: CLUTCHPACKS_REVIEW_DATABASES.central.databaseName,
      owner: ownerByDatabase.get(CLUTCHPACKS_REVIEW_DATABASES.central.databaseName) ?? null,
      expectedMigration: CLUTCHPACKS_REVIEW_DATABASES.central.migrationName,
      expectedChecksum: expectedChecksums.central,
      expectedRole: "central",
      expectedSchemaVersion: CLUTCHPACKS_REVIEW_DATABASES.central.schemaVersion,
      expectedProviderKey: null,
    }),
    databaseInventory({
      adminUrl,
      databaseName: CLUTCHPACKS_REVIEW_DATABASES.provider.databaseName,
      owner: ownerByDatabase.get(CLUTCHPACKS_REVIEW_DATABASES.provider.databaseName) ?? null,
      expectedMigration: CLUTCHPACKS_REVIEW_DATABASES.provider.migrationName,
      expectedChecksum: expectedChecksums.provider,
      expectedRole: "provider",
      expectedSchemaVersion: CLUTCHPACKS_REVIEW_DATABASES.provider.schemaVersion,
      expectedProviderKey: CLUTCHPACKS_REVIEW_DATABASES.provider.providerKey,
    }),
  ]);
  const rolesResult = await admin.query<{
    rolname: string;
    rolcanlogin: boolean;
    rolsuper: boolean;
    rolcreaterole: boolean;
    rolcreatedb: boolean;
    rolreplication: boolean;
    rolbypassrls: boolean;
    membership_count: string;
    foreign_owned_database_count: string;
  }>(`
    select role.rolname, role.rolcanlogin, role.rolsuper,
           role.rolcreaterole, role.rolcreatedb,
           role.rolreplication, role.rolbypassrls,
           (select count(*) from pg_catalog.pg_auth_members membership
             where membership.roleid = role.oid or membership.member = role.oid)::text
             as membership_count,
           (select count(*) from pg_catalog.pg_database owned
             where owned.datdba = role.oid
               and not (owned.datname = any($2::text[])))::text
             as foreign_owned_database_count
    from pg_catalog.pg_roles as role
    where role.rolname = any($1::text[])
  `, [roleNames, databaseNames]);
  const roleByName = new Map(rolesResult.rows.map((row) => [row.rolname, row]));
  const roles: RoleInventory[] = roleNames.map((roleName) => {
    const row = roleByName.get(roleName);
    return {
      roleName,
      exists: row !== undefined,
      login: row?.rolcanlogin ?? false,
      superuser: row?.rolsuper ?? false,
      createRole: row?.rolcreaterole ?? false,
      createDatabase: row?.rolcreatedb ?? false,
      replication: row?.rolreplication ?? false,
      bypassRls: row?.rolbypassrls ?? false,
      membershipCount: Number(row?.membership_count ?? "0"),
      foreignOwnedDatabaseCount: Number(row?.foreign_owned_database_count ?? "0"),
    };
  });
  return Object.freeze({
    postgresMajorVersion,
    adminIsSuperuser: adminRole.rows[0]?.rolsuper === true,
    databases,
    roles,
  });
}

function recommendation(inventory: ReviewInventory): string {
  if (
    inventory.databases.every((database) => !database.exists) &&
    inventory.roles.every((role) => !role.exists)
  ) return "create";
  try {
    assertProvisionedReviewInventory(inventory);
    return "ready";
  } catch {
    // Inspect mode reports drift; it never relaxes a failed topology proof.
  }
  return "rebuild_required";
}

function migrate(input: {
  readonly databaseUrl: string;
  readonly role: "central" | "provider";
}): void {
  const environmentKey = input.role === "central"
    ? "PACKSCOUT_CENTRAL_DATABASE_URL"
    : "PACKSCOUT_PROVIDER_DATABASE_URL";
  const result = spawnSync(
    process.execPath,
    [prismaExecutable, "migrate", "deploy", "--schema", schemaFiles[input.role]],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        NODE_ENV: "development",
        PRISMA_HIDE_UPDATE_MESSAGE: "1",
        [environmentKey]: input.databaseUrl,
      },
      maxBuffer: 2 * 1_048_576,
    },
  );
  if (result.error || result.status !== 0) refuse("PRISMA_MIGRATION_FAILED");
}

async function fileSha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function assertPrivateBackupDirectory(directory: string): Promise<void> {
  let details;
  try {
    details = await lstat(directory);
  } catch {
    refuse("REBUILD_BACKUP_DIRECTORY_UNAVAILABLE");
  }
  if (
    !details.isDirectory() ||
    details.isSymbolicLink() ||
    (details.mode & 0o777) !== 0o700 ||
    (typeof process.getuid === "function" && details.uid !== process.getuid())
  ) {
    refuse("REBUILD_BACKUP_DIRECTORY_NOT_PRIVATE");
  }
}

async function backupExistingTargets(input: {
  readonly adminUrl: string;
  readonly backupDirectory: string;
  readonly inventory: ReviewInventory;
}): Promise<readonly Readonly<{
  databaseName: string;
  path: string;
  bytes: number;
  sha256: string;
}>[]> {
  if (pgDumpExecutable === undefined) refuse("PG_DUMP_16_UNAVAILABLE");
  await assertPrivateBackupDirectory(input.backupDirectory);
  const adminUrl = new URL(input.adminUrl);
  const proofs = [];
  const directoryHandle = await open(input.backupDirectory, "r").catch(() =>
    refuse("REBUILD_BACKUP_DIRECTORY_UNAVAILABLE")
  );
  try {
    for (const database of input.inventory.databases) {
      if (!database.exists) continue;
      const timestamp = new Date().toISOString().replaceAll(/[-:.]/gu, "");
      const file = path.join(
        input.backupDirectory,
        `${database.databaseName}-before-rebuild-${timestamp}-${randomUUID()}.dump`,
      );
      const handle = await open(file, "wx", 0o600).catch(() =>
        refuse("REBUILD_BACKUP_CREATE_FAILED")
      );
      let succeeded = false;
      let handleClosed = false;
      try {
        const result = spawnSync(
          pgDumpExecutable,
          ["--format=custom", "--no-owner", "--no-privileges"],
          {
            stdio: ["ignore", handle.fd, "pipe"],
            env: {
              PATH: process.env.PATH,
              PGHOST: adminUrl.hostname.replace(/^\[|\]$/gu, ""),
              PGPORT: adminUrl.port || "5432",
              PGUSER: decodeURIComponent(adminUrl.username),
              PGPASSWORD: decodeURIComponent(adminUrl.password),
              PGDATABASE: database.databaseName,
              PGSSLMODE: "disable",
            },
            maxBuffer: 1_048_576,
          },
        );
        if (result.error || result.status !== 0) {
          refuse("REBUILD_BACKUP_FAILED");
        }
        await handle.sync();
        const details = await handle.stat();
        if (
          !details.isFile() ||
          details.size < 1 ||
          (details.mode & 0o777) !== 0o600 ||
          (typeof process.getuid === "function" &&
            details.uid !== process.getuid())
        ) {
          refuse("REBUILD_BACKUP_PROOF_INVALID");
        }
        await handle.close();
        handleClosed = true;
        await directoryHandle.sync().catch(() =>
          refuse("REBUILD_BACKUP_DIRECTORY_SYNC_FAILED")
        );
        proofs.push(Object.freeze({
          databaseName: database.databaseName,
          path: file,
          bytes: details.size,
          sha256: await fileSha256(file),
        }));
        succeeded = true;
      } finally {
        if (!handleClosed) await handle.close().catch(() => undefined);
        if (!succeeded) await unlink(file).catch(() => undefined);
      }
    }
  } finally {
    await directoryHandle.close().catch(() => undefined);
  }
  return Object.freeze(proofs);
}

async function dropExactTargets(admin: Pool): Promise<void> {
  for (const databaseName of [
    CLUTCHPACKS_REVIEW_DATABASES.provider.databaseName,
    CLUTCHPACKS_REVIEW_DATABASES.central.databaseName,
  ]) {
    await admin.query(
      `drop database if exists ${quoteIdentifier(databaseName)} with (force)`,
    );
  }
  for (const roleName of [
    CLUTCHPACKS_REVIEW_DATABASES.provider.appRoleName,
    CLUTCHPACKS_REVIEW_DATABASES.provider.ownerRoleName,
    CLUTCHPACKS_REVIEW_DATABASES.central.appRoleName,
    CLUTCHPACKS_REVIEW_DATABASES.central.ownerRoleName,
  ]) {
    await admin.query(`drop role if exists ${quoteIdentifier(roleName)}`);
  }
}

async function createExactTargets(input: {
  readonly admin: Pool;
  readonly centralPassword: string;
  readonly providerPassword: string;
}): Promise<void> {
  for (const roleName of [
    CLUTCHPACKS_REVIEW_DATABASES.central.ownerRoleName,
    CLUTCHPACKS_REVIEW_DATABASES.provider.ownerRoleName,
  ]) {
    await input.admin.query(`
      create role ${quoteIdentifier(roleName)}
      nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls
    `);
  }
  for (const [roleName, password] of [
    [
      CLUTCHPACKS_REVIEW_DATABASES.central.appRoleName,
      input.centralPassword,
    ],
    [
      CLUTCHPACKS_REVIEW_DATABASES.provider.appRoleName,
      input.providerPassword,
    ],
  ] as const) {
    await input.admin.query(`
      create role ${quoteIdentifier(roleName)}
      login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls
      password ${quoteLiteral(password)}
    `);
  }
  for (const [databaseName, ownerRoleName, appRoleName] of [
    [
      CLUTCHPACKS_REVIEW_DATABASES.central.databaseName,
      CLUTCHPACKS_REVIEW_DATABASES.central.ownerRoleName,
      CLUTCHPACKS_REVIEW_DATABASES.central.appRoleName,
    ],
    [
      CLUTCHPACKS_REVIEW_DATABASES.provider.databaseName,
      CLUTCHPACKS_REVIEW_DATABASES.provider.ownerRoleName,
      CLUTCHPACKS_REVIEW_DATABASES.provider.appRoleName,
    ],
  ] as const) {
    await input.admin.query(`
      create database ${quoteIdentifier(databaseName)}
      owner ${quoteIdentifier(ownerRoleName)} encoding 'UTF8' template template0
    `);
    await input.admin.query(`
      revoke connect on database ${quoteIdentifier(databaseName)} from public
    `);
    await input.admin.query(`
      grant connect on database ${quoteIdentifier(databaseName)}
      to ${quoteIdentifier(appRoleName)}
    `);
  }
}

async function grantRuntimeAccess(input: {
  readonly adminUrl: string;
  readonly databaseName: string;
  readonly ownerRoleName: string;
  readonly appRoleName: string;
  readonly provider: boolean;
}): Promise<void> {
  const pool = new Pool({
    connectionString: databaseUrl({
      adminUrl: input.adminUrl,
      databaseName: input.databaseName,
    }),
    max: 1,
  });
  try {
    await pool.query(`grant usage on schema public to ${quoteIdentifier(input.appRoleName)}`);
    await pool.query(`
      grant select, insert, update, delete on all tables in schema public
      to ${quoteIdentifier(input.appRoleName)}
    `);
    await pool.query(`
      grant usage, select, update on all sequences in schema public
      to ${quoteIdentifier(input.appRoleName)}
    `);
    await pool.query(`
      alter default privileges for role ${quoteIdentifier(input.ownerRoleName)}
      in schema public grant select, insert, update, delete on tables
      to ${quoteIdentifier(input.appRoleName)}
    `);
    await pool.query(`
      alter default privileges for role ${quoteIdentifier(input.ownerRoleName)}
      in schema public grant usage, select, update on sequences
      to ${quoteIdentifier(input.appRoleName)}
    `);
    await pool.query(`
      revoke insert, update, delete on table public.database_identity
      from ${quoteIdentifier(input.appRoleName)}
    `);
    await pool.query(`
      revoke insert, update, delete on table public._prisma_migrations
      from ${quoteIdentifier(input.appRoleName)}
    `);
    if (input.provider) {
      await pool.query(`
        revoke all on function
          public.initialize_provider_database_identity(uuid, text)
        from public, ${quoteIdentifier(input.appRoleName)}
      `);
    }
  } catch {
    refuse("RUNTIME_ROLE_GRANT_FAILED");
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function initializeProviderIdentity(input: {
  readonly databaseUrl: string;
  readonly providerId: string;
}): Promise<void> {
  const pool = new Pool({ connectionString: input.databaseUrl, max: 1 });
  try {
    await pool.query(
      "select public.initialize_provider_database_identity($1::uuid, $2::text)",
      [input.providerId, CLUTCHPACKS_REVIEW_DATABASES.provider.providerKey],
    );
  } catch {
    refuse("PROVIDER_IDENTITY_INITIALIZATION_FAILED");
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function expectProviderInitializerDenied(
  providerUrl: string,
): Promise<void> {
  const pool = new Pool({ connectionString: providerUrl, max: 1 });
  try {
    const identity = await pool.query<{
      database_name: string;
      role_name: string;
      may_initialize: boolean;
    }>(`
      select current_database() as database_name,
             current_user as role_name,
             has_function_privilege(
               current_user,
               'public.initialize_provider_database_identity(uuid, text)',
               'EXECUTE'
             ) as may_initialize
    `);
    if (
      identity.rows.length !== 1 ||
      identity.rows[0]?.database_name !==
        CLUTCHPACKS_REVIEW_DATABASES.provider.databaseName ||
      identity.rows[0].role_name !==
        CLUTCHPACKS_REVIEW_DATABASES.provider.appRoleName ||
      identity.rows[0].may_initialize
    ) {
      refuse("PROVIDER_INITIALIZER_PERMISSION_PROOF_FAILED");
    }
    await pool.query(
      "select public.initialize_provider_database_identity($1::uuid, $2::text)",
      [randomUUID(), CLUTCHPACKS_REVIEW_DATABASES.provider.providerKey],
    );
  } catch (error) {
    if (
      typeof error === "object" && error !== null &&
      "code" in error && error.code === "42501"
    ) {
      return;
    }
    refuse("PROVIDER_INITIALIZER_PERMISSION_PROOF_FAILED");
  } finally {
    await pool.end().catch(() => undefined);
  }
  refuse("PROVIDER_INITIALIZER_PERMISSION_PROOF_FAILED");
}

async function expectConnectionDenied(databaseUrlValue: string): Promise<void> {
  const pool = new Pool({
    connectionString: databaseUrlValue,
    connectionTimeoutMillis: 1_000,
    max: 1,
  });
  try {
    await pool.query("select 1");
  } catch {
    return;
  } finally {
    await pool.end().catch(() => undefined);
  }
  refuse("DATABASE_ROLE_ISOLATION_FAILED");
}

async function verifyRoleIsolation(input: {
  readonly adminUrl: string;
  readonly centralPassword: string;
  readonly providerPassword: string;
}): Promise<void> {
  await Promise.all([
    expectConnectionDenied(databaseUrl({
      adminUrl: input.adminUrl,
      databaseName: CLUTCHPACKS_REVIEW_DATABASES.provider.databaseName,
      username: CLUTCHPACKS_REVIEW_DATABASES.central.appRoleName,
      password: input.centralPassword,
    })),
    expectConnectionDenied(databaseUrl({
      adminUrl: input.adminUrl,
      databaseName: CLUTCHPACKS_REVIEW_DATABASES.central.databaseName,
      username: CLUTCHPACKS_REVIEW_DATABASES.provider.appRoleName,
      password: input.providerPassword,
    })),
  ]);
}

async function registerCentralMetadata(input: {
  readonly centralUrl: string;
  readonly providerPassword: string;
  readonly bootstrap: {
    readonly organizationSlug: string;
    readonly organizationName: string;
    readonly adminEmail: string;
    readonly adminDisplayName: string;
    readonly adminPassword: string;
  };
  readonly credentialKey: { readonly bytes: Uint8Array; readonly version: number };
  readonly host: string;
  readonly port: number;
  readonly ids: ReturnType<typeof createProvisionIds>;
}): Promise<void> {
  const account = directProvisionOperatorRequestSchema.safeParse({
    email: input.bootstrap.adminEmail,
    displayName: input.bootstrap.adminDisplayName,
    password: input.bootstrap.adminPassword,
    role: "admin",
  });
  if (!account.success) refuse("BOOTSTRAP_ADMIN_INPUT_INVALID");
  const passwordHash = await createNodePasswordHasher().hash(
    account.data.password,
  );
  const encryptedDatabaseCredential = new AesGcmProviderCredentialCipher({
    primaryVersion: input.credentialKey.version,
    keys: new Map([[input.credentialKey.version, input.credentialKey.bytes]]),
  }).encrypt(
    JSON.stringify({
      username: CLUTCHPACKS_REVIEW_DATABASES.provider.appRoleName,
      password: input.providerPassword,
    }),
    {
      organizationId: input.ids.organizationId,
      providerId: input.ids.providerId,
      revisionId: input.ids.databaseCredentialVersionId,
    },
  );
  const central = new Pool({ connectionString: input.centralUrl, max: 1 });
  const client = await central.connect();
  try {
    await client.query("begin");
    const now = new Date();
    await client.query(`
      insert into organizations (id, slug, name, created_at)
      values ($1::uuid, $2, $3, $4)
    `, [
      input.ids.organizationId,
      input.bootstrap.organizationSlug,
      input.bootstrap.organizationName,
      now,
    ]);
    await client.query(`
      insert into operators (
        id, email_normalized, display_name, password_hash, state,
        row_version, created_at, updated_at
      ) values ($1::uuid, $2, $3, $4, 'active', 1, $5, $5)
    `, [
      input.ids.operatorId,
      account.data.email,
      account.data.displayName,
      passwordHash,
      now,
    ]);
    await client.query(`
      insert into operator_memberships (
        id, organization_id, operator_id, role, created_at, updated_at
      ) values ($1::uuid, $2::uuid, $3::uuid, 'admin', $4, $4)
    `, [
      input.ids.membershipId,
      input.ids.organizationId,
      input.ids.operatorId,
      now,
    ]);
    await client.query(`
      insert into providers (
        id, organization_id, provider_key, display_name, lifecycle,
        topology_version, row_version, created_at, updated_at
      ) values ($1::uuid, $2::uuid, $3, 'ClutchPacks', 'draft', 1, 1, $4, $4)
    `, [
      input.ids.providerId,
      input.ids.organizationId,
      CLUTCHPACKS_REVIEW_DATABASES.provider.providerKey,
      now,
    ]);
    await client.query(`
      insert into provider_config_versions (
        id, provider_id, version_number, adapter_key, endpoint_url,
        source_credential_version_id, schedule_seconds, stale_after_seconds,
        configuration, expires_at, created_by_operator_id, created_at
      ) values (
        $1::uuid, $2::uuid, 1, $3, 'https://clutchpacks.local.invalid/capture',
        null, 3600, 86400, $4::jsonb, null, $5::uuid, $6
      )
    `, [
      input.ids.configVersionId,
      input.ids.providerId,
      CLUTCHPACKS_REVIEW_DATABASES.provider.adapterKey,
      JSON.stringify({
        adapterKey: CLUTCHPACKS_REVIEW_DATABASES.provider.adapterKey,
      }),
      input.ids.operatorId,
      now,
    ]);
    await client.query(`
      insert into provider_credential_versions (
        id, provider_id, credential_kind, version_number, ciphertext,
        nonce, auth_tag, key_version, lifecycle, activated_at, created_at
      ) values (
        $1::uuid, $2::uuid, 'database', 1, $3, $4, $5, $6,
        'active', $7, $7
      )
    `, [
      input.ids.databaseCredentialVersionId,
      input.ids.providerId,
      Buffer.from(encryptedDatabaseCredential.ciphertext),
      Buffer.from(encryptedDatabaseCredential.nonce),
      Buffer.from(encryptedDatabaseCredential.authTag),
      encryptedDatabaseCredential.keyVersion,
      now,
    ]);
    await client.query(`
      insert into provider_database_nodes (
        id, provider_id, node_key, node_role, host, port, database_name,
        ssl_mode, credential_version_id, region, enabled, row_version,
        created_at, updated_at
      ) values (
        $1::uuid, $2::uuid, 'primary', 'primary', $3, $4, $5,
        'disable', $6::uuid, 'local', true, 1, $7, $7
      )
    `, [
      input.ids.databaseNodeId,
      input.ids.providerId,
      input.host,
      input.port,
      CLUTCHPACKS_REVIEW_DATABASES.provider.databaseName,
      input.ids.databaseCredentialVersionId,
      now,
    ]);
    const provider = await client.query<{ topology_version: string }>(`
      select topology_version::text
      from providers
      where id = $1::uuid
    `, [input.ids.providerId]);
    const topologyVersion = provider.rows[0]?.topology_version;
    if (topologyVersion === undefined) refuse("CENTRAL_REGISTRATION_FAILED");
    await client.query(`
      insert into provider_connection_tests (
        id, provider_id, config_version_id, source_credential_version_id,
        database_credential_version_id, topology_version, database_node_id,
        database_node_row_version, target_digest, test_kind, outcome,
        latency_ms, response_status, sanitized_code, result_summary,
        record_counts, has_more, next_cursor_present, tested_by_operator_id,
        tested_at, created_at
      ) values (
        $1::uuid, $2::uuid, $3::uuid, null, $4::uuid, $5::bigint,
        $6::uuid, 1,
        packscout_activation_target_digest_nullable_source(
          $2::uuid, $3::uuid, null, $4::uuid, $5::bigint, $6::uuid, 1
        ),
        'activation', 'succeeded', null, null, null, $7::jsonb,
        null, null, null, $8::uuid, $9, $9
      )
    `, [
      input.ids.activationTestId,
      input.ids.providerId,
      input.ids.configVersionId,
      input.ids.databaseCredentialVersionId,
      topologyVersion,
      input.ids.databaseNodeId,
      JSON.stringify({
        databaseRole: "provider",
        schemaVersion: CLUTCHPACKS_REVIEW_DATABASES.provider.schemaVersion,
      }),
      input.ids.operatorId,
      now,
    ]);
    await client.query(`
      update providers
      set lifecycle = 'active', active_config_version_id = $2::uuid,
          row_version = row_version + 1, updated_at = $3
      where id = $1::uuid
    `, [input.ids.providerId, input.ids.configVersionId, now]);
    await client.query(`
      insert into audit_events (
        id, organization_id, actor_key, action, subject_type, subject_id,
        outcome, metadata_json, occurred_at
      ) values (
        $1::uuid, $2::uuid, 'system:local-clutchpacks-provisioner',
        'provider.local_provision', 'provider', $3::uuid, 'success',
        $4::jsonb, $5
      )
    `, [
      input.ids.auditEventId,
      input.ids.organizationId,
      input.ids.providerId,
      JSON.stringify({
        adapterKey: CLUTCHPACKS_REVIEW_DATABASES.provider.adapterKey,
        databaseName: CLUTCHPACKS_REVIEW_DATABASES.provider.databaseName,
      }),
      now,
    ]);
    await client.query("commit");
  } catch {
    await client.query("rollback").catch(() => undefined);
    refuse("CENTRAL_REGISTRATION_FAILED");
  } finally {
    client.release();
    await central.end().catch(() => undefined);
  }
}

function createProvisionIds() {
  return Object.freeze({
    organizationId: randomUUID(),
    operatorId: randomUUID(),
    membershipId: randomUUID(),
    providerId: randomUUID(),
    configVersionId: randomUUID(),
    databaseCredentialVersionId: randomUUID(),
    databaseNodeId: randomUUID(),
    activationTestId: randomUUID(),
    auditEventId: randomUUID(),
  });
}

async function verifyProvisioned(input: {
  readonly centralUrl: string;
  readonly providerUrl: string;
  readonly ids: ReturnType<typeof createProvisionIds>;
}): Promise<void> {
  const central = new Pool({ connectionString: input.centralUrl, max: 1 });
  const provider = new Pool({ connectionString: input.providerUrl, max: 1 });
  try {
    const centralProof = await central.query<{
      database_role: string;
      schema_version: string;
      provider_count: string;
      admin_count: string;
    }>(`
      select identity.database_role, identity.schema_version,
             (select count(*)::text from providers saved
               where saved.id = $1::uuid
                 and saved.provider_key = 'clutchpacks'
                 and saved.lifecycle = 'active') as provider_count,
             (select count(*)::text from operator_memberships membership
               where membership.organization_id = $2::uuid
                 and membership.operator_id = $3::uuid
                 and membership.role = 'admin') as admin_count
      from database_identity identity
      where identity.singleton_key = true
    `, [input.ids.providerId, input.ids.organizationId, input.ids.operatorId]);
    const providerProof = await provider.query<{
      database_role: string;
      schema_version: string;
      provider_id: string;
      provider_key: string;
      runtime_count: string;
      worker_roles: string[];
    }>(`
      select identity.database_role, identity.schema_version,
             identity.provider_id::text, identity.provider_key,
             (select count(*)::text from provider_runtime runtime
               where runtime.singleton_key = true
                 and runtime.central_provider_id = identity.provider_id
                 and runtime.provider_key = identity.provider_key) as runtime_count,
             (select array_agg(worker_role::text order by worker_role::text)
               from provider_worker_states) as worker_roles
      from database_identity identity
      where identity.singleton_key = true
    `);
    const centralRow = centralProof.rows[0];
    const providerRow = providerProof.rows[0];
    if (
      centralProof.rows.length !== 1 ||
      centralRow?.database_role !== "central" ||
      centralRow.schema_version !== CLUTCHPACKS_REVIEW_DATABASES.central.schemaVersion ||
      centralRow.provider_count !== "1" ||
      centralRow.admin_count !== "1" ||
      providerProof.rows.length !== 1 ||
      providerRow?.database_role !== "provider" ||
      providerRow.schema_version !== CLUTCHPACKS_REVIEW_DATABASES.provider.schemaVersion ||
      providerRow.provider_id !== input.ids.providerId ||
      providerRow.provider_key !== CLUTCHPACKS_REVIEW_DATABASES.provider.providerKey ||
      providerRow.runtime_count !== "1" ||
      providerRow.worker_roles.join(",") !== "import,promotion"
    ) {
      refuse("PROVISION_READINESS_FAILED");
    }
  } catch (error) {
    if (error instanceof ClutchpacksReviewProvisionError) throw error;
    refuse("PROVISION_READINESS_FAILED");
  } finally {
    await Promise.allSettled([central.end(), provider.end()]);
  }
}

async function main(): Promise<void> {
  assertNoClutchpacksProvisionArguments(process.argv.slice(2));
  const environment = readClutchpacksProvisionEnvironment(process.env);
  const admin = new Pool({
    connectionString: environment.admin.url,
    connectionTimeoutMillis: 2_000,
    max: 1,
  });
  try {
    const before = await readInventory(admin, environment.admin.url);
    if (before.postgresMajorVersion !== 16) refuse("POSTGRES_16_REQUIRED");
    if (environment.mode === "inspect") {
      emit({
        ok: true,
        operation: "inspect_clutchpacks_review_databases",
        postgresMajorVersion: before.postgresMajorVersion,
        databases: before.databases,
        roles: before.roles.map((role) => ({
          roleName: role.roleName,
          exists: role.exists,
          login: role.login,
          bounded: role.exists && !role.superuser && !role.createRole &&
            !role.createDatabase && !role.replication && !role.bypassRls,
        })),
        adminCanProvision: before.adminIsSuperuser,
        recommendation: recommendation(before),
      });
      return;
    }
    if (!before.adminIsSuperuser) refuse("LOCAL_POSTGRES_SUPERUSER_REQUIRED");
    let backupProofs: readonly Readonly<{
      databaseName: string;
      path: string;
      bytes: number;
      sha256: string;
    }>[] = [];
    if (environment.mode === "create") {
      assertCreateOnlyInventory(before);
    } else {
      assertRebuildRoleInventory(before);
      if (environment.backupDirectory === null) {
        refuse("REBUILD_BACKUP_DIRECTORY_INVALID");
      }
      backupProofs = await backupExistingTargets({
        adminUrl: environment.admin.url,
        backupDirectory: environment.backupDirectory,
        inventory: before,
      });
      assertVerifiedBackupProofs(
        before,
        environment.backupDirectory,
        backupProofs,
      );
      emit({
        ok: true,
        operation: "backup_clutchpacks_review_databases",
        proofs: backupProofs,
      });
      await dropExactTargets(admin);
    }
    const ids = createProvisionIds();
    const plan = buildClutchpacksProvisionPlan(ids, environment.mode);
    await createExactTargets({
      admin,
      centralPassword: environment.centralAppPassword,
      providerPassword: environment.providerAppPassword,
    });
    const centralMigrationUrl = migrationOwnerUrl({
      adminUrl: environment.admin.url,
      databaseName: CLUTCHPACKS_REVIEW_DATABASES.central.databaseName,
      ownerRoleName: CLUTCHPACKS_REVIEW_DATABASES.central.ownerRoleName,
    });
    const providerMigrationUrl = migrationOwnerUrl({
      adminUrl: environment.admin.url,
      databaseName: CLUTCHPACKS_REVIEW_DATABASES.provider.databaseName,
      ownerRoleName: CLUTCHPACKS_REVIEW_DATABASES.provider.ownerRoleName,
    });
    migrate({ databaseUrl: centralMigrationUrl, role: "central" });
    migrate({ databaseUrl: providerMigrationUrl, role: "provider" });
    await initializeProviderIdentity({
      databaseUrl: providerMigrationUrl,
      providerId: ids.providerId,
    });
    await grantRuntimeAccess({
      adminUrl: environment.admin.url,
      databaseName: CLUTCHPACKS_REVIEW_DATABASES.central.databaseName,
      ownerRoleName: CLUTCHPACKS_REVIEW_DATABASES.central.ownerRoleName,
      appRoleName: CLUTCHPACKS_REVIEW_DATABASES.central.appRoleName,
      provider: false,
    });
    await grantRuntimeAccess({
      adminUrl: environment.admin.url,
      databaseName: CLUTCHPACKS_REVIEW_DATABASES.provider.databaseName,
      ownerRoleName: CLUTCHPACKS_REVIEW_DATABASES.provider.ownerRoleName,
      appRoleName: CLUTCHPACKS_REVIEW_DATABASES.provider.appRoleName,
      provider: true,
    });
    const centralUrl = databaseUrl({
      adminUrl: environment.admin.url,
      databaseName: CLUTCHPACKS_REVIEW_DATABASES.central.databaseName,
      username: CLUTCHPACKS_REVIEW_DATABASES.central.appRoleName,
      password: environment.centralAppPassword,
    });
    const providerUrl = databaseUrl({
      adminUrl: environment.admin.url,
      databaseName: CLUTCHPACKS_REVIEW_DATABASES.provider.databaseName,
      username: CLUTCHPACKS_REVIEW_DATABASES.provider.appRoleName,
      password: environment.providerAppPassword,
    });
    await expectProviderInitializerDenied(providerUrl);
    await verifyRoleIsolation({
      adminUrl: environment.admin.url,
      centralPassword: environment.centralAppPassword,
      providerPassword: environment.providerAppPassword,
    });
    await registerCentralMetadata({
      centralUrl,
      providerPassword: environment.providerAppPassword,
      bootstrap: environment.bootstrap,
      credentialKey: environment.credentialKey,
      host: environment.admin.host,
      port: environment.admin.port,
      ids,
    });
    await verifyProvisioned({ centralUrl, providerUrl, ids });
    assertProvisionedReviewInventory(
      await readInventory(admin, environment.admin.url),
    );
    emit({
      ok: true,
      operation: "provision_clutchpacks_review_databases",
      mode: environment.mode,
      databaseNames: plan.databaseNames,
      roleNames: plan.roleNames,
      identities: plan.identities,
      providerIdentity: plan.providerIdentity,
      adapterKey: CLUTCHPACKS_REVIEW_DATABASES.provider.adapterKey,
      credentialCipher: "packscout-provider-credential:v1",
      backupProofs,
      credentialsPrinted: false,
    });
  } finally {
    await admin.end().catch(() => undefined);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify(safeClutchpacksProvisionFailure(error))}\n`);
    process.exitCode = 1;
  });
}

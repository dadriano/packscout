import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import {
  assertSchemaParity,
  inspectSchema,
  loadSchemaParityManifest,
} from "./schema-parity.ts";

const execFileAsync = promisify(execFile);
const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const schemaPath = fileURLToPath(new URL("./schema.prisma", import.meta.url));
const prismaExecutable = fileURLToPath(new URL("../../../node_modules/prisma/build/index.js", import.meta.url));
const adminDatabaseUrl = process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL
  ?? `postgresql://${encodeURIComponent(userInfo().username)}@127.0.0.1:5432/postgres`;
let databaseSequence = 0;

const ids = {
  organization: "00000000-0000-4000-8000-000000000001",
  otherOrganization: "00000000-0000-4000-8000-000000000002",
  provider: "00000000-0000-4000-8000-000000000010",
  otherProvider: "00000000-0000-4000-8000-000000000011",
  configuration: "00000000-0000-4000-8000-000000000020",
  activeRun: "00000000-0000-4000-8000-000000000030",
  duplicateActiveRun: "00000000-0000-4000-8000-000000000031",
  secret: "00000000-0000-4000-8000-000000000040",
} as const;

async function endPoolFully(pool: Pool): Promise<void> {
  const expectedRemovals = pool.totalCount;
  if (expectedRemovals === 0) {
    await pool.end();
    return;
  }

  let removalCount = 0;
  let resolveRemovals: (() => void) | undefined;
  const removals = new Promise<void>((resolve) => {
    resolveRemovals = resolve;
  });
  const onRemove = () => {
    removalCount += 1;
    if (removalCount === expectedRemovals) resolveRemovals?.();
  };
  pool.on("remove", onRemove);
  try {
    await pool.end();
    await removals;
  } finally {
    pool.off("remove", onRemove);
  }
}

async function createDisposableDatabase(): Promise<{
  db: Pool;
  databaseUrl: string;
  stop(): Promise<void>;
}> {
  const adminUrl = new URL(adminDatabaseUrl);
  if (!/^postgresql?:$/.test(adminUrl.protocol)) {
    throw new Error("PACKSCOUT_TEST_ADMIN_DATABASE_URL must be a PostgreSQL URL");
  }
  const databaseName = `packscout_prisma_schema_${process.pid}_${++databaseSequence}`;
  if (!/^packscout_prisma_schema_[0-9]+_[0-9]+$/.test(databaseName)) {
    throw new Error("refusing to create an unscoped test database");
  }
  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  await admin.query(`create database "${databaseName}"`);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const db = new Pool({ connectionString: databaseUrl.toString(), max: 4 });
  return {
    db,
    databaseUrl: databaseUrl.toString(),
    stop: async () => {
      try {
        await endPoolFully(db);
        await admin.query(`drop database if exists "${databaseName}" with (force)`);
      } finally {
        await endPoolFully(admin);
      }
    },
  };
}

async function createMigratedPrismaHarness(): Promise<{
  db: Pool;
  databaseUrl: string;
  prisma: PrismaClient;
  stop(): Promise<void>;
}> {
  const disposable = await createDisposableDatabase();
  try {
    await execFileAsync(
      process.execPath,
      [prismaExecutable, "migrate", "deploy", "--schema", schemaPath],
      {
        cwd: packageDirectory,
        env: { ...process.env, PACKSCOUT_DATABASE_URL: disposable.databaseUrl },
      },
    );
  } catch (error) {
    await disposable.stop();
    throw error;
  }
  const prisma = new PrismaClient({ datasources: { db: { url: disposable.databaseUrl } } });
  return {
    db: disposable.db,
    databaseUrl: disposable.databaseUrl,
    prisma,
    stop: async () => {
      await prisma.$disconnect();
      await disposable.stop();
    },
  };
}

async function seedScopedProvider(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`
    insert into public.organizations (id, slug, name)
    values
      ('${ids.organization}', 'packscout', 'PackScout'),
      ('${ids.otherOrganization}', 'other', 'Other')
  `);
  await prisma.$executeRawUnsafe(`
    insert into public.provider_sources (id, organization_id, platform_key, display_name)
    values
      ('${ids.provider}', '${ids.organization}', 'beezie', 'Beezie'),
      ('${ids.otherProvider}', '${ids.otherOrganization}', 'other', 'Other')
  `);
  await prisma.$executeRawUnsafe(`
    insert into public.provider_config_revisions (
      id, organization_id, provider_id, version, adapter_key, endpoint_url,
      auth_mode, created_by_actor_key
    ) values (
      '${ids.configuration}', '${ids.organization}', '${ids.provider}', 1,
      'http-cursor-v1', 'https://provider.example/feed', 'bearer', 'operator:admin'
    )
  `);
}

test("the checked-in Prisma migration provisions the complete catalog for Prisma Client", { concurrency: false }, async () => {
  const harness = await createMigratedPrismaHarness();
  try {
    const manifest = await loadSchemaParityManifest();
    const catalog = await inspectSchema(harness.db);
    assertSchemaParity(catalog, manifest);

    const weakenedCheck = structuredClone(manifest);
    weakenedCheck.tables.import_runs!.checkConstraints.import_runs_attempt_nonnegative = {
      value: "attempt >= -1",
    };
    assert.throws(
      () => assertSchemaParity(catalog, weakenedCheck),
      /import_runs check constraints drifted/,
    );

    const weakenedPartialIndex = structuredClone(manifest);
    weakenedPartialIndex.tables.import_runs!.indexes.import_runs_provider_active_unique!.where =
      "state = 'queued'";
    assert.throws(
      () => assertSchemaParity(catalog, weakenedPartialIndex),
      /import_runs indexes drifted/,
    );

    assert.equal(await harness.prisma.organizations.count(), 0);
    const repeatedDeploy = await execFileAsync(
      process.execPath,
      [prismaExecutable, "migrate", "deploy", "--schema", schemaPath],
      {
        cwd: packageDirectory,
        env: { ...process.env, PACKSCOUT_DATABASE_URL: harness.databaseUrl },
      },
    );
    assert.match(repeatedDeploy.stdout, /No pending migrations to apply/);
    assertSchemaParity(await inspectSchema(harness.db), manifest);
  } finally {
    await harness.stop();
  }
});

test("migration application fails visibly instead of reporting an incomplete schema ready", { concurrency: false }, async () => {
  const disposable = await createDisposableDatabase();
  try {
    await disposable.db.query("create table public.organizations (id integer primary key)");
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [prismaExecutable, "migrate", "deploy", "--schema", schemaPath],
        {
          cwd: packageDirectory,
          env: { ...process.env, PACKSCOUT_DATABASE_URL: disposable.databaseUrl },
        },
      ),
      /migration|already exists|P30/i,
    );
    const catalog = await inspectSchema(disposable.db);
    const manifest = await loadSchemaParityManifest();
    assert.throws(() => assertSchemaParity(catalog, manifest), /schema object counts drifted/);
  } finally {
    await disposable.stop();
  }
});

test("PostgreSQL rejects cross-organization references, invalid state, and duplicate active work", { concurrency: false }, async () => {
  const harness = await createMigratedPrismaHarness();
  try {
    await seedScopedProvider(harness.prisma);
    await assert.rejects(
      harness.prisma.$executeRawUnsafe(`
        insert into public.provider_secret_versions (
          id, organization_id, provider_id, revision_id,
          ciphertext, nonce, auth_tag, key_version
        ) values (
          '${ids.secret}', '${ids.otherOrganization}', '${ids.otherProvider}', '${ids.configuration}',
          '\\x0102', '\\x0304', '\\x0506', 1
        )
      `),
      /foreign key constraint/i,
    );
    await harness.prisma.$executeRawUnsafe(`
      insert into public.settled_public_watermarks (
        organization_id, next_sequence, source_head_sequence, source_head_at
      ) values (
        '${ids.organization}', 2, 1, current_timestamp
      )
    `);
    await harness.prisma.$executeRawUnsafe(`
      insert into public.public_change_causes (
        organization_id, sequence, change_kind, entity_key,
        occurred_at, authoritative_transaction_id
      ) values (
        '${ids.organization}', 1, 'manual_correction', 'canonical:v1:pack-1',
        current_timestamp, 'schema-parity-test'
      )
    `);
    await assert.rejects(
      harness.prisma.$executeRawUnsafe(`
        insert into public.estimated_ev_recomputation_requests (
          request_key, organization_id, provider_id, configuration_revision_id,
          platform_key, pack_external_id, ev_input_external_id,
          originating_public_change_sequence, state
        ) values (
          repeat('a', 64), '${ids.organization}', '${ids.provider}', '${ids.configuration}',
          'beezie', 'pack-1', 'input-1', 1, 'running'
        )
      `),
      /check constraint/i,
    );
    await harness.prisma.$executeRawUnsafe(`
      insert into public.import_runs (
        id, organization_id, provider_id, config_revision_id, trigger,
        state, requested_by_actor_key
      ) values (
        '${ids.activeRun}', '${ids.organization}', '${ids.provider}', '${ids.configuration}',
        'manual', 'queued', 'operator:admin'
      )
    `);
    await assert.rejects(
      harness.prisma.$executeRawUnsafe(`
        insert into public.import_runs (
          id, organization_id, provider_id, config_revision_id, trigger,
          state, requested_by_actor_key
        ) values (
          '${ids.duplicateActiveRun}', '${ids.organization}', '${ids.provider}', '${ids.configuration}',
          'manual', 'running', 'operator:admin'
        )
      `),
      /23505|already exists/i,
    );
  } finally {
    await harness.stop();
  }
});

test("defaults, JSON, secret bytes, cyclic scope, and deletion restrictions survive the cutover", { concurrency: false }, async () => {
  const harness = await createMigratedPrismaHarness();
  try {
    await seedScopedProvider(harness.prisma);
    await harness.prisma.$executeRawUnsafe(`
      insert into public.provider_secret_versions (
        id, organization_id, provider_id, revision_id,
        ciphertext, nonce, auth_tag, key_version
      ) values (
        '${ids.secret}', '${ids.organization}', '${ids.provider}', '${ids.configuration}',
        '\\x0102', '\\x0304', '\\x0506', 1
      )
    `);
    const [row] = await harness.prisma.$queryRawUnsafe<Array<{
      provider_id: string;
      provider_state: string;
      created_at: Date;
      evidence: unknown;
      ciphertext_hex: string;
    }>>(`
      select provider.id as provider_id,
             provider.state::text as provider_state,
             provider.created_at,
             '{}'::jsonb as evidence,
             encode(secret.ciphertext, 'hex') as ciphertext_hex
      from public.provider_sources provider
      join public.provider_secret_versions secret on secret.provider_id = provider.id
      where provider.id = '${ids.provider}'
    `);
    assert.equal(row?.provider_state, "draft");
    assert.ok(row?.created_at instanceof Date);
    assert.deepEqual(row?.evidence, {});
    assert.equal(row?.ciphertext_hex, "0102");

    await harness.prisma.$executeRawUnsafe(`
      update public.provider_sources
      set active_revision_id = '${ids.configuration}'
      where id = '${ids.provider}'
    `);
    await assert.rejects(
      harness.prisma.$executeRawUnsafe(`
        update public.provider_sources
        set active_revision_id = '${ids.configuration}'
        where id = '${ids.otherProvider}'
      `),
      /foreign key constraint/i,
    );
    await assert.rejects(
      harness.prisma.$executeRawUnsafe(`delete from public.organizations where id = '${ids.organization}'`),
      /foreign key constraint/i,
    );
  } finally {
    await harness.stop();
  }
});

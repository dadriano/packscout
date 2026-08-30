import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Pool } from "pg";
import { createCentralDatabaseLifecycle } from "./central-database.ts";
import {
  createProviderDatabaseLifecycle,
  initializeProviderDatabaseIdentity,
} from "./provider-database.ts";

const execFileAsync = promisify(execFile);
const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const prismaExecutable = fileURLToPath(
  new URL("../../../node_modules/prisma/build/index.js", import.meta.url),
);
const centralSchemaPath = fileURLToPath(
  new URL("../prisma/central/schema.prisma", import.meta.url),
);
const providerSchemaPath = fileURLToPath(
  new URL("../prisma/provider/schema.prisma", import.meta.url),
);
const REQUIRED_CONFIRMATION = "packscout,packscout_alpha,packscout_beta";
const databaseNames = ["packscout", "packscout_alpha", "packscout_beta"] as const;
const providerIds = {
  alpha: "10000000-0000-4000-8000-000000000001",
  beta: "10000000-0000-4000-8000-000000000002",
} as const;

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) {
    throw new Error("Refusing an unsafe PostgreSQL identifier.");
  }
  return `"${value}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function resolveAdminUrl(): URL {
  const configured = process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL;
  return new URL(
    configured
      ?? `postgresql://${encodeURIComponent(userInfo().username)}@127.0.0.1:5432/postgres`,
  );
}

function databaseUrl(input: {
  adminUrl: URL;
  databaseName: string;
  roleName: string;
  password: string;
}): string {
  const url = new URL(input.adminUrl);
  url.pathname = `/${input.databaseName}`;
  url.username = input.roleName;
  url.password = input.password;
  const socketHost = url.searchParams.get("host");
  url.search = "";
  if (socketHost?.startsWith("/")) url.searchParams.set("host", socketHost);
  url.hash = "";
  return url.toString();
}

async function migrate(input: {
  databaseUrl: string;
  role: "central" | "provider";
}): Promise<string> {
  const schemaPath = input.role === "central" ? centralSchemaPath : providerSchemaPath;
  const environmentKey = input.role === "central"
    ? "PACKSCOUT_CENTRAL_DATABASE_URL"
    : "PACKSCOUT_PROVIDER_DATABASE_URL";
  const result = await execFileAsync(
    process.execPath,
    [prismaExecutable, "migrate", "deploy", "--schema", schemaPath],
    {
      cwd: packageDirectory,
      env: { ...process.env, [environmentKey]: input.databaseUrl },
    },
  );
  return result.stdout;
}

async function queryWithCredential(databaseUrl: string): Promise<void> {
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 1_000,
    max: 1,
  });
  try {
    await pool.query("select 1");
  } finally {
    await pool.end().catch(() => undefined);
  }
}

test("central and two exact provider databases provision and fail independently", { concurrency: false }, async (context) => {
  if (process.env.PACKSCOUT_DISTRIBUTED_TEST_DATABASES !== REQUIRED_CONFIRMATION) {
    context.skip(
      `set PACKSCOUT_DISTRIBUTED_TEST_DATABASES=${REQUIRED_CONFIRMATION} on a disposable PostgreSQL 16 cluster`,
    );
    return;
  }

  const admin = new Pool({ connectionString: resolveAdminUrl().toString(), max: 1 });
  const suffix = `${process.pid}_${randomBytes(4).toString("hex")}`;
  const roles = {
    central: `packscout_c_${suffix}`,
    alpha: `packscout_a_${suffix}`,
    beta: `packscout_b_${suffix}`,
  } as const;
  const passwords = {
    central: randomBytes(24).toString("base64url"),
    alpha: randomBytes(24).toString("base64url"),
    beta: randomBytes(24).toString("base64url"),
  } as const;
  const createdDatabases: string[] = [];
  const createdRoles: string[] = [];

  const urls = {
    central: databaseUrl({
      adminUrl: resolveAdminUrl(),
      databaseName: "packscout",
      roleName: roles.central,
      password: passwords.central,
    }),
    alpha: databaseUrl({
      adminUrl: resolveAdminUrl(),
      databaseName: "packscout_alpha",
      roleName: roles.alpha,
      password: passwords.alpha,
    }),
    beta: databaseUrl({
      adminUrl: resolveAdminUrl(),
      databaseName: "packscout_beta",
      roleName: roles.beta,
      password: passwords.beta,
    }),
  } as const;

  try {
    const version = await admin.query<{ server_version_num: string }>(
      "show server_version_num",
    );
    assert.ok(Number(version.rows[0]?.server_version_num) >= 160_000);
    const existing = await admin.query<{ datname: string }>(
      "select datname from pg_database where datname = any($1::text[])",
      [databaseNames],
    );
    assert.deepEqual(
      existing.rows,
      [],
      "Refusing to replace an existing exact PackScout topology database.",
    );

    for (const key of ["central", "alpha", "beta"] as const) {
      await admin.query(
        `create role ${quoteIdentifier(roles[key])} login password ${quoteLiteral(passwords[key])}`,
      );
      createdRoles.push(roles[key]);
    }
    for (const [databaseName, roleName] of [
      ["packscout", roles.central],
      ["packscout_alpha", roles.alpha],
      ["packscout_beta", roles.beta],
    ] as const) {
      await admin.query(
        `create database ${quoteIdentifier(databaseName)} owner ${quoteIdentifier(roleName)}`,
      );
      createdDatabases.push(databaseName);
      await admin.query(
        `revoke connect on database ${quoteIdentifier(databaseName)} from public`,
      );
    }

    await migrate({ databaseUrl: urls.central, role: "central" });
    await Promise.all([
      migrate({ databaseUrl: urls.alpha, role: "provider" }),
      migrate({ databaseUrl: urls.beta, role: "provider" }),
    ]);

    const alphaInitializer = createProviderDatabaseLifecycle({
      databaseUrl: urls.alpha,
      providerId: providerIds.alpha,
      providerKey: "alpha",
    });
    const betaInitializer = createProviderDatabaseLifecycle({
      databaseUrl: urls.beta,
      providerId: providerIds.beta,
      providerKey: "beta",
    });
    await initializeProviderDatabaseIdentity({
      client: alphaInitializer.client,
      providerId: providerIds.alpha,
      providerKey: "alpha",
    });
    await initializeProviderDatabaseIdentity({
      client: betaInitializer.client,
      providerId: providerIds.beta,
      providerKey: "beta",
    });

    const central = createCentralDatabaseLifecycle({ databaseUrl: urls.central });
    const alpha = createProviderDatabaseLifecycle({
      databaseUrl: urls.alpha,
      providerId: providerIds.alpha,
      providerKey: "alpha",
    });
    const beta = createProviderDatabaseLifecycle({
      databaseUrl: urls.beta,
      providerId: providerIds.beta,
      providerKey: "beta",
    });
    try {
      assert.equal((await central.readiness()).state, "ready");
      assert.equal((await alpha.readiness()).state, "ready");
      assert.equal((await beta.readiness()).state, "ready");

      const wrongProvider = createProviderDatabaseLifecycle({
        databaseUrl: urls.alpha,
        providerId: providerIds.beta,
        providerKey: "alpha",
      });
      try {
        const mismatch = await wrongProvider.readiness();
        assert.equal(mismatch.state, "unavailable");
        if (mismatch.state === "unavailable") {
          assert.equal(mismatch.failureCode, "PROVIDER_IDENTITY_MISMATCH");
          assert.doesNotMatch(JSON.stringify(mismatch), /postgres|password|127\.0\.0\.1/i);
        }
      } finally {
        await wrongProvider.close();
      }

      const unreachable = createProviderDatabaseLifecycle({
        databaseUrl: "postgresql://unavailable:unavailable@127.0.0.1:1/packscout_beta?connect_timeout=1",
        providerId: providerIds.beta,
        providerKey: "beta",
        connectionLimit: 1,
      });
      try {
        const unavailable = await unreachable.readiness();
        assert.equal(unavailable.state, "unavailable");
        if (unavailable.state === "unavailable") {
          assert.equal(unavailable.failureCode, "DATABASE_UNREACHABLE");
          assert.doesNotMatch(JSON.stringify(unavailable), /unavailable@|127\.0\.0\.1/i);
        }
        assert.equal((await central.readiness()).state, "ready");
        assert.equal((await alpha.readiness()).state, "ready");
      } finally {
        await unreachable.close();
      }

      await assert.rejects(
        queryWithCredential(databaseUrl({
          adminUrl: resolveAdminUrl(),
          databaseName: "packscout_beta",
          roleName: roles.alpha,
          password: passwords.alpha,
        })),
        /permission denied for database/i,
      );
      await assert.rejects(
        queryWithCredential(databaseUrl({
          adminUrl: resolveAdminUrl(),
          databaseName: "packscout",
          roleName: roles.alpha,
          password: passwords.alpha,
        })),
        /permission denied for database/i,
      );

      assert.match(
        await migrate({ databaseUrl: urls.central, role: "central" }),
        /No pending migrations to apply/i,
      );
      assert.match(
        await migrate({ databaseUrl: urls.alpha, role: "provider" }),
        /No pending migrations to apply/i,
      );
    } finally {
      await Promise.allSettled([
        central.close(),
        alpha.close(),
        beta.close(),
        alphaInitializer.close(),
        betaInitializer.close(),
      ]);
    }
  } finally {
    for (const databaseName of createdDatabases.reverse()) {
      await admin.query(
        `drop database if exists ${quoteIdentifier(databaseName)} with (force)`,
      ).catch(() => undefined);
    }
    for (const roleName of createdRoles.reverse()) {
      await admin.query(`drop role if exists ${quoteIdentifier(roleName)}`).catch(() => undefined);
    }
    await admin.end().catch(() => undefined);
  }
});

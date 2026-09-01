import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { PrismaClient } from "../prisma/generated/provider/index.js";
import { initializeProviderDatabaseIdentity } from "./provider-database.ts";
import { PrismaProviderRuntimeRepository } from "./provider-runtime-repository.ts";
import { PrismaProviderRequestSettingsRepository } from "./provider-request-settings-repository.ts";
import { PrismaProviderRunRepository } from "./provider-run-repository.ts";
import { PrismaProviderWorkerLeaseRepository } from "./provider-worker-lease-repository.ts";

export async function createRequestSettingsHarness() {
  const configured = process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL;
  if (!configured) throw new Error("Explicit disposable PostgreSQL 16 test URL is required.");
  const adminUrl = new URL(configured);
  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  const providerKey = `request_size_${process.pid}_${randomBytes(5).toString("hex")}`;
  const name = `packscout_${providerKey}`;
  if (!/^packscout_request_size_[0-9]+_[a-f0-9]{10}$/u.test(name)) throw new Error("Unsafe test database name.");
  const url = new URL(adminUrl); url.pathname = `/${name}`;
  const providerId = randomUUID(); const configId = randomUUID(); const operatorId = randomUUID();
  const adapterKey = "test-reviewed-dataforrest-adapter";
  let created = false;
  const client = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  try {
    const version = await admin.query<{ server_version_num: string }>("show server_version_num");
    if (Number(version.rows[0]?.server_version_num) < 160_000) throw new Error("PostgreSQL 16 is required.");
    await admin.query(`create database "${name}"`); created = true;
    await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL("../../../node_modules/prisma/build/index.js", import.meta.url)),
      "migrate", "deploy", "--schema", fileURLToPath(new URL("../prisma/provider/schema.prisma", import.meta.url)),
    ], { cwd: fileURLToPath(new URL("..", import.meta.url)), env: {
      PATH: process.env.PATH, PACKSCOUT_PROVIDER_DATABASE_URL: url.toString(),
    } });
    await client.$connect();
    await initializeProviderDatabaseIdentity({ client, providerId, providerKey });
    await new PrismaProviderRuntimeRepository(client).synchronizeConfiguration({
      centralProviderId: providerId, providerKey, configVersionId: configId, configVersionNumber: 1n,
      configuration: { adapterKey }, expiresAt: new Date(Date.now() + 3_600_000),
      scheduleSeconds: 60, nextDueAt: null, synchronizedAt: new Date(),
    });
  } catch (error) {
    await client.$disconnect();
    if (created) await admin.query(`drop database "${name}" with (force)`);
    await admin.end(); throw error;
  }
  const settings = new PrismaProviderRequestSettingsRepository(client);
  const runs = new PrismaProviderRunRepository(client);
  const leases = new PrismaProviderWorkerLeaseRepository(client);
  const reviseInput = { providerId, expectedRevisionId: null as string | null, recordsPerRequest: 100,
    actorOperatorId: operatorId, correlationId: randomUUID(), expectedConfigVersionId: configId,
    expectedConfigVersionNumber: 1n, adapterKey };
  const workerId = `worker:request-size:${randomUUID()}`;
  return { client, databaseUrl: url.toString(), providerId, providerKey, configId, operatorId, adapterKey, settings, runs, leases, workerId, reviseInput,
    async start(recordsPerRequest = 100) {
      const lease = await leases.acquire({ role: "import", owner: workerId, leaseMilliseconds: 60_000 });
      if (lease.kind === "held") throw new Error("Unexpected occupied test lease.");
      const result = await runs.start({ runId: randomUUID(), idempotencyKey: `test/${randomUUID()}`,
        trigger: "scheduled", requestedByOperatorId: null, configVersionId: configId, configVersionNumber: 1n,
        workerId, workerFence: lease.lease.fence, correlationId: randomUUID(), requestedAt: new Date(),
        requestSettingsDefault: { recordsPerRequest, adapterKey } });
      if (result.kind !== "started") throw new Error(`Unexpected test start ${result.kind}.`);
      return { run: result.run, fence: lease.lease.fence };
    },
    async close() { await client.$disconnect(); await admin.query(`drop database "${name}" with (force)`); await admin.end(); },
  };
}

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { userInfo } from "node:os";
import { test } from "node:test";
import type { Express } from "express";
import {
  DatabaseLoginAttemptLimiter,
  DrizzleAuthAuditSink,
  DrizzleAuthRepository,
  IngestionPersistenceRepository,
  PipelineSetupRepository,
} from "@packscout/database";
import { createMigratedTestDatabase } from "@packscout/database/test-support";
import { createAdminApp } from "./app.ts";
import { createNodeAuthSecurity } from "./auth/crypto.ts";
import { createAdminAuthRuntime } from "./auth/runtime.ts";
import { createAdminImportOperationsRuntime } from "./import-operations-runtime.ts";

const ids = {
  organization: "72000000-0000-4000-8000-000000000001",
  operator: "72000000-0000-4000-8000-000000000002",
  provider: "72000000-0000-4000-8000-000000000010",
  revision: "72000000-0000-4000-8000-000000000020",
  run: "72000000-0000-4000-8000-000000000030",
} as const;

const origin = "https://admin.packscout.test";
const now = new Date("2026-08-06T12:00:00.000Z");
const sessionSecret = "admin-runtime-session-secret-at-least-32-bytes";
const password = "correct horse battery staple";
const rawSecret = "Bearer never-return private-user 0xprivate-wallet";

async function reserveFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function childDatabaseUrl(
  database: Awaited<ReturnType<typeof createMigratedTestDatabase>>["database"],
): Promise<string> {
  const [current] = await database.$queryRaw<Array<{ databaseName: string }>>`
    select current_database() as "databaseName"
  `;
  if (!current) throw new Error("Test database identity is unavailable.");
  const configured = process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL;
  const adminUrl = new URL(
    configured ??
      `postgresql://${encodeURIComponent(userInfo().username)}@127.0.0.1:5432/postgres`,
  );
  adminUrl.pathname = `/${current.databaseName}`;
  adminUrl.search = "";
  adminUrl.hash = "";
  return adminUrl.toString();
}

function waitForChildOutput(
  child: ChildProcess,
  marker: string,
): Promise<{ readOutput(): string }> {
  let output = "";
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Admin entrypoint did not report startup."));
    }, 15_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (!output.includes(marker)) return;
      clearTimeout(timeout);
      resolve({ readOutput: () => output });
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", () => {
      clearTimeout(timeout);
      if (!output.includes(marker)) {
        reject(new Error("Admin entrypoint exited before startup."));
      }
    });
  });
}

async function withServer(app: Express, run: (baseUrl: string) => Promise<void>) {
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const { address, port } = server.address() as AddressInfo;
    await run(`http://${address}:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function createHarness() {
  const harness = await createMigratedTestDatabase();
  const setup = new PipelineSetupRepository(harness.database);
  await setup.createOrganization({
    id: ids.organization,
    slug: "admin-runtime",
    name: "Admin Runtime",
    createdAt: now,
  });
  await setup.createProviderSource({
    id: ids.provider,
    organizationId: ids.organization,
    platformKey: "beezie",
    displayName: "Beezie",
    createdAt: now,
  });
  await setup.createConfigRevision({
    id: ids.revision,
    organizationId: ids.organization,
    providerId: ids.provider,
    version: 1,
    adapterKey: "http-cursor-v1",
    endpointUrl: "https://provider.example/feed",
    authMode: "none",
    createdByActorKey: "actor:admin",
    createdAt: now,
  });
  await setup.recordSuccessfulConnectionTest({
    organizationId: ids.organization,
    providerId: ids.provider,
    revisionId: ids.revision,
    actorKey: "actor:admin",
    testedAt: now,
    latencyMs: 5,
  });
  await setup.activateConfiguration({
    organizationId: ids.organization,
    providerId: ids.provider,
    revisionId: ids.revision,
    actorKey: "actor:admin",
    activatedAt: now,
    nextRunAt: new Date(now.getTime() + 300_000),
  });
  await setup.createImportRun({
    id: ids.run,
    organizationId: ids.organization,
    providerId: ids.provider,
    configRevisionId: ids.revision,
    trigger: "manual",
    requestedByActorKey: "actor:admin",
    state: "incomplete",
    createdAt: now,
  });
  const pull = {
    platform: "beezie",
    external_id: "pull-1",
    pack_external_id: null,
    occurred_at: "2026-08-06T11:55:00.000Z",
    collected_at: now.toISOString(),
    data: {
      tokenId: 15_006,
      swapValue: 31_000_000,
      from: "fixture-wallet-a",
      rawSecret,
    },
  };
  const ingestion = new IngestionPersistenceRepository(harness.database, {
    retentionDays: 90,
    actorPseudonymKey: "admin-runtime-pseudonym-key-32-bytes",
  });
  await ingestion.commitPage({
    organizationId: ids.organization,
    providerId: ids.provider,
    configRevisionId: ids.revision,
    runId: ids.run,
    pageNumber: 1,
    requestedCursor: "raw-cursor-in-private-user",
    nextCursor: "raw-cursor-out-0xprivate-wallet",
    hasMore: false,
    payload: { catalog: [], pulls: [pull], sales: [], rawSecret },
    records: [],
    quarantines: [{
      recordKind: "pull",
      recordIndex: 0,
      externalId: "private-user",
      reasonCode: "MAPPING_REJECTED",
      fieldPath: "data.tokenId",
      sanitizedSummary: "Pull mapping requires review.",
      payload: pull,
    }],
    committedAt: new Date(now.getTime() + 10_000),
  });
  await harness.database.import_runs.update({
    where: { id: ids.run },
    data: {
      state: "incomplete",
      started_at: new Date(now.getTime() + 1_000),
      finished_at: new Date(now.getTime() + 20_000),
      failure_code: "IMPORT_MAPPING_FAILED",
      failure_summary: `unsafe ${rawSecret}`,
    },
  });

  const authRepository = new DrizzleAuthRepository(harness.database);
  const security = createNodeAuthSecurity(sessionSecret);
  const provisioned = await authRepository.provisionOperator({
    id: ids.operator,
    organizationId: ids.organization,
    emailNormalized: "admin@packscout.test",
    displayName: "Primary Admin",
    passwordHash: await security.passwordHasher.hash(password),
    role: "admin",
    state: "active",
    now,
  });
  assert.equal(provisioned.kind, "created");
  const auth = await createAdminAuthRuntime({
    repository: authRepository,
    loginLimiter: new DatabaseLoginAttemptLimiter(harness.database, {
      windowMs: 60_000,
      blockMs: 60_000,
      maximumFailures: 5,
    }),
    audit: new DrizzleAuthAuditSink(harness.database),
    sessionSecret,
    sessionIdleMs: 60 * 60_000,
    sessionAbsoluteMs: 12 * 60 * 60_000,
    production: false,
    allowedOrigins: [origin],
  });
  const actorPseudonymKey = new Uint8Array(
    Buffer.from("admin-runtime-actor-pseudonym-key", "utf8"),
  );
  const app = createAdminApp({
    auth,
    importOperations: createAdminImportOperationsRuntime({
      database: harness.database,
      actorPseudonymKey,
      credentialKey: new Uint8Array(32).fill(7),
      environment: "test",
    }),
  });
  const quarantine = await harness.database.quarantine_records.findFirst({
    where: { organization_id: ids.organization },
    select: { id: true },
  });
  assert.ok(quarantine);
  return { ...harness, app, quarantineId: quarantine.id };
}

test("real admin composition reads safe operations, coalesces manual runs, and resolves quarantine independently", async () => {
  const harness = await createHarness();
  try {
    await withServer(harness.app, async (baseUrl) => {
      const login = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({
          email: "admin@packscout.test",
          password,
        }),
      });
      assert.equal(login.status, 200);
      const session = await login.json() as { csrfToken: string };
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
      const readHeaders = { Cookie: cookie };
      const mutationHeaders = {
        ...readHeaders,
        "Content-Type": "application/json",
        Origin: origin,
        "X-CSRF-Token": session.csrfToken,
      };

      const overview = await fetch(`${baseUrl}/api/operations/providers?limit=25`, {
        headers: readHeaders,
      });
      assert.equal(overview.status, 200);
      const runs = await fetch(`${baseUrl}/api/import-runs?limit=25`, {
        headers: readHeaders,
      });
      assert.equal(runs.status, 200);
      const detailBefore = await fetch(`${baseUrl}/api/import-runs/${ids.run}`, {
        headers: readHeaders,
      });
      assert.equal(detailBefore.status, 200);
      const quarantineBefore = await fetch(
        `${baseUrl}/api/quarantine?runId=${ids.run}&recordKind=pull&state=open&limit=25`,
        { headers: readHeaders },
      );
      assert.equal(quarantineBefore.status, 200);
      const safeReadBody = [
        await overview.text(),
        await runs.text(),
        await detailBefore.text(),
        await quarantineBefore.text(),
      ].join("\n");
      assert.doesNotMatch(safeReadBody, /never-return|private-user|0xprivate-wallet|raw-cursor-in|raw-cursor-out/);

      const retry = await fetch(
        `${baseUrl}/api/quarantine/${harness.quarantineId}/retries`,
        { method: "POST", headers: mutationHeaders, body: "{}" },
      );
      assert.equal(retry.status, 200);
      const retryBody = await retry.json() as { outcome: { outcome: string } };
      const attemptRecord = await harness.database.quarantine_attempts.findFirst({
        where: { quarantine_id: harness.quarantineId },
        select: { failure_code: true, sanitized_summary: true },
      });
      const attempt = attemptRecord
        ? {
            failureCode: attemptRecord.failure_code,
            summary: attemptRecord.sanitized_summary,
          }
        : null;
      assert.equal(
        retryBody.outcome.outcome,
        "resolved",
        JSON.stringify({ retryBody, attempt }),
      );
      const detailAfter = await fetch(`${baseUrl}/api/import-runs/${ids.run}`, {
        headers: readHeaders,
      });
      const historical = await detailAfter.json() as {
        run: { state: string; counters: { resolvedQuarantines: number } };
      };
      assert.equal(historical.run.state, "incomplete");
      assert.equal(historical.run.counters.resolvedQuarantines, 1);

      const manualRequest = JSON.stringify({
        expectedConfigurationRevisionId: ids.revision,
      });
      const staleManual = await fetch(
        `${baseUrl}/api/data-providers/${ids.provider}/import-runs`,
        {
          method: "POST",
          headers: mutationHeaders,
          body: JSON.stringify({
            expectedConfigurationRevisionId:
              "72000000-0000-4000-8000-000000000099",
          }),
        },
      );
      assert.equal(staleManual.status, 409);
      assert.equal(
        (await staleManual.json() as { code: string }).code,
        "CONFIG_REVISION_CONFLICT",
      );
      const firstManual = await fetch(
        `${baseUrl}/api/data-providers/${ids.provider}/import-runs`,
        { method: "POST", headers: mutationHeaders, body: manualRequest },
      );
      assert.equal(firstManual.status, 202);
      const firstManualBody = await firstManual.json() as { run: { id: string } };
      const duplicateManual = await fetch(
        `${baseUrl}/api/data-providers/${ids.provider}/import-runs`,
        { method: "POST", headers: mutationHeaders, body: manualRequest },
      );
      assert.equal(duplicateManual.status, 200);
      const duplicateBody = await duplicateManual.json() as {
        run: { id: string };
        deduplicated: boolean;
      };
      assert.equal(duplicateBody.deduplicated, true);
      assert.equal(duplicateBody.run.id, firstManualBody.run.id);

      const invalidCursor = await fetch(
        `${baseUrl}/api/import-runs?cursor=not-a-cursor&limit=25`,
        { headers: readHeaders },
      );
      assert.equal(invalidCursor.status, 422);
      assert.equal(
        (await invalidCursor.json() as { code: string }).code,
        "INVALID_OPERATION_CURSOR",
      );
    });
  } finally {
    await harness.close();
  }
});

test("admin entrypoint starts Prisma before listening and closes cleanly on SIGTERM", async () => {
  const harness = await createMigratedTestDatabase();
  let child: ChildProcess | undefined;
  try {
    const databaseUrl = await childDatabaseUrl(harness.database);
    const port = await reserveFreePort();
    child = spawn(
      process.execPath,
      ["--import", "tsx", "apps/admin/server/index.ts"],
      {
        cwd: new URL("../../..", import.meta.url),
        env: {
          ...process.env,
          NODE_ENV: "production",
          PACKSCOUT_DATABASE_URL: databaseUrl,
          PACKSCOUT_ADMIN_PORT: String(port),
          PACKSCOUT_ADMIN_ALLOWED_ORIGINS: origin,
          PACKSCOUT_SESSION_HASHING_SECRET: sessionSecret,
          PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64: Buffer.alloc(32, 7).toString(
            "base64",
          ),
          PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64: Buffer.alloc(32, 9).toString(
            "base64",
          ),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const startup = await waitForChildOutput(
      child,
      `Packscout Admin is available at http://localhost:${port}`,
    );
    assert.equal(startup.readOutput().includes(databaseUrl), false);
    const exitPromise = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child!.once("exit", (code, signal) => resolve({ code, signal }));
    });
    assert.equal(child.kill("SIGTERM"), true);
    const exit = await exitPromise;
    assert.deepEqual(exit, { code: 0, signal: null });
    child = undefined;
  } finally {
    if (child?.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await harness.close();
  }
});

#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import {
  DatabaseLoginAttemptLimiter,
  DrizzleAuthAuditSink,
  DrizzleAuthRepository,
  DrizzleProviderConfigurationRepository,
  DrizzleProviderHealthRepository,
  PipelineSetupRepository,
} from "@packscout/database";
import { createMigratedTestDatabase } from "@packscout/database/test-support";
import { createAdminApp } from "../../apps/admin/server/app.ts";
import { createNodeAuthSecurity } from "../../apps/admin/server/auth/crypto.ts";
import { createAdminAuthRuntime } from "../../apps/admin/server/auth/runtime.ts";
import { createAdminImportOperationsRuntime } from "../../apps/admin/server/import-operations-runtime.ts";
import { createAdminOperationalRuntime } from "../../apps/admin/server/operational-runtime.ts";
import { createProviderAdminRuntime } from "../../apps/admin/server/provider-runtime.ts";
import {
  readPort,
  readRequiredSecret,
} from "../../apps/admin/server/runtime-config.ts";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
dotenv.config({ path: path.join(repositoryRoot, ".env") });

const port = readPort(
  process.env.PACKSCOUT_ADMIN_PORT,
  5101,
  "PACKSCOUT_ADMIN_PORT",
);
const sessionSecret = readRequiredSecret(
  process.env.PACKSCOUT_SESSION_HASHING_SECRET,
  "PACKSCOUT_SESSION_HASHING_SECRET",
  32,
);
const email = readRequiredSecret(
  process.env.PACKSCOUT_BOOTSTRAP_ADMIN_EMAIL,
  "PACKSCOUT_BOOTSTRAP_ADMIN_EMAIL",
).trim().toLocaleLowerCase("en-US");
const password = readRequiredSecret(
  process.env.PACKSCOUT_BOOTSTRAP_ADMIN_PASSWORD,
  "PACKSCOUT_BOOTSTRAP_ADMIN_PASSWORD",
  12,
);
const displayName =
  process.env.PACKSCOUT_BOOTSTRAP_ADMIN_DISPLAY_NAME?.trim() || "Primary Admin";

function waitForListening(server: Server): Promise<Server> {
  if (server.listening) return Promise.resolve(server);
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function main(): Promise<void> {
  const harness = await createMigratedTestDatabase();
  let server: Server | undefined;
  let vite: import("vite").ViteDevServer | undefined;
  let shutdownPromise: Promise<void> | undefined;

  const shutDown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      let failure: unknown;
      try {
        if (server) await closeServer(server);
      } catch (error) {
        failure = error;
      }
      try {
        await vite?.close();
      } catch (error) {
        failure ??= error;
      }
      try {
        await harness.close();
      } catch (error) {
        failure ??= error;
      }
      if (failure) throw failure;
    })();
    return shutdownPromise;
  };

  const handleSignal = () => {
    void shutDown().catch(() => {
      console.error("PackScout local admin shutdown failed.");
      process.exitCode = 1;
    });
  };

  try {
    const organizationId = randomUUID();
    const setup = new PipelineSetupRepository(harness.database);
    await setup.createOrganization({
      id: organizationId,
      slug: "packscout-local",
      name: "PackScout Local",
    });
    const repository = new DrizzleAuthRepository(harness.database);
    const security = createNodeAuthSecurity(sessionSecret);
    const provisioned = await repository.provisionOperator({
      id: randomUUID(),
      organizationId,
      emailNormalized: email,
      displayName,
      passwordHash: await security.passwordHasher.hash(password),
      role: "admin",
      state: "active",
      now: new Date(),
    });
    if (provisioned.kind !== "created") {
      throw new Error("The local bootstrap administrator could not be provisioned.");
    }

    const origin = `http://127.0.0.1:${port}`;
    const providerActorKey = createHash("sha256")
      .update("packscout-local-provider-actor")
      .digest();
    const providerCredentialKey = createHash("sha256")
      .update("packscout-local-provider-credential")
      .digest();
    const operational = createAdminOperationalRuntime({
      database: harness.database,
      actorPseudonymKey: providerActorKey,
    });
    const auth = await createAdminAuthRuntime({
      repository,
      loginLimiter: new DatabaseLoginAttemptLimiter(harness.database, {
        windowMs: 15 * 60 * 1_000,
        blockMs: 15 * 60 * 1_000,
        maximumFailures: 8,
      }),
      audit: new DrizzleAuthAuditSink(harness.database),
      sessionSecret,
      sessionIdleMs: 60 * 60 * 1_000,
      sessionAbsoluteMs: 12 * 60 * 60 * 1_000,
      production: false,
      allowedOrigins: [origin, `http://localhost:${port}`],
    });
    const app = createAdminApp({
      auth,
      providers: createProviderAdminRuntime({
        repository: new DrizzleProviderConfigurationRepository(harness.database),
        healthRepository: new DrizzleProviderHealthRepository(harness.database),
        credentialKey: providerCredentialKey,
        actorPseudonymKey: providerActorKey,
        environment: "local",
        operational,
      }),
      importOperations: createAdminImportOperationsRuntime({
        database: harness.database,
        actorPseudonymKey: providerActorKey,
        credentialKey: providerCredentialKey,
        environment: "local",
        operational,
      }),
      operationalAlerts: { alerts: operational.alerts },
      operationalHealth: { health: operational.health },
    });
    const adminRoot = path.join(repositoryRoot, "apps", "admin");
    const { createServer: createViteServer } = await import("vite");
    const hmrPort = readPort(
      process.env.PACKSCOUT_ADMIN_HMR_PORT,
      port + 1,
      "PACKSCOUT_ADMIN_HMR_PORT",
    );
    vite = await createViteServer({
      root: adminRoot,
      server: {
        middlewareMode: true,
        hmr: { port: hmrPort },
      },
      appType: "spa",
    });
    app.use(vite.middlewares);

    server = await waitForListening(app.listen(port, "127.0.0.1"));
    process.once("SIGINT", handleSignal);
    process.once("SIGTERM", handleSignal);
    console.log(`PackScout local admin is available at ${origin}`);
  } catch (error) {
    await shutDown();
    throw error;
  }
}

main().catch(() => {
  console.error("PackScout local admin startup failed.");
  process.exitCode = 1;
});

import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";
import { Pool } from "pg";
import {
  createNodePostgresDatabase,
  DatabaseLoginAttemptLimiter,
  DrizzleAuthAuditSink,
  DrizzleAuthRepository,
  DrizzleProviderConfigurationRepository,
  DrizzleProviderHealthRepository,
} from "@packscout/database";
import { createAdminApp } from "./app.ts";
import { createAdminAuthRuntime } from "./auth/runtime.ts";
import { createAdminImportOperationsRuntime } from "./import-operations-runtime.ts";
import { createAdminOperationalRuntime } from "./operational-runtime.ts";
import { createProviderAdminRuntime } from "./provider-runtime.ts";
import {
  readAllowedOrigins,
  readBase64Key,
  readPort,
  readPositiveDuration,
  readRequiredSecret,
} from "./runtime-config.ts";

const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const adminRoot = path.resolve(serverDirectory, "..");
const workspaceRoot = path.resolve(adminRoot, "..", "..");

dotenv.config({ path: path.join(workspaceRoot, ".env") });

const port = readPort(
  process.env.PACKSCOUT_ADMIN_PORT,
  5101,
  "PACKSCOUT_ADMIN_PORT",
);
const isDevelopment = process.env.NODE_ENV !== "production";
const sessionIdleMs = readPositiveDuration(
  process.env.PACKSCOUT_SESSION_IDLE_MS,
  60 * 60 * 1_000,
  "PACKSCOUT_SESSION_IDLE_MS",
);
const sessionAbsoluteMs = readPositiveDuration(
  process.env.PACKSCOUT_SESSION_ABSOLUTE_MS,
  12 * 60 * 60 * 1_000,
  "PACKSCOUT_SESSION_ABSOLUTE_MS",
);
if (sessionAbsoluteMs < sessionIdleMs) {
  throw new Error(
    "PACKSCOUT_SESSION_ABSOLUTE_MS must be greater than or equal to PACKSCOUT_SESSION_IDLE_MS.",
  );
}
const databaseUrl = readRequiredSecret(
  process.env.PACKSCOUT_DATABASE_URL,
  "PACKSCOUT_DATABASE_URL",
);
const sessionSecret = readRequiredSecret(
  process.env.PACKSCOUT_SESSION_HASHING_SECRET,
  "PACKSCOUT_SESSION_HASHING_SECRET",
  32,
);
const providerCredentialKey = readBase64Key(
  process.env.PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64,
  "PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64",
);
const providerActorKey = readBase64Key(
  process.env.PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64,
  "PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64",
);
const allowedOrigins = readAllowedOrigins(
  process.env.PACKSCOUT_ADMIN_ALLOWED_ORIGINS,
  isDevelopment
    ? [`http://localhost:${port}`, `http://127.0.0.1:${port}`]
    : [],
  "PACKSCOUT_ADMIN_ALLOWED_ORIGINS",
);
const pool = new Pool({ connectionString: databaseUrl, max: 10 });
const database = createNodePostgresDatabase(pool);
const providerRepository = new DrizzleProviderConfigurationRepository(database);
const operational = createAdminOperationalRuntime({
  database,
  actorPseudonymKey: providerActorKey,
});
const auth = await createAdminAuthRuntime({
  repository: new DrizzleAuthRepository(database),
  loginLimiter: new DatabaseLoginAttemptLimiter(database, {
    windowMs: 15 * 60 * 1_000,
    blockMs: 15 * 60 * 1_000,
    maximumFailures: 8,
  }),
  audit: new DrizzleAuthAuditSink(database),
  sessionSecret,
  sessionIdleMs,
  sessionAbsoluteMs,
  production: !isDevelopment,
  allowedOrigins,
});
const app = createAdminApp({
  auth,
  providers: createProviderAdminRuntime({
    repository: providerRepository,
    healthRepository: new DrizzleProviderHealthRepository(database),
    credentialKey: providerCredentialKey,
    actorPseudonymKey: providerActorKey,
    environment: isDevelopment ? "local" : "production",
    operational,
  }),
  importOperations: createAdminImportOperationsRuntime({
    database,
    actorPseudonymKey: providerActorKey,
    credentialKey: providerCredentialKey,
    environment: isDevelopment ? "local" : "production",
    operational,
  }),
  operationalAlerts: { alerts: operational.alerts },
  operationalHealth: { health: operational.health },
});

if (isDevelopment) {
  const { createServer: createViteServer } = await import("vite");
  const hmrPort = readPort(
    process.env.PACKSCOUT_ADMIN_HMR_PORT,
    port + 1,
    "PACKSCOUT_ADMIN_HMR_PORT",
  );
  const vite = await createViteServer({
    root: adminRoot,
    server: {
      middlewareMode: true,
      hmr: { port: hmrPort },
    },
    appType: "spa",
  });

  app.use(vite.middlewares);
} else {
  const outputDirectory = path.join(adminRoot, "dist");
  app.use(express.static(outputDirectory));
  app.get("*", (_request, response) => {
    response.sendFile(path.join(outputDirectory, "index.html"));
  });
}

const server = app.listen(port, () => {
  console.log(`Packscout Admin is available at http://localhost:${port}`);
});

async function shutDown(): Promise<void> {
  server.close();
  await pool.end();
}

process.once("SIGINT", () => void shutDown());
process.once("SIGTERM", () => void shutDown());

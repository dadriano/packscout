import path from "node:path";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";
import type { ViteDevServer } from "vite";
import {
  createPrismaClientLifecycle,
  DatabaseLoginAttemptLimiter,
  PrismaAuthAuditSink,
  PrismaAuthRepository,
  PrismaProviderConfigurationRepository,
  PrismaProviderHealthRepository,
} from "@packscout/database";
import { createAdminApp } from "./app.ts";
import { createAdminAuthRuntime } from "./auth/runtime.ts";
import { createAdminBackgroundWorkRuntime } from "./background-work-runtime.ts";
import { createAdminImportOperationsRuntime } from "./import-operations-runtime.ts";
import { createAdminOperationalRuntime } from "./operational-runtime.ts";
import { createProviderAdminRuntime } from "./provider-runtime.ts";
import {
  adminDevelopmentAllowedOrigins,
  adminDevelopmentServerNetwork,
  readAllowedOrigins,
  readBase64Key,
  readServiceHost,
  readPort,
  readPositiveDuration,
  readRequiredSecret,
  readTrustedProxies,
  serviceHttpOrigin,
} from "./runtime-config.ts";

const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const adminRoot = path.resolve(serverDirectory, "..");
const workspaceRoot = path.resolve(adminRoot, "..", "..");

dotenv.config({ path: path.join(workspaceRoot, ".env") });

const isDevelopment = process.env.NODE_ENV !== "production";
const port = readPort(
  process.env.PACKSCOUT_ADMIN_PORT,
  5101,
  "PACKSCOUT_ADMIN_PORT",
);
const host = readServiceHost(
  process.env.PACKSCOUT_ADMIN_HOST,
  isDevelopment ? "127.0.0.1" : "0.0.0.0",
  "PACKSCOUT_ADMIN_HOST",
  isDevelopment,
);
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
  isDevelopment ? adminDevelopmentAllowedOrigins(host, port) : [],
  "PACKSCOUT_ADMIN_ALLOWED_ORIGINS",
);
const trustedProxies = readTrustedProxies(
  process.env.PACKSCOUT_ADMIN_TRUSTED_PROXIES,
  "PACKSCOUT_ADMIN_TRUSTED_PROXIES",
);

function waitForListening(server: Server): Promise<void> {
  if (server.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    const onError = () => {
      server.off("listening", onListening);
      reject(new Error("PackScout Admin failed to start listening."));
    };
    server.once("listening", onListening);
    server.once("error", onError);
  });
}

function closeHttpServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

const databaseLifecycle = createPrismaClientLifecycle({ databaseUrl });
let server: Server | undefined;
let developmentServer: ViteDevServer | undefined;
let shutdownPromise: Promise<void> | undefined;

try {
  await databaseLifecycle.start();
  const database = databaseLifecycle.client;
  const providerRepository = new PrismaProviderConfigurationRepository(database);
  const operational = createAdminOperationalRuntime({
    database,
    actorPseudonymKey: providerActorKey,
  });
  const auth = await createAdminAuthRuntime({
    repository: new PrismaAuthRepository(database),
    loginLimiter: new DatabaseLoginAttemptLimiter(database, {
      windowMs: 15 * 60 * 1_000,
      blockMs: 15 * 60 * 1_000,
      maximumFailures: 8,
    }),
    audit: new PrismaAuthAuditSink(database),
    sessionSecret,
    sessionIdleMs,
    sessionAbsoluteMs,
    production: !isDevelopment,
    allowedOrigins,
  });
  const app = createAdminApp({
    trustedProxies,
    auth,
    providers: createProviderAdminRuntime({
      repository: providerRepository,
      healthRepository: new PrismaProviderHealthRepository(database),
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
    backgroundWork: createAdminBackgroundWorkRuntime({
      database,
      actorPseudonymKey: providerActorKey,
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
    developmentServer = await createViteServer({
      root: adminRoot,
      server: adminDevelopmentServerNetwork(host, hmrPort),
      appType: "spa",
    });

    app.use(developmentServer.middlewares);
  } else {
    const outputDirectory = path.join(adminRoot, "dist");
    app.use(express.static(outputDirectory));
    app.get("*", (_request, response) => {
      response.sendFile(path.join(outputDirectory, "index.html"));
    });
  }

  server = app.listen(port, host);
  await waitForListening(server);
  process.once("SIGINT", handleShutdownSignal);
  process.once("SIGTERM", handleShutdownSignal);
  console.log(`Packscout Admin is available at ${serviceHttpOrigin(host, port)}`);
} catch (error) {
  await closeHttpServer(server).catch(() => undefined);
  await developmentServer?.close().catch(() => undefined);
  await databaseLifecycle.close().catch(() => undefined);
  throw error;
}

function shutDown(): Promise<void> {
  shutdownPromise ??= (async () => {
    let shutdownError: unknown;
    try {
      await closeHttpServer(server);
    } catch (error) {
      shutdownError = error;
    }
    try {
      await developmentServer?.close();
    } catch (error) {
      shutdownError ??= error;
    }
    try {
      await databaseLifecycle.close();
    } catch (error) {
      shutdownError ??= error;
    }
    if (shutdownError) throw new Error("PackScout Admin shutdown failed.");
  })();
  return shutdownPromise;
}

function handleShutdownSignal(): void {
  void shutDown().catch(() => {
    console.error("PackScout Admin shutdown failed.");
    process.exitCode = 1;
  });
}

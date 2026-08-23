import path from "node:path";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";
import type { ViteDevServer } from "vite";
import { RECOMPUTATION_BACKLOG_DEPTH_DEFAULT } from "@packscout/contracts";
import { MachineryAlertService } from "@packscout/services";
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
import {
  createAdminMachineryAlertFactsSource,
  createAdminMachineryAlertObserver,
  startMachineryAlertLoop,
  type MachineryAlertLoop,
} from "./machinery-alert-runtime.ts";
import { createAdminOperationalRuntime } from "./operational-runtime.ts";
import { createBetaAllowlistAuditSink } from "./beta-allowlist-audit.ts";
import { createBetaAllowlistDirectoryClient } from "./beta-allowlist-directory.ts";
import { createProductUserAuditSink } from "./product-user-audit.ts";
import { createProductUserDirectoryReader } from "./product-user-directory.ts";
import { createProviderAdminRuntime } from "./provider-runtime.ts";
import { createAdminWorkerFleetRuntime } from "./worker-fleet-runtime.ts";
import { createAdminMessageDeliveryRuntime } from "./message-delivery-runtime.ts";
import {
  adminDevelopmentAllowedOrigins,
  adminDevelopmentServerNetwork,
  readAllowedOrigins,
  readBase64Key,
  readProductUserDirectoryConfig,
  readServiceHost,
  readPort,
  readPositiveCount,
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
/**
 * How often the machinery conditions are evaluated. The cadence only decides
 * how quickly a condition is noticed; the thresholds themselves come from the
 * settings the worker fleet publishes.
 */
const machineryAlertIntervalMs = readPositiveDuration(
  process.env.PACKSCOUT_ADMIN_MACHINERY_ALERT_INTERVAL_MS,
  60 * 1_000,
  "PACKSCOUT_ADMIN_MACHINERY_ALERT_INTERVAL_MS",
);
/** Shared by the background-work page and the queue-depth alert condition. */
const recomputationBacklogLimit = readPositiveCount(
  process.env.PACKSCOUT_ADMIN_RECOMPUTATION_BACKLOG_LIMIT,
  RECOMPUTATION_BACKLOG_DEPTH_DEFAULT,
  "PACKSCOUT_ADMIN_RECOMPUTATION_BACKLOG_LIMIT",
);
/**
 * The product backend's admin surface. Absent or unusable configuration leaves
 * the directory unconfigured rather than stopping the admin: every pipeline
 * workflow stays available and the users page explains the missing integration.
 */
const productUserDirectoryConfig = readProductUserDirectoryConfig({
  baseUrl: process.env.PACKSCOUT_ADMIN_DIRECTORY_URL,
  token: process.env.PACKSCOUT_ADMIN_DIRECTORY_TOKEN,
});

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
let machineryAlerts: MachineryAlertLoop | undefined;
let shutdownPromise: Promise<void> | undefined;

try {
  await databaseLifecycle.start();
  const database = databaseLifecycle.client;
  const providerRepository = new PrismaProviderConfigurationRepository(database);
  const operational = createAdminOperationalRuntime({
    database,
    actorPseudonymKey: providerActorKey,
    alertEmail: { env: process.env },
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
      backlogDepthLimit: recomputationBacklogLimit,
    }),
    workerFleet: createAdminWorkerFleetRuntime({ database }),
    productUsers: {
      directory: createProductUserDirectoryReader({
        config: productUserDirectoryConfig,
      }),
      audit: createProductUserAuditSink({
        database,
        actorPseudonymKey: providerActorKey,
      }),
    },
    // The allowlist lives with the product backend and is reached through the
    // same integration and credential as the directory reads above.
    betaAllowlist: {
      directory: createBetaAllowlistDirectoryClient({
        config: productUserDirectoryConfig,
      }),
      audit: createBetaAllowlistAuditSink({
        database,
        actorPseudonymKey: providerActorKey,
      }),
    },
    operationalAlerts: { alerts: operational.alerts },
    operationalHealth: { health: operational.health },
    // The delivery history reads the same durable outbox the worker drains.
    messages: createAdminMessageDeliveryRuntime({
      database,
      actorPseudonymKey: providerActorKey,
    }),
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

  // Fleet silence cannot be detected by the fleet, so the machinery conditions
  // are evaluated here: the admin is the always-on process that survives the
  // exact failure the loudest condition describes.
  const machineryAlertService = new MachineryAlertService(
    createAdminMachineryAlertFactsSource({
      database,
      backlogDepthLimit: recomputationBacklogLimit,
    }),
    operational.events,
    // Alerting that cannot read its evidence is indistinguishable from a
    // healthy pipeline, so a degraded or unreadable cycle says so.
    createAdminMachineryAlertObserver(),
  );
  machineryAlerts = startMachineryAlertLoop({
    cycle: () => machineryAlertService.runCycle(),
    intervalMs: machineryAlertIntervalMs,
    onFailure: () => {
      // A cycle that evaluated nothing rejects rather than reporting a quiet
      // all-zero result, and lands here. Names the failed capability, never
      // any evidence it was reading.
      console.error(
        JSON.stringify({
          level: "error",
          event: "admin_machinery_alert_cycle_failed",
        }),
      );
    },
  });

  server = app.listen(port, host);
  await waitForListening(server);
  process.once("SIGINT", handleShutdownSignal);
  process.once("SIGTERM", handleShutdownSignal);
  console.log(`Packscout Admin is available at ${serviceHttpOrigin(host, port)}`);
  if (productUserDirectoryConfig === null) {
    // Names the missing capability, never any configuration value.
    console.log(
      "Packscout Admin: the product-user directory integration is not configured.",
    );
  }
} catch (error) {
  await machineryAlerts?.stop().catch(() => undefined);
  await closeHttpServer(server).catch(() => undefined);
  await developmentServer?.close().catch(() => undefined);
  await databaseLifecycle.close().catch(() => undefined);
  throw error;
}

function shutDown(): Promise<void> {
  shutdownPromise ??= (async () => {
    let shutdownError: unknown;
    try {
      await machineryAlerts?.stop();
    } catch (error) {
      shutdownError = error;
    }
    try {
      await closeHttpServer(server);
    } catch (error) {
      shutdownError ??= error;
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

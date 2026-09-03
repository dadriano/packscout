import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";
import type { ViteDevServer } from "vite";
import {
  startMachineryAlertLoop,
  type MachineryAlertLoop,
} from "./machinery-alert-runtime.ts";
import { createAdminProviderRuntimeFactory } from
  "./admin-provider-runtime-factory.ts";
import { createAdminRuntime, type AdminRuntime } from "./runtime.ts";
import {
  adminDevelopmentServerNetwork,
  readPort,
  serviceHttpOrigin,
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

let runtime: AdminRuntime | undefined;
let server: Server | undefined;
let developmentServer: ViteDevServer | undefined;
let machineryAlerts: MachineryAlertLoop | undefined;
let shutdownPromise: Promise<void> | undefined;

try {
  runtime = await createAdminRuntime({
    port,
    providerRuntimeFactory: createAdminProviderRuntimeFactory,
  });
  const { app, configuration } = runtime;

  if (configuration.development) {
    const { createServer: createViteServer } = await import("vite");
    const hmrPort = readPort(
      process.env.PACKSCOUT_ADMIN_HMR_PORT,
      port + 1,
      "PACKSCOUT_ADMIN_HMR_PORT",
    );
    developmentServer = await createViteServer({
      root: adminRoot,
      server: adminDevelopmentServerNetwork(configuration.host, hmrPort),
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

  machineryAlerts = startMachineryAlertLoop({
    cycle: () => runtime?.runMachineryAlertCycle() ?? Promise.resolve(),
    intervalMs: configuration.machineryAlertIntervalMs,
    onFailure: () => {
      console.error(
        JSON.stringify({
          level: "error",
          event: "admin_machinery_alert_cycle_failed",
        }),
      );
    },
  });

  server = app.listen(port, configuration.host);
  await waitForListening(server);
  process.once("SIGINT", handleShutdownSignal);
  process.once("SIGTERM", handleShutdownSignal);
  console.log(
    `Packscout Admin is available at ${serviceHttpOrigin(configuration.host, port)}`,
  );
  if (!configuration.productUserDirectoryConfigured) {
    console.log(
      "PackScout Admin: the product-user directory integration is not configured.",
    );
  }
  if (!configuration.sourceAdministrationConfigured) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "admin_source_administration_unconfigured",
      }),
    );
  }
  if (!configuration.emailLinkTokenConfigured) {
    console.log(
      "PackScout Admin: the operator password reset flow is not configured.",
    );
  }
} catch (error) {
  await machineryAlerts?.stop().catch(() => undefined);
  await closeHttpServer(server).catch(() => undefined);
  await developmentServer?.close().catch(() => undefined);
  await runtime?.close().catch(() => undefined);
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
      await runtime?.close();
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

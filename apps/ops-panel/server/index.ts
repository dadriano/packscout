import type { Server } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ViteDevServer } from "vite";
import { createOpsPanelApp } from "./app.ts";
import { createFileAuditTrailStore, AUDIT_FILE_NAME } from "./audit-file-store.ts";
import { createAuditTrail } from "./core/audit-trail.ts";
import { createLogSourceRegistry } from "./core/log-sources.ts";
import {
  describeStartupFailure,
  panelOrigin,
  readOpsPanelConfiguration,
} from "./core/runtime-config.ts";
import {
  resolvePanelStateDirectory,
  resolveServiceLogDirectory,
} from "./core/service-logs.ts";
import { createLogSourcePoller } from "./log-source-poller.ts";

/**
 * The PackScout operations panel: a local developer tool.
 *
 * One process serves the API and the UI. It binds loopback only, so it is never
 * reachable from another machine — remote use is an SSH tunnel that lands on
 * this same bind. There is no production deployment target, by design.
 */

const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const panelRoot = path.resolve(serverDirectory, "..");

if (process.env.NODE_ENV === "production") {
  throw new Error(
    "The PackScout operations panel is a local tool and has no production mode. Run it with npm run dev:ops-panel.",
  );
}

const descriptor = {
  env: process.env,
  platform: process.platform,
  homeDirectory: homedir(),
};
const configuration = readOpsPanelConfiguration(process.env);
const logDirectory = resolveServiceLogDirectory(descriptor);
const auditFilePath = path.join(
  resolvePanelStateDirectory(descriptor),
  AUDIT_FILE_NAME,
);

function waitForListening(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    server.once("listening", onListening);
    server.once("error", onError);
  });
}

function closeHttpServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

let server: Server | undefined;
let developmentServer: ViteDevServer | undefined;
let shutdownPromise: Promise<void> | undefined;

const registry = createLogSourceRegistry();
const poller = createLogSourcePoller({
  directory: logDirectory,
  registry,
  intervalMs: configuration.pollIntervalMs,
  onError: (error) =>
    console.error("PackScout operations panel log discovery failed:", error),
});

try {
  const audit = await createAuditTrail({
    store: createFileAuditTrailStore(auditFilePath),
    onPersistenceError: (error) =>
      console.error("PackScout operations panel audit trail is not persisting:", error),
  });
  const app = createOpsPanelApp({
    audit,
    registry,
    logDirectory,
    pollIntervalMs: configuration.pollIntervalMs,
  });

  // Claim the port before starting Vite, so a taken port fails with the panel's
  // own message instead of a development-server stack trace.
  server = app.listen(configuration.port, configuration.host);
  await waitForListening(server);

  const { createServer: createViteServer } = await import("vite");
  developmentServer = await createViteServer({
    root: panelRoot,
    server: {
      middlewareMode: true,
      hmr: { host: configuration.host, port: configuration.hmrPort },
    },
    appType: "spa",
  });
  app.use(developmentServer.middlewares);
  poller.start();

  process.once("SIGINT", handleShutdownSignal);
  process.once("SIGTERM", handleShutdownSignal);
  console.log(
    `PackScout operations panel is available at ${panelOrigin(configuration.host, configuration.port)}`,
  );
  console.log(`  service logs: ${logDirectory}`);
  console.log(`  activity trail: ${auditFilePath}`);
} catch (error) {
  console.error(
    describeStartupFailure(error, {
      host: configuration.host,
      port: configuration.port,
    }),
  );
  poller.stop();
  await closeHttpServer(server);
  await developmentServer?.close().catch(() => undefined);
  process.exit(1);
}

function shutDown(): Promise<void> {
  shutdownPromise ??= (async () => {
    poller.stop();
    await closeHttpServer(server);
    await developmentServer?.close().catch(() => undefined);
  })();
  return shutdownPromise;
}

function handleShutdownSignal(): void {
  void shutDown().catch(() => {
    console.error("PackScout operations panel shutdown failed.");
    process.exitCode = 1;
  });
}

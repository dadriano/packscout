import type { Server } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ViteDevServer } from "vite";
import { createOpsPanelApp } from "./app.ts";
import { createFileAuditTrailStore, AUDIT_FILE_NAME } from "./audit-file-store.ts";
import { createAuditTrail } from "./core/audit-trail.ts";
import {
  DATABASE_URL_VARIABLE,
  readDatabaseConnectionSecret,
  requireLocalDatabaseTarget,
} from "./core/database-target.ts";
import { createLogSourceRegistry } from "./core/log-sources.ts";
import { createLogStreamHub } from "./core/log-stream-hub.ts";
import { createDatabaseOperationRunner } from "./core/operation-supervisor.ts";
import { redactSecrets } from "./core/secret-redaction.ts";
import { createStudioSupervisor } from "./core/studio-supervisor.ts";
import { createDatabaseMonitor } from "./database-monitor.ts";
import { createLogTailReader } from "./log-tail-reader.ts";
import {
  createFileOperationMarkerStore,
  OPERATION_MARKER_FILE_NAME,
} from "./operation-marker-store.ts";
import { createOperationSpawn } from "./operation-process.ts";
import { resolvePrismaWorkspacePaths } from "./repository-migrations.ts";
import { createStudioSpawn } from "./studio-process.ts";
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
const workspaceRoot = path.resolve(panelRoot, "..", "..");

if (process.env.NODE_ENV === "production") {
  throw new Error(
    "The PackScout operations panel is a local tool and has no production mode. Run it with npm run dev:ops-panel.",
  );
}

// The panel reads the same configuration the applications read, so the database
// it reports on is the database they use. Node's own loader is enough; a missing
// file simply leaves the process environment as it is, which the status surface
// then reports as "no database configured" rather than guessing.
try {
  process.loadEnvFile(path.join(workspaceRoot, ".env"));
} catch {
  // No workspace .env: the process environment stands on its own.
}

const descriptor = {
  env: process.env,
  platform: process.platform,
  homeDirectory: homedir(),
};
const configuration = readOpsPanelConfiguration(process.env);
const logDirectory = resolveServiceLogDirectory(descriptor);
const panelStateDirectory = resolvePanelStateDirectory(descriptor);
const auditFilePath = path.join(panelStateDirectory, AUDIT_FILE_NAME);
const operationMarkerPath = path.join(
  panelStateDirectory,
  OPERATION_MARKER_FILE_NAME,
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
let operations: ReturnType<typeof createDatabaseOperationRunner> | undefined;

const registry = createLogSourceRegistry();
const poller = createLogSourcePoller({
  directory: logDirectory,
  registry,
  intervalMs: configuration.pollIntervalMs,
  onError: (error) =>
    console.error("PackScout operations panel log discovery failed:", error),
});
const hub = createLogStreamHub();
const reader = createLogTailReader({
  directory: logDirectory,
  registry,
  hub,
  intervalMs: configuration.tailIntervalMs,
  onError: (error) =>
    console.error("PackScout operations panel log tailing failed:", error),
});

const prismaPaths = resolvePrismaWorkspacePaths(workspaceRoot);
/**
 * The row browser is a second HTTP listener, so it is bound to the panel's own
 * loopback address and its start is permitted only while the configured database
 * is provably local — re-checked at the moment of each attempt, never cached.
 */
const studio = createStudioSupervisor({
  port: configuration.studioPort,
  hostname: configuration.host,
  permit: () => {
    const decision = requireLocalDatabaseTarget(process.env);
    return decision.ok ? { allowed: true } : { allowed: false, message: decision.message };
  },
  spawn: (request) =>
    createStudioSpawn({
      workspaceRoot,
      schemaFile: prismaPaths.schemaFile,
      // Read at spawn time and passed only through the child's environment.
      connectionString: readDatabaseConnectionSecret(process.env) ?? "",
      databaseUrlVariable: DATABASE_URL_VARIABLE,
    })(request),
});
const databaseMonitor = createDatabaseMonitor({
  env: process.env,
  migrationsDirectory: prismaPaths.migrationsDirectory,
  supervisor: studio,
  refreshIntervalMs: configuration.databaseRefreshMs,
  onError: (error) =>
    console.error("PackScout operations panel database status failed:", error),
});

try {
  const audit = await createAuditTrail({
    store: createFileAuditTrailStore(auditFilePath),
    onPersistenceError: (error) =>
      console.error("PackScout operations panel audit trail is not persisting:", error),
  });
  /**
   * The three registered database operations. Their guards are re-evaluated at
   * the moment of each attempt, their outcome is recorded in the same audit
   * trail as every other privileged attempt, and the status surface is refreshed
   * when one finishes so the operator sees the result without reloading.
   */
  operations = createDatabaseOperationRunner({
    permit: () => requireLocalDatabaseTarget(process.env),
    markerStore: createFileOperationMarkerStore(operationMarkerPath),
    sanitize: (text) =>
      redactSecrets(text, [readDatabaseConnectionSecret(process.env)]),
    spawn: createOperationSpawn({
      workspaceRoot,
      readConnectionString: () => readDatabaseConnectionSecret(process.env),
      databaseUrlVariable: DATABASE_URL_VARIABLE,
    }),
    onSettled: (run) => {
      void audit
        .record({
          action: `operation ${run.operation}`,
          method: "POST",
          route: `/api/database/operations/${run.operation}`,
          outcome: run.outcome === "succeeded" ? "succeeded" : "failed",
          detail: run.message ?? `${run.label} finished with ${run.outcome}.`,
        })
        .catch((error: unknown) =>
          console.error("PackScout operations panel audit trail failed:", error),
        );
      void databaseMonitor
        .refresh()
        .catch((error: unknown) =>
          console.error("PackScout operations panel status refresh failed:", error),
        );
    },
    onPersistenceError: (error) =>
      console.error(
        "PackScout operations panel could not record the in-flight operation:",
        error,
      ),
  });
  // Adopt anything the previous process left in flight before serving a request,
  // so an interrupted run is reported rather than overwritten by the next one.
  await operations.restore();

  const app = createOpsPanelApp({
    audit,
    registry,
    hub,
    reader,
    logDirectory,
    pollIntervalMs: configuration.pollIntervalMs,
    database: {
      monitor: databaseMonitor,
      supervisor: studio,
      operations,
      env: process.env,
    },
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
  reader.start();

  process.once("SIGINT", handleShutdownSignal);
  process.once("SIGTERM", handleShutdownSignal);
  // Last resort: however the panel ends, its children go with it. The in-flight
  // marker is deliberately left in place, so the next start reports the
  // interrupted operation's outcome as unknown instead of losing it.
  process.once("exit", () => {
    studio.shutdown();
    operations?.shutdown();
  });
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
  reader.stop();
  databaseMonitor.stop();
  studio.shutdown();
  operations?.shutdown();
  await closeHttpServer(server);
  await developmentServer?.close().catch(() => undefined);
  process.exit(1);
}

function shutDown(): Promise<void> {
  shutdownPromise ??= (async () => {
    poller.stop();
    reader.stop();
    databaseMonitor.stop();
    // The row browser and any running operation are child processes: the panel
    // never leaves one behind.
    studio.shutdown();
    operations?.shutdown();
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

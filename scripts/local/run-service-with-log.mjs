#!/usr/bin/env node

/**
 * Run one PackScout service and tee its output to the per-service log file.
 *
 * The supervised launchd workflow already redirects each service's output to
 * `<log directory>/<service>.log`. The plain development workflow left
 * everything on stdout, so nothing was discoverable. This wrapper closes that
 * gap: output still reaches the terminal, and the same file the operations
 * panel discovers is written alongside it.
 *
 * Usage:
 *   node --import tsx scripts/local/run-service-with-log.mjs <service>
 *
 * The service name selects a known npm script. There is deliberately no way to
 * pass an arbitrary command through this wrapper.
 */

import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  logFileNameForService,
  resolveServiceLogDirectory,
} from "../../apps/ops-panel/server/core/service-logs.ts";
import {
  beginLocalProcessGroupTermination,
  spawnLocalProcessGroup,
} from "./process-group.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/** Known services only: a fixed map, never a caller-supplied command. */
const SERVICE_COMMANDS = new Map([
  ["frontend", "dev:frontend"],
  ["admin", "dev:admin"],
  ["worker", "dev:worker"],
  ["ops-panel", "dev:ops-panel"],
]);

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

const [service] = process.argv.slice(2);
if (!service) {
  fail(
    `A service name is required. Known services: ${[...SERVICE_COMMANDS.keys()].join(", ")}`,
  );
}
const npmScript = SERVICE_COMMANDS.get(service);
if (!npmScript) {
  fail(
    `Unknown PackScout service: ${service}. Known services: ${[...SERVICE_COMMANDS.keys()].join(", ")}`,
  );
}

const logDirectory = resolveServiceLogDirectory({
  env: process.env,
  platform: process.platform,
  homeDirectory: homedir(),
});
const logPath = path.join(logDirectory, logFileNameForService(service));

await mkdir(logDirectory, { recursive: true, mode: 0o700 });
const logStream = createWriteStream(logPath, { flags: "a", mode: 0o600 });
await new Promise((resolve, reject) => {
  logStream.once("open", resolve);
  logStream.once("error", reject);
});
logStream.write(
  `\n--- ${service} started ${new Date().toISOString()} (npm run ${npmScript}) ---\n`,
);
console.log(`Teeing ${service} output to ${logPath}`);

const child = spawnLocalProcessGroup("npm", ["run", npmScript], {
  cwd: repositoryRoot,
  env: process.env,
  stdio: ["inherit", "pipe", "pipe"],
});

child.stdout?.on("data", (chunk) => {
  process.stdout.write(chunk);
  logStream.write(chunk);
});
child.stderr?.on("data", (chunk) => {
  process.stderr.write(chunk);
  logStream.write(chunk);
});

let finishTermination;
function shutDown() {
  finishTermination ??= beginLocalProcessGroupTermination(child);
}
process.once("SIGINT", shutDown);
process.once("SIGTERM", shutDown);

child.once("error", (error) => {
  logStream.write(`--- ${service} failed to start: ${error.message} ---\n`);
  fail(`${service} could not start: ${error.message}`);
});

child.once("exit", (code, signal) => {
  finishTermination?.();
  logStream.end(
    `--- ${service} exited ${signal ?? code ?? 0} at ${new Date().toISOString()} ---\n`,
  );
  process.exitCode = typeof code === "number" ? code : 1;
});

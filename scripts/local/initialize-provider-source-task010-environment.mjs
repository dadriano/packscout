#!/usr/bin/env node

import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TASK010_LOCAL_ACKNOWLEDGEMENT,
  TASK010_SAFETY_VERSION,
  TASK010_SOURCE_EXECUTION_SLOTS,
  Task010SafetyError,
  assertNoTask010Arguments,
  safeTask010Failure,
} from "./provider-source-task010-safety.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const environmentFile = path.join(workspaceRoot, ".env.task010.local");

function base64(bytes = 32) {
  return randomBytes(bytes).toString("base64");
}

async function main() {
  assertNoTask010Arguments(process.argv.slice(2));
  const contents = [
    "# Mode 0600, git-ignored Task 010 local state. Never commit or print this file.",
    "NODE_ENV=development",
    `PACKSCOUT_TASK010_LOCAL_ACK=${TASK010_LOCAL_ACKNOWLEDGEMENT}`,
    "PACKSCOUT_TASK010_DATABASE_NAME=packscout_dataforest_task010",
    "PACKSCOUT_DATABASE_URL=REPLACE_WITH_EXACT_LOCAL_POSTGRES_URL",
    "PACKSCOUT_SOURCE_DATABASE_VOLUME_PATH=REPLACE_WITH_EXACT_LOCAL_POSTGRES_VOLUME_PATH",
    "PACKSCOUT_TASK010_DATABASE_IDENTITY=",
    `PACKSCOUT_TASK010_ORGANIZATION_ID=${randomUUID()}`,
    "PACKSCOUT_TASK010_ORGANIZATION_SLUG=packscout-task010-local",
    "PACKSCOUT_TASK010_ORGANIZATION_NAME=PackScout Task 010 Local",
    `PACKSCOUT_TASK010_ADMIN_ID=${randomUUID()}`,
    "PACKSCOUT_TASK010_ADMIN_EMAIL=REPLACE_WITH_LOCAL_ADMIN_EMAIL",
    "PACKSCOUT_TASK010_ADMIN_DISPLAY_NAME=Local Source Administrator",
    "PACKSCOUT_TASK010_ADMIN_PASSWORD=REPLACE_FROM_PASSWORD_MANAGER",
    `PACKSCOUT_SESSION_HASHING_SECRET=${randomBytes(48).toString("base64url")}`,
    `PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64=${base64()}`,
    `PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64=${base64()}`,
    `PACKSCOUT_SOURCE_CONNECTION_KEY_BASE64=${base64()}`,
    "PACKSCOUT_SOURCE_CONNECTION_KEY_VERSION=1",
    `PACKSCOUT_SOURCE_EXECUTION_SLOTS=${TASK010_SOURCE_EXECUTION_SLOTS}`,
    "PACKSCOUT_ADMIN_HOST=127.0.0.1",
    "PACKSCOUT_ADMIN_PORT=5101",
    "PACKSCOUT_ADMIN_HMR_PORT=5102",
    "PACKSCOUT_ADMIN_ALLOWED_ORIGINS=http://127.0.0.1:5101,http://localhost:5101",
    "PACKSCOUT_ADMIN_TRUSTED_PROXIES=",
    "PACKSCOUT_SESSION_IDLE_MS=3600000",
    "PACKSCOUT_SESSION_ABSOLUTE_MS=43200000",
    "PACKSCOUT_WORKER_ID=task010-source-supervisor-local",
    "",
  ].join("\n");
  try {
    await writeFile(environmentFile, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      throw new Task010SafetyError("TASK010_ENVIRONMENT_FILE_EXISTS");
    }
    throw error;
  }
  process.stdout.write(
    `${JSON.stringify({
      version: TASK010_SAFETY_VERSION,
      ok: true,
      operation: "initialize_ignored_environment",
      file: ".env.task010.local",
      mode: "0600",
    })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify(safeTask010Failure(error))}\n`);
  process.exitCode = 1;
});

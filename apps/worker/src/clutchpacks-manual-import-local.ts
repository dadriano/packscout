import { hostname } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createProviderDatabaseLifecycle } from "@packscout/database";
import { createClutchpacksManualImportExecutor } from
  "./clutchpacks-manual-import-executor.ts";
import {
  ClutchpacksManualImportLocalError,
  runClutchpacksManualImportOnce,
} from "./clutchpacks-manual-import-local-runtime.ts";

const workerRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const workspaceRoot = path.resolve(workerRoot, "..", "..");
dotenv.config({ path: path.join(workspaceRoot, ".env") });

const fallbackWorkerId = `${
  hostname().replaceAll(/[^A-Za-z0-9._-]/gu, "-").slice(0, 64) || "host"
}:${process.pid}:${randomUUID()}`;

runClutchpacksManualImportOnce({
  environment: process.env,
  fallbackWorkerId,
  dependencies: {
    createDatabaseLifecycle: createProviderDatabaseLifecycle,
    createExecutor: createClutchpacksManualImportExecutor,
  },
}).then(
  (result) => {
    console.log(JSON.stringify({
      level: "info",
      event: "clutchpacks_manual_import_once_finished",
      result,
    }));
  },
  (error: unknown) => {
    console.error(JSON.stringify({
      level: "error",
      event: "clutchpacks_manual_import_once_failed",
      failureCode: error instanceof ClutchpacksManualImportLocalError
        ? error.code
        : "CLUTCHPACKS_IMPORT_FAILED",
    }));
    process.exitCode = 1;
  },
);

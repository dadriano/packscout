import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderPrismaClient } from "@packscout/database";
import {
  ClutchpacksManualImportLocalError,
  readClutchpacksManualImportLocalConfiguration,
  runClutchpacksManualImportOnce,
} from "./clutchpacks-manual-import-local-runtime.ts";

const providerId = "00000000-0000-4000-8000-000000000020";
const actorKey = Buffer.alloc(32, 17).toString("base64");

function environment(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    PACKSCOUT_PROVIDER_DATABASE_URL:
      "postgresql://provider:secret@127.0.0.1:5432/packscout_clutchpacks",
    PACKSCOUT_PROVIDER_ID: providerId,
    PACKSCOUT_PROVIDER_KEY: "clutchpacks",
    PACKSCOUT_PROVIDER_CAPTURE_ROOT: "/srv/packscout/captures",
    PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64: actorKey,
    ...overrides,
  };
}

test("local ClutchPacks configuration stays explicit and provider-scoped", () => {
  const configuration = readClutchpacksManualImportLocalConfiguration(
    environment(),
    "preview:worker",
  );

  assert.equal(configuration.providerId, providerId);
  assert.equal(configuration.providerKey, "clutchpacks");
  assert.equal(configuration.captureRoot, "/srv/packscout/captures");
  assert.equal(configuration.actorHmacKey.byteLength, 32);
  assert.equal(configuration.workerId, "preview:worker");
});

test("local composition rejects another provider before constructing a database", async () => {
  let databaseCreations = 0;
  await assert.rejects(
    runClutchpacksManualImportOnce({
      environment: environment({ PACKSCOUT_PROVIDER_KEY: "courtyard" }),
      fallbackWorkerId: "preview:worker",
      dependencies: {
        createDatabaseLifecycle() {
          databaseCreations += 1;
          throw new Error("must not run");
        },
        createExecutor() {
          throw new Error("must not run");
        },
      },
    }),
    (error: unknown) =>
      error instanceof ClutchpacksManualImportLocalError
      && error.code === "CLUTCHPACKS_IMPORT_CONFIGURATION_INVALID",
  );
  assert.equal(databaseCreations, 0);
});

test("local composition starts one provider database and consumes one command", async () => {
  const events: string[] = [];
  const client = {} as ProviderPrismaClient;
  const result = await runClutchpacksManualImportOnce({
    environment: environment(),
    fallbackWorkerId: "preview:worker",
    dependencies: {
      createDatabaseLifecycle(input) {
        assert.equal(input.providerId, providerId);
        assert.equal(input.providerKey, "clutchpacks");
        assert.equal(input.connectionLimit, 2);
        return {
          client,
          async start() { events.push("database_started"); },
          async close() { events.push("database_closed"); },
        };
      },
      createExecutor(input) {
        assert.equal(input.database, client);
        assert.equal(input.captureRoot, "/srv/packscout/captures");
        assert.equal(input.workerId, "preview:worker");
        events.push("executor_created");
        return {
          async executeNext() {
            events.push("command_consumed");
            return {
              kind: "completed" as const,
              runId: "00000000-0000-4000-8000-000000000030",
              pageCount: 5,
              counters: {
                pages: 5,
                catalog: 946,
                pulls: 15,
                marketEvents: 15,
                accepted: 961,
                duplicate: 0,
                quarantined: 15,
                materialChanges: 961,
              },
            };
          },
        };
      },
    },
  });

  assert.equal(result.kind, "completed");
  assert.deepEqual(events, [
    "database_started",
    "executor_created",
    "command_consumed",
    "database_closed",
  ]);
});

test("local composition always closes the provider database", async () => {
  const events: string[] = [];
  await assert.rejects(runClutchpacksManualImportOnce({
    environment: environment(),
    fallbackWorkerId: "preview:worker",
    dependencies: {
      createDatabaseLifecycle() {
        return {
          client: {} as ProviderPrismaClient,
          async start() { events.push("database_started"); },
          async close() { events.push("database_closed"); },
        };
      },
      createExecutor() {
        return {
          async executeNext() {
            throw new Error("fixture execution failed");
          },
        };
      },
    },
  }), /fixture execution failed/u);
  assert.deepEqual(events, ["database_started", "database_closed"]);
});

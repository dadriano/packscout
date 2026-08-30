import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const activationModuleUrl = pathToFileURL(path.join(
  repositoryRoot,
  "scripts/local/activate-collector-crypt-dataforrest-source.mts",
)).href;
const confirmation =
  process.env.PACKSCOUT_RUN_COLLECTOR_CRYPT_ACTIVATION_DB_REGRESSION === "1";

test(
  "the Collector Crypt planner reads central state without decrypting or contacting DataForrest",
  { skip: !confirmation },
  () => {
    const childEnvironment = { ...process.env };
    delete childEnvironment.PACKSCOUT_DATA_API_TOKEN;
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `
          import { readFile } from "node:fs/promises";
          import dotenv from "dotenv";
          import { Pool } from "pg";
          import { inspectCollectorCryptDataforrestActivationPlanningState } from
            ${JSON.stringify(activationModuleUrl)};

          const environment = dotenv.parse(await readFile(".env", "utf8"));
          const pool = new Pool({
            connectionString: environment.PACKSCOUT_CENTRAL_DATABASE_URL,
            max: 1,
          });
          try {
            const state =
              await inspectCollectorCryptDataforrestActivationPlanningState(pool);
            process.stdout.write(JSON.stringify(state));
          } finally {
            await pool.end().catch(() => undefined);
          }
        `,
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: childEnvironment,
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const state = JSON.parse(result.stdout);
    assert.equal(state.providerKey, "collector_crypt");
    assert.ok(["active", "baseline"].includes(state.state));
    assert.ok([1, 2].includes(state.configVersionNumber));
  },
);

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const activationModuleUrl = pathToFileURL(path.join(
  repositoryRoot,
  "scripts/local/activate-clutchpacks-dataforrest-source.mts",
)).href;
const confirmation =
  process.env.PACKSCOUT_RUN_CLUTCHPACKS_ACTIVATION_DB_REGRESSION === "1";

test(
  "the production activation planner reads the local PostgreSQL 16 snapshot without contacting DataForrest",
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
          import { inspectClutchpacksDataforrestActivationPlanningState } from
            ${JSON.stringify(activationModuleUrl)};

          const environment = dotenv.parse(await readFile(".env", "utf8"));
          const pool = new Pool({
            connectionString: environment.PACKSCOUT_CENTRAL_DATABASE_URL,
            max: 1,
          });
          try {
            const state = await inspectClutchpacksDataforrestActivationPlanningState(
              pool,
              environment.PACKSCOUT_PROVIDER_ID,
            );
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

    assert.equal(
      result.status,
      0,
      "production activation snapshot planning should succeed",
    );
    const state = JSON.parse(result.stdout);
    assert.equal(state.providerKey, "clutchpacks");
    assert.ok(
      ["active", "baseline", "upgrade_required"].includes(state.state),
    );
    assert.ok([1, 2, 3].includes(state.configVersionNumber));
    if (state.configVersionNumber === 1) assert.equal(state.state, "baseline");
    if (state.configVersionNumber === 3) assert.equal(state.state, "active");
    assert.equal(state.adminOperatorPresent, true);
  },
);

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workerRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("production liveness executable is dynamic central routing, never a legacy composite", async () => {
  const source = await readFile(
    path.join(workerRoot, "src", "promotion-job-liveness-main.ts"),
    "utf8",
  );
  for (const required of [
    "createCentralDatabaseLifecycle",
    "BoundedProviderDatabaseGateway",
    "CipherProviderDatabaseCredentialResolver",
    "createPromotionJobLivenessOneShot",
    "PromotionJobSystemConditionWebhook",
  ]) assert.match(source, new RegExp(required, "u"), required);
  for (const forbidden of [
    "createProviderDatabaseLifecycle",
    "PACKSCOUT_PROVIDER_DATABASE_URL",
    "DistributedPromotionJobRuntime",
    "ProviderPromotionBootstrapGatewayClient",
    "VerifiedManifestGateProofGatewayClient",
    "fixedRoster",
  ]) assert.doesNotMatch(source, new RegExp(forbidden, "u"), forbidden);
});

test("local and production scripts run the same isolated evaluator entrypoint", async () => {
  const packageJson = JSON.parse(await readFile(
    path.join(workerRoot, "package.json"),
    "utf8",
  )) as { scripts: Record<string, string> };
  assert.equal(
    packageJson.scripts["start:promotion-job-liveness-evaluator:local"],
    "NODE_ENV=development PACKSCOUT_PROMOTION_LIVENESS_RUN_MODE=daemon tsx src/promotion-job-liveness-main.ts",
  );
  assert.equal(
    packageJson.scripts["start:promotion-job-liveness-evaluator:production"],
    "NODE_ENV=production PACKSCOUT_PROMOTION_LIVENESS_RUN_MODE=daemon tsx src/promotion-job-liveness-main.ts",
  );
  assert.equal(
    packageJson.scripts["run:promotion-job-liveness-evaluator-once:local"],
    "NODE_ENV=development PACKSCOUT_PROMOTION_LIVENESS_RUN_MODE=once tsx src/promotion-job-liveness-main.ts",
  );
  assert.equal(
    packageJson.scripts["run:promotion-job-liveness-evaluator-once:production"],
    "NODE_ENV=production PACKSCOUT_PROMOTION_LIVENESS_RUN_MODE=once tsx src/promotion-job-liveness-main.ts",
  );
});

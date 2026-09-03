import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workerRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("production relay executable composes only central roster and bounded provider gateways", async () => {
  const source = await readFile(
    path.join(workerRoot, "src", "provider-activity-relay-main.ts"),
    "utf8",
  );
  for (const required of [
    "createCentralDatabaseLifecycle",
    "BoundedProviderDatabaseGateway",
    "CipherProviderDatabaseCredentialResolver",
    "ProviderDatabaseDestinationPolicy",
    "createProviderActivityRelayCoordinator",
    "PrismaManifestPromotionImmediateDeliveryRepository",
    "runProviderActivityRelayProcess",
    "immediateDelivery",
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

test("local and production scripts run the same isolated relay entrypoint", async () => {
  const packageJson = JSON.parse(await readFile(
    path.join(workerRoot, "package.json"),
    "utf8",
  )) as { scripts: Record<string, string> };
  assert.equal(
    packageJson.scripts["start:provider-activity-relay:local"],
    "NODE_ENV=development PACKSCOUT_PROMOTION_RELAY_RUN_MODE=daemon tsx src/provider-activity-relay-main.ts",
  );
  assert.equal(
    packageJson.scripts["start:provider-activity-relay:production"],
    "NODE_ENV=production PACKSCOUT_PROMOTION_RELAY_RUN_MODE=daemon tsx src/provider-activity-relay-main.ts",
  );
  assert.equal(
    packageJson.scripts["run:provider-activity-relay-once:local"],
    "NODE_ENV=development PACKSCOUT_PROMOTION_RELAY_RUN_MODE=once tsx src/provider-activity-relay-main.ts",
  );
  assert.equal(
    packageJson.scripts["run:provider-activity-relay-once:production"],
    "NODE_ENV=production PACKSCOUT_PROMOTION_RELAY_RUN_MODE=once tsx src/provider-activity-relay-main.ts",
  );
});

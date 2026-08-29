import path from "node:path";
import { runWithPostgresAdvisoryOperationGuard } from "@packscout/database";
import express from "express";
import { createAdminProviderRuntimeFactory } from
  "./admin-provider-runtime-factory.ts";
import { createAdminRuntime } from "./runtime.ts";
import { readRequiredSecret } from "./runtime-config.ts";
import { createVercelAdminApp } from "./vercel/app.ts";
import { resolveVercelAdminRoot } from "./vercel/app-paths.ts";
import { createRetryingSingleFlight } from "./vercel/runtime-loader.ts";

const adminRoot = resolveVercelAdminRoot(import.meta.url);
const getRuntime = createRetryingSingleFlight(() =>
  createAdminRuntime({
    trustedProxyHops: 1,
    providerRuntimeFactory: createAdminProviderRuntimeFactory,
  }),
);

function report(event: string): void {
  console.error(JSON.stringify({ level: "error", event }));
}

const vercelAdmin = createVercelAdminApp({
  getRuntime,
  cron: {
    readSecret: () => readRequiredSecret(process.env.CRON_SECRET, "CRON_SECRET", 32),
    getGuard: () => ({
      async run(operation) {
        const result = await runWithPostgresAdvisoryOperationGuard(
          {
            unpooledConnectionString: readRequiredSecret(
              process.env.PACKSCOUT_CONTROL_DATABASE_LOCK_URL,
              "PACKSCOUT_CONTROL_DATABASE_LOCK_URL",
            ),
            lockName: "packscout:admin:machinery-alert-cycle:v1",
          },
          operation,
        );
        return result.status === "busy"
          ? { kind: "busy" as const }
          : { kind: "executed" as const, value: result.value };
      },
    }),
    reportFailure: () => report("admin_machinery_alert_cycle_failed"),
  },
  spaIndexPath: path.join(adminRoot, "public", "index.html"),
  reportRuntimeFailure: () => report("admin_runtime_initialization_failed"),
});

const app = express();
app.disable("x-powered-by");
app.use(vercelAdmin);

export default app;

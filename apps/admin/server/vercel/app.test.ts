import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createAdminApp } from "../app.ts";
import type { AdminRuntime } from "../runtime.ts";
import { createVercelAdminApp } from "./app.ts";

const cronSecret = "packscout-vercel-cron-secret-000000000001";

function fixtureRuntime(app = createAdminApp()): AdminRuntime {
  return {
    app,
    configuration: {
      development: false,
      host: "0.0.0.0",
      port: 5101,
      machineryAlertIntervalMs: 60_000,
      productUserDirectoryConfigured: true,
      sourceAdministrationConfigured: false,
      emailLinkTokenConfigured: false,
    },
    runMachineryAlertCycle: () => Promise.resolve({
      organizations: 0,
      raised: 0,
      cleared: 0,
      failedOrganizations: 0,
      failedPublications: 0,
    }),
    close: () => Promise.resolve(),
  };
}

async function withServer(
  getRuntime: () => Promise<AdminRuntime>,
  visit: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = createVercelAdminApp({
    getRuntime,
    cron: {
      readSecret: () => cronSecret,
      getGuard: () => ({
        async run(operation) {
          return { kind: "executed", value: await operation() } as const;
        },
      }),
      reportFailure: () => undefined,
    },
    spaIndexPath: "/unused/index.html",
    serveSpa: (_request, response) => {
      response.status(200).type("html").send("<main>PackScout Admin</main>");
    },
    reportRuntimeFailure: () => undefined,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  try {
    await visit(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("Vercel dispatch preserves API JSON and serves deep SPA routes", async () => {
  let initializations = 0;
  await withServer(
    async () => {
      initializations += 1;
      return fixtureRuntime();
    },
    async (baseUrl) => {
      const health = await fetch(`${baseUrl}/api/health`);
      assert.equal(health.status, 200);
      assert.match(health.headers.get("content-type") ?? "", /application\/json/);
      assert.equal(health.headers.get("cache-control"), "no-store");

      const missing = await fetch(`${baseUrl}/api/not-real`);
      assert.equal(missing.status, 404);
      assert.equal(missing.headers.get("cache-control"), "no-store");
      assert.deepEqual(await missing.json(), {
        error: "Admin API route not found.",
        code: "API_ROUTE_NOT_FOUND",
      });

      const deepRoute = await fetch(`${baseUrl}/operators`);
      assert.equal(deepRoute.status, 200);
      assert.equal(
        deepRoute.headers.get("cache-control"),
        "private, no-cache, no-store, max-age=0, must-revalidate",
      );
      assert.match(await deepRoute.text(), /PackScout Admin/);
    },
  );
  assert.equal(initializations, 2);
});

test("runtime initialization failures stay structured and secret-free", async () => {
  await withServer(
    () => Promise.reject(new Error("postgresql://user:secret@example.test/db")),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/health`);
      assert.equal(response.status, 503);
      const body = await response.text();
      assert.doesNotMatch(body, /postgresql|secret|example\.test/);
      assert.deepEqual(JSON.parse(body), {
        error: "The admin service is temporarily unavailable.",
        code: "ADMIN_RUNTIME_UNAVAILABLE",
      });
    },
  );
});

test("cron rejection is handled before runtime initialization", async () => {
  let initializations = 0;
  await withServer(
    async () => {
      initializations += 1;
      return fixtureRuntime();
    },
    async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/internal/machinery-alert-cycle`,
      );
      assert.equal(response.status, 401);
    },
  );
  assert.equal(initializations, 0);
});

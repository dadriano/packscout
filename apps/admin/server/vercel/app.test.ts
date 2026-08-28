import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
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
  spaIndexPath = "/unused/index.html",
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
    spaIndexPath,
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

test("Vercel dispatch serves built assets before the SPA fallback", async () => {
  const publicDirectory = await mkdtemp(
    path.join(os.tmpdir(), "packscout-admin-vercel-"),
  );
  try {
    const assetsDirectory = path.join(publicDirectory, "assets");
    await mkdir(assetsDirectory);
    await Promise.all([
      writeFile(
        path.join(assetsDirectory, "admin.js"),
        "globalThis.packscoutAdminLoaded = true;",
      ),
      writeFile(
        path.join(assetsDirectory, "admin.css"),
        ":root { color-scheme: light dark; }",
      ),
    ]);

    await withServer(
      async () => fixtureRuntime(),
      async (baseUrl) => {
        const script = await fetch(`${baseUrl}/assets/admin.js`);
        assert.equal(script.status, 200);
        assert.match(
          script.headers.get("content-type") ?? "",
          /javascript/,
        );
        assert.equal(
          script.headers.get("cache-control"),
          "public, max-age=31536000, immutable",
        );
        assert.match(await script.text(), /packscoutAdminLoaded/);

        const unsatisfiableRange = await fetch(
          `${baseUrl}/assets/admin.js`,
          { headers: { Range: "bytes=10000-10001" } },
        );
        assert.equal(unsatisfiableRange.status, 416);
        assert.equal(
          unsatisfiableRange.headers.get("cache-control"),
          "private, no-cache, no-store, max-age=0, must-revalidate",
        );
        assert.equal(
          await unsatisfiableRange.text(),
          "Admin asset request rejected.",
        );

        const failedPrecondition = await fetch(
          `${baseUrl}/assets/admin.js`,
          { headers: { "If-Match": '"not-the-current-etag"' } },
        );
        assert.equal(failedPrecondition.status, 412);
        assert.equal(
          failedPrecondition.headers.get("cache-control"),
          "private, no-cache, no-store, max-age=0, must-revalidate",
        );

        const stylesheet = await fetch(`${baseUrl}/assets/admin.css`);
        assert.equal(stylesheet.status, 200);
        assert.match(
          stylesheet.headers.get("content-type") ?? "",
          /text\/css/,
        );

        const missingAsset = await fetch(`${baseUrl}/assets/not-real.js`);
        assert.equal(missingAsset.status, 404);
        assert.match(
          missingAsset.headers.get("content-type") ?? "",
          /text\/plain/,
        );
        assert.equal(await missingAsset.text(), "Admin asset not found.");
      },
      path.join(publicDirectory, "index.html"),
    );
  } finally {
    await rm(publicDirectory, { force: true, recursive: true });
  }
});

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

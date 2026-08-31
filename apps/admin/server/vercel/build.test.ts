import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildVercelAdminServer } from "./build.ts";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));

test("the production ESM bundle serves the SPA and loads both Prisma native engines", async () => {
  const temporaryRoot = path.join(repositoryRoot, ".tmp");
  await mkdir(temporaryRoot, { recursive: true });
  const fixtureRoot = await mkdtemp(path.join(temporaryRoot, "admin-vercel-"));
  try {
    const publicDirectory = path.join(fixtureRoot, "public");
    await mkdir(publicDirectory);
    await writeFile(path.join(publicDirectory, "index.html"), "<main>Admin smoke</main>");
    const bundle = await buildVercelAdminServer(path.join(fixtureRoot, "dist"));
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
      import assert from "node:assert/strict";
      import { once } from "node:events";
      const bundleUrl = process.argv[1];
      const { default: app } = await import(bundleUrl);
      const server = app.listen(0, "127.0.0.1");
      await once(server, "listening");
      try {
        const response = await fetch("http://127.0.0.1:" + server.address().port);
        assert.equal(response.status, 200);
        assert.equal(await response.text(), "<main>Admin smoke</main>");
      } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
      for (const name of ["central", "provider"]) {
        const { PrismaClient } = await import(new URL("./prisma/" + name + "/index.js", bundleUrl));
        const client = new PrismaClient({
          datasources: { db: { url: "postgresql://smoke:smoke@127.0.0.1:1/packscout?connect_timeout=1" } },
        });
        try {
          await assert.rejects(client.$connect(), error => error.errorCode === "P1001");
        } finally {
          await client.$disconnect();
        }
      }
      console.log("Production bundle and Prisma engines loaded");
    `, pathToFileURL(bundle).href], {
      encoding: "utf8",
      env: { NODE_ENV: "production" },
      timeout: 30_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Production bundle and Prisma engines loaded/u);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { resolveVercelAdminRoot } from "./app-paths.ts";

test("the generated dist bundle resolves public assets from the admin root", () => {
  const adminRoot = path.resolve("workspace", "apps", "admin");
  const bundleUrl = pathToFileURL(
    path.join(adminRoot, "dist", "server.bundle.mjs"),
  ).href;

  assert.equal(resolveVercelAdminRoot(bundleUrl), adminRoot);
});

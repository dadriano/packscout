import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("Packscout defaults stay in the reserved 5100 port range", () => {
  const frontendPackage = JSON.parse(
    readFileSync(path.join(repositoryRoot, "apps/frontend/package.json"), "utf8"),
  );
  const adminServer = readFileSync(
    path.join(repositoryRoot, "apps/admin/server/index.ts"),
    "utf8",
  );

  assert.match(
    frontendPackage.scripts.dev,
    /\$\{PACKSCOUT_FRONTEND_PORT:-5100\}/,
  );
  assert.match(
    frontendPackage.scripts.start,
    /\$\{PACKSCOUT_FRONTEND_PORT:-5100\}/,
  );
  assert.match(
    adminServer,
    /readPort\(\s*process\.env\.PACKSCOUT_ADMIN_PORT,\s*5101,/,
  );
  assert.match(
    adminServer,
    /readPort\(\s*process\.env\.PACKSCOUT_ADMIN_HMR_PORT,\s*port \+ 1,/,
  );

  assert.doesNotMatch(frontendPackage.scripts.dev, /\b300[01]\b/);
  assert.doesNotMatch(frontendPackage.scripts.start, /\b300[01]\b/);
  assert.doesNotMatch(adminServer, /\b300[01]\b/);
});

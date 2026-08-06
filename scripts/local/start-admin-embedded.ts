#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import {
  DatabaseLoginAttemptLimiter,
  DrizzleAuthAuditSink,
  DrizzleAuthRepository,
  PipelineSetupRepository,
} from "@packscout/database";
import { createMigratedTestDatabase } from "@packscout/database/test-support";
import { createAdminApp } from "../../apps/admin/server/app.ts";
import { createNodeAuthSecurity } from "../../apps/admin/server/auth/crypto.ts";
import { createAdminAuthRuntime } from "../../apps/admin/server/auth/runtime.ts";
import {
  readPort,
  readRequiredSecret,
} from "../../apps/admin/server/runtime-config.ts";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
dotenv.config({ path: path.join(repositoryRoot, ".env") });

const port = readPort(
  process.env.PACKSCOUT_ADMIN_PORT,
  5101,
  "PACKSCOUT_ADMIN_PORT",
);
const sessionSecret = readRequiredSecret(
  process.env.PACKSCOUT_SESSION_HASHING_SECRET,
  "PACKSCOUT_SESSION_HASHING_SECRET",
  32,
);
const email = readRequiredSecret(
  process.env.PACKSCOUT_BOOTSTRAP_ADMIN_EMAIL,
  "PACKSCOUT_BOOTSTRAP_ADMIN_EMAIL",
).trim().toLocaleLowerCase("en-US");
const password = readRequiredSecret(
  process.env.PACKSCOUT_BOOTSTRAP_ADMIN_PASSWORD,
  "PACKSCOUT_BOOTSTRAP_ADMIN_PASSWORD",
  12,
);
const displayName =
  process.env.PACKSCOUT_BOOTSTRAP_ADMIN_DISPLAY_NAME?.trim() || "Primary Admin";

async function main(): Promise<void> {
  const harness = await createMigratedTestDatabase();
  const organizationId = randomUUID();
  const setup = new PipelineSetupRepository(harness.database);
  await setup.createOrganization({
  id: organizationId,
  slug: "packscout-local",
  name: "PackScout Local",
});
  const repository = new DrizzleAuthRepository(harness.database);
  const security = createNodeAuthSecurity(sessionSecret);
  const provisioned = await repository.provisionOperator({
  id: randomUUID(),
  organizationId,
  emailNormalized: email,
  displayName,
  passwordHash: await security.passwordHasher.hash(password),
  role: "admin",
  state: "active",
  now: new Date(),
});
  if (provisioned.kind !== "created") {
    throw new Error("The local bootstrap administrator could not be provisioned.");
  }

  const origin = `http://127.0.0.1:${port}`;
  const auth = await createAdminAuthRuntime({
  repository,
  loginLimiter: new DatabaseLoginAttemptLimiter(harness.database, {
    windowMs: 15 * 60 * 1_000,
    blockMs: 15 * 60 * 1_000,
    maximumFailures: 8,
  }),
  audit: new DrizzleAuthAuditSink(harness.database),
  sessionSecret,
  sessionIdleMs: 60 * 60 * 1_000,
  sessionAbsoluteMs: 12 * 60 * 60 * 1_000,
  production: false,
  allowedOrigins: [origin, `http://localhost:${port}`],
});
  const app = createAdminApp({ auth });
  const adminRoot = path.join(repositoryRoot, "apps", "admin");
  const { createServer: createViteServer } = await import("vite");
  const hmrPort = readPort(
    process.env.PACKSCOUT_ADMIN_HMR_PORT,
    port + 1,
    "PACKSCOUT_ADMIN_HMR_PORT",
  );
  const vite = await createViteServer({
  root: adminRoot,
  server: { middlewareMode: true, hmr: { port: hmrPort } },
  appType: "spa",
});
  app.use(vite.middlewares);

  const server = app.listen(port, "127.0.0.1", () => {
    console.log(`PackScout local admin is available at ${origin}`);
  });

  async function shutDown(): Promise<void> {
    await vite.close();
    await harness.close();
    server.close();
  }

  process.once("SIGINT", () => void shutDown());
  process.once("SIGTERM", () => void shutDown());
}

void main();

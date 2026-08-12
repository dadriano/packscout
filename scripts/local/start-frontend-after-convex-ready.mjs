#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readLocalConvexConfiguration } from "./seed-convex-mock-catalog.mjs";
import { waitForLoopbackService } from "./start-frontend-with-convex-mock.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const { childEnvironment, publicUrl } = await readLocalConvexConfiguration();
await waitForLoopbackService(publicUrl);

const frontend = spawn("npm", ["run", "dev:frontend"], {
  cwd: repositoryRoot,
  env: {
    ...childEnvironment,
    NEXT_PUBLIC_CONVEX_URL: publicUrl,
  },
  stdio: "inherit",
  shell: false,
});

frontend.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
frontend.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});

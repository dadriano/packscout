#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const localEnvironmentPath = path.join(repositoryRoot, ".env.local");

export function parseEnvironmentFile(contents) {
  const result = {};
  for (const [index, rawLine] of contents.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (!match) {
      throw new Error(`Invalid .env.local entry on line ${index + 1}.`);
    }
    let value = match[2] ?? "";
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    result[match[1]] = value;
  }
  return result;
}

export function requireLoopbackConvexUrl(environment) {
  const candidates = [
    environment.NEXT_PUBLIC_CONVEX_URL?.trim(),
    environment.CONVEX_URL?.trim(),
  ].filter(Boolean);
  if (candidates.length === 0) {
    throw new Error(
      "Root .env.local must define NEXT_PUBLIC_CONVEX_URL or CONVEX_URL.",
    );
  }
  const loopbackHosts = new Set(["127.0.0.1", "localhost"]);
  const origins = candidates.map((candidate) => {
    let parsed;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new Error("The local Convex URL in .env.local is invalid.");
    }
    if (
      parsed.protocol !== "http:" ||
      !loopbackHosts.has(parsed.hostname) ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      throw new Error(
        "Mock data release tooling accepts only a root HTTP loopback Convex URL.",
      );
    }
    return parsed.origin;
  });
  if (new Set(origins).size !== 1) {
    throw new Error("The configured local Convex URLs must resolve identically.");
  }
  return origins[0];
}

export function assertNoCloudDeployKey(environment) {
  if (
    environment.CONVEX_DEPLOY_KEY?.trim() ||
    environment.CONVEX_DEPLOYMENT_TOKEN?.trim()
  ) {
    throw new Error(
      "Refusing a cloud deploy key; this command is restricted to local Convex.",
    );
  }
}

export function assertLocalConvexDeployment(environment) {
  const deployment = environment.CONVEX_DEPLOYMENT?.trim();
  if (!/^(?:anonymous|local):[A-Za-z0-9_-]+$/u.test(deployment ?? "")) {
    throw new Error(
      "Root .env.local must select an explicit anonymous: or local: Convex deployment.",
    );
  }
  if (
    environment.CONVEX_SELF_HOSTED_URL?.trim() ||
    environment.CONVEX_SELF_HOSTED_ADMIN_KEY?.trim()
  ) {
    throw new Error(
      "Self-hosted Convex selection is not supported by this local mock workflow.",
    );
  }
}

export async function readLocalConvexConfiguration() {
  const fileEnvironment = parseEnvironmentFile(
    await readFile(localEnvironmentPath, "utf8"),
  );
  const childEnvironment = { ...process.env, ...fileEnvironment };
  assertNoCloudDeployKey(childEnvironment);
  assertLocalConvexDeployment(childEnvironment);
  const publicUrl = requireLoopbackConvexUrl(fileEnvironment);
  return { childEnvironment, publicUrl };
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: options.environment,
      stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
      shell: false,
    });
    let stdout = "";
    if (options.capture) {
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        stdout += chunk;
      });
    }
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(stdout);
      else {
        reject(
          new Error(
            `${command} exited ${signal ? `with ${signal}` : `with code ${code ?? "unknown"}`}.`,
          ),
        );
      }
    });
  });
}

function convexArgs(...args) {
  return ["--no-install", "convex", ...args];
}

export async function seedLocalMockDataRelease() {
  const { childEnvironment } = await readLocalConvexConfiguration();
  const runNpx = (args, capture = false) =>
    run("npx", convexArgs(...args), {
      environment: childEnvironment,
      capture,
    });

  await runNpx([
    "env",
    "set",
    "PACKSCOUT_RUNTIME_ENVIRONMENT",
    "local",
  ]);
  await runNpx([
    "env",
    "set",
    "PACKSCOUT_MOCK_DATA_RELEASE_SEED_ENABLED",
    "1",
  ]);
  let cleanupError = null;
  try {
    const output = await runNpx(
      [
        "run",
        "mockDataReleaseSeed:seed",
        "{}",
        "--push",
        "--typecheck",
        "enable",
      ],
      true,
    );
    const result = JSON.parse(output.trim());
    if (
      (result.status !== "created" && result.status !== "unchanged") ||
      result.repackCount !== 6
    ) {
      throw new Error("Convex returned an unexpected mock seed result.");
    }
    console.log(
      `Mock data release ${result.status}; 6 repacks are available locally.`,
    );
    return result;
  } finally {
    try {
      await runNpx([
        "env",
        "remove",
        "PACKSCOUT_MOCK_DATA_RELEASE_SEED_ENABLED",
      ]);
    } catch (error) {
      cleanupError = error;
    }
    if (cleanupError) {
      throw new Error(
        "The seed finished, but the local enable flag could not be removed.",
        { cause: cleanupError },
      );
    }
  }
}

async function main() {
  await seedLocalMockDataRelease();
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Local seed failed.");
    process.exitCode = 1;
  });
}

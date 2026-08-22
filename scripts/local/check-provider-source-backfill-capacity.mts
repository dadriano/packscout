#!/usr/bin/env node

import { readFile, realpath, statfs } from "node:fs/promises";
import {
  buildProviderSourceCapacityForecast,
  evaluateProviderSourceCapacityPreflight,
  type ProviderSourceCapacityForecast,
  type ProviderSourceCapacityModelInput,
} from "@packscout/services";

const help = `Usage: npm run preflight:provider-source-backfill:local -- --database-path <path> [options]

Evaluates the exact filesystem that will hold the local PostgreSQL database.
This command is read-only and exits nonzero when task 010 must not start.

Options:
  --database-path <path>             Existing path on the database volume
  --unreconciled-attempts <count>    Current nonterminal request attempts (default 0)
  --help                             Show this message`;

function parseNonnegativeInteger(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("--unreconciled-attempts must be a nonnegative integer.");
  }
  return parsed;
}

function parseArguments(argumentsList: readonly string[]): Readonly<{
  databasePath: string;
  unreconciledAttemptCount: number;
}> | null {
  let databasePath: string | null = null;
  let unreconciledAttemptCount = 0;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--help") return null;
    const value = argumentsList[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument ?? "option"} requires a value.`);
    }
    if (argument === "--database-path") databasePath = value;
    else if (argument === "--unreconciled-attempts") {
      unreconciledAttemptCount = parseNonnegativeInteger(value);
    } else throw new Error(`Unknown option: ${argument}`);
    index += 1;
  }
  if (!databasePath) throw new Error("--database-path is required.");
  return { databasePath, unreconciledAttemptCount };
}

const options = parseArguments(process.argv.slice(2));
if (!options) {
  process.stdout.write(`${help}\n`);
  process.exit(0);
}

const artifactUrl = new URL(
  "../../docs/provider-source-capacity-measurement-v1.json",
  import.meta.url,
);
const artifact = JSON.parse(await readFile(artifactUrl, "utf8")) as Readonly<{
  version: string;
  forecastInput: ProviderSourceCapacityModelInput;
  forecast: ProviderSourceCapacityForecast;
}>;
const forecast = buildProviderSourceCapacityForecast(artifact.forecastInput);
if (JSON.stringify(forecast) !== JSON.stringify(artifact.forecast)) {
  throw new Error("The committed capacity artifact does not match its model input.");
}
const databasePath = await realpath(options.databasePath);
const filesystem = await statfs(databasePath, { bigint: true });
const volumeCapacity = filesystem.bsize * filesystem.blocks;
const volumeAvailable = filesystem.bsize * filesystem.bavail;
if (
  volumeCapacity > BigInt(Number.MAX_SAFE_INTEGER) ||
  volumeAvailable > BigInt(Number.MAX_SAFE_INTEGER)
) {
  throw new Error("Database volume exceeds the supported exact byte range.");
}
const input = {
  volumeCapacityBytes: Number(volumeCapacity),
  volumeAvailableBytes: Number(volumeAvailable),
  unreconciledNonterminalAttemptCount: options.unreconciledAttemptCount,
};
const decision = evaluateProviderSourceCapacityPreflight(forecast, input);
process.stdout.write(`${JSON.stringify({
  version: "provider-source-task010-admission-v1",
  capacityArtifactVersion: artifact.version,
  databasePath,
  input,
  decision,
})}\n`);
if (decision.decision === "rejected") process.exitCode = 1;

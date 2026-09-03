#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CatalogBridgeError,
  prepareCatalogBridge,
  refuseCatalogBridge,
  type CatalogBridgeOperationPins,
  type CatalogBridgePreflightObservation,
} from "./dataforrest-catalog-bridge-plan.mts";
import { persistPreparedCatalogBridge, readPrivateJsonFile } from "./dataforrest-catalog-bridge-journal.mts";

interface CatalogBridgePreparationInput {
  readonly pins: CatalogBridgeOperationPins;
  readonly observation: CatalogBridgePreflightObservation;
}

export function parseCatalogBridgeArguments(argv: readonly string[]) {
  let mode: "--check-only" | "--prepare" | null = null;
  let inputPath: string | null = null;
  let journalDirectory: string | null = null;
  for (let index = 0; index < argv.length;) {
    const flag = argv[index];
    if (flag === "--check-only" || flag === "--prepare") {
      if (mode !== null) refuseCatalogBridge("CATALOG_BRIDGE_ARGUMENTS_INVALID");
      mode = flag; index += 1; continue;
    }
    if (flag !== "--input" && flag !== "--journal-directory") {
      refuseCatalogBridge("CATALOG_BRIDGE_ARGUMENTS_INVALID");
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--") ||
      (flag === "--input" ? inputPath !== null : journalDirectory !== null)) {
      refuseCatalogBridge("CATALOG_BRIDGE_ARGUMENTS_INVALID");
    }
    if (flag === "--input") inputPath = value; else journalDirectory = value;
    index += 2;
  }
  if (mode === null || inputPath === null || journalDirectory === null) {
    refuseCatalogBridge("CATALOG_BRIDGE_ARGUMENTS_INVALID");
  }
  if (!path.isAbsolute(inputPath) || !path.isAbsolute(journalDirectory) || /[\r\n\0]/u.test(`${inputPath}${journalDirectory}`)) {
    refuseCatalogBridge("CATALOG_BRIDGE_ARGUMENTS_INVALID");
  }
  return Object.freeze({ mode, inputPath, journalDirectory });
}

export async function observeCatalogBridgeResident(input: Readonly<{
  checkout: string; expectedCommit: string;
}>): Promise<Readonly<{ checkout: string; expectedCommit: string; observedCommit: string; clean: boolean;
  utilityModuleSha256: string }>> {
  try {
    const observedCommit = execFileSync("git", ["-C", input.checkout, "rev-parse", "HEAD"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const status = execFileSync("git", ["-C", input.checkout, "status", "--porcelain=v1", "--untracked-files=normal"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const moduleBytes = await readFile(path.join(input.checkout, "scripts/live/dataforrest-catalog-bridge-plan.mts"));
    return Object.freeze({ checkout: input.checkout, expectedCommit: input.expectedCommit, observedCommit,
      clean: status.length === 0, utilityModuleSha256: createHash("sha256").update(moduleBytes).digest("hex") });
  } catch {
    return refuseCatalogBridge("CATALOG_BRIDGE_RESIDENT_UNAVAILABLE");
  }
}

function preparationInput(value: unknown): CatalogBridgePreparationInput {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    !("pins" in value) || !("observation" in value)) refuseCatalogBridge("CATALOG_BRIDGE_INPUT_INVALID");
  return value as CatalogBridgePreparationInput;
}

export async function runCatalogBridgePreparationCli(input: Readonly<{
  argv: readonly string[];
  observeResident?: typeof observeCatalogBridgeResident;
  output: (value: unknown) => void;
  error: (value: unknown) => void;
}>): Promise<number> {
  try {
    const args = parseCatalogBridgeArguments(input.argv);
    const document = preparationInput(await readPrivateJsonFile(args.inputPath));
    const observedRepository = await (input.observeResident ?? observeCatalogBridgeResident)({
      checkout: document.pins.residentCheckout, expectedCommit: document.pins.residentCommit,
    });
    const observation = { ...document.observation, repository: observedRepository };
    const prepared = prepareCatalogBridge({ pins: document.pins, observation });
    if (args.mode === "--check-only") {
      input.output({ outcome: "verified", phase: "preflight", operationId: prepared.privateState.operationId,
        providerKey: prepared.privateState.providerKey, planDigest: prepared.privateState.planDigest,
        cursorEvidence: { savedEventCursorHash: prepared.publicReceipt.savedEventCursorHash,
          savedOpaqueValueHash: prepared.publicReceipt.savedOpaqueValueHash } });
      return 0;
    }
    const persisted = await persistPreparedCatalogBridge({ directory: args.journalDirectory, ...prepared });
    input.output({ outcome: persisted.exactRetry ? "already_prepared" : "prepared", phase: "prepared",
      operationId: prepared.privateState.operationId, providerKey: prepared.privateState.providerKey,
      planDigest: prepared.privateState.planDigest, journalHeadHash: persisted.journal.headReceiptHash,
      privateStateSha256: persisted.commit.privateStateSha256, publicJournalSha256: persisted.commit.publicJournalSha256 });
    return 0;
  } catch (error) {
    input.error({ outcome: "refused", code: error instanceof CatalogBridgeError
      ? error.code : "CATALOG_BRIDGE_PREPARATION_FAILED" });
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runCatalogBridgePreparationCli({ argv: process.argv.slice(2),
    output: (value) => process.stdout.write(`${JSON.stringify(value)}\n`),
    error: (value) => process.stderr.write(`${JSON.stringify(value)}\n`) })
    .then((code) => { process.exitCode = code; });
}

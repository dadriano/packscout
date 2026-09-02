import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, stat } from "node:fs/promises";
import path from "node:path";
import {
  catalogBridgeConfigurationPlan,
  catalogBridgeProvider,
  refuseCatalogBridge,
  type CatalogBridgePrivatePreparedState,
} from "./dataforrest-catalog-bridge-plan.mts";
import type { CatalogBridgeDrainProcessObservation } from
  "./dataforrest-catalog-bridge-drain-policy.mts";
import { catalogBridgeResumeRunId } from "./dataforrest-catalog-bridge-state.mts";
import {
  createCatalogBridgeMacosCommandRunner,
  type CatalogBridgeMacosCommandRunner,
} from "./dataforrest-catalog-bridge-drain-macos.mts";
import type { CatalogBridgeCatalogLivePolicy } from
  "./dataforrest-catalog-bridge-catalog-live-policy.mts";

export interface CatalogBridgeBootstrapFiles {
  readPrivate(filePath: string): Promise<Buffer>;
  installAtomic(input: Readonly<{ source: Buffer; destination: string }>): Promise<void>;
  readIfPresent(filePath: string): Promise<Buffer | null>;
}

async function readPrivate(filePath: string): Promise<Buffer> {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const details = await handle.stat();
    if (!details.isFile() || details.uid !== process.getuid?.() ||
      (details.mode & 0o777) !== 0o600 || details.size < 2 || details.size > 256 * 1_024) {
      refuseCatalogBridge("CATALOG_BRIDGE_BOOTSTRAP_PLIST_FILE_UNSAFE");
    }
    return await handle.readFile();
  } finally { await handle?.close(); }
}

export function createCatalogBridgeBootstrapFiles(): CatalogBridgeBootstrapFiles {
  return Object.freeze({
    readPrivate,
    async readIfPresent(filePath: string) {
      try { return await readPrivate(filePath); }
      catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
      }
    },
    async installAtomic(input: Readonly<{ source: Buffer; destination: string }>) {
      const parent = path.dirname(input.destination);
      const parentDetails = await stat(parent);
      if (!parentDetails.isDirectory() || parentDetails.uid !== process.getuid?.() ||
        (parentDetails.mode & 0o022) !== 0) {
        refuseCatalogBridge("CATALOG_BRIDGE_BOOTSTRAP_INSTALL_DIRECTORY_UNSAFE");
      }
      const temporary = `${input.destination}.next-${process.pid}`;
      const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL |
        constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { await handle.writeFile(input.source); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, input.destination);
      const directory = await open(parent, constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    },
  });
}

function expectedArguments(policy: CatalogBridgeCatalogLivePolicy,
  state: CatalogBridgePrivatePreparedState): readonly string[] {
  const definition = catalogBridgeProvider(state.providerKey);
  const configuration = catalogBridgeConfigurationPlan(state);
  return Object.freeze([policy.successorLaunchAgent.nodePath, "--import", "tsx",
    path.join(policy.pins.residentCheckout, "scripts/local/run-provider-continuous-poller.mts"),
    "--run", "--launchd", "--bootstrap-backfill", "--await-initial-run",
    "--organization-id", definition.organizationId,
    "--provider-id", definition.providerId, "--provider-key", definition.providerKey,
    "--config-id", configuration.eventSuccessor.id, "--initial-run-id",
    catalogBridgeResumeRunId(state.operationId, state.providerKey), "--operation-id", state.operationId,
    "--operator-id", policy.pins.operatorId]);
}

function exactObject(value: unknown, expected: Record<string, unknown>): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = value as Record<string, unknown>;
  const keys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index]) &&
    keys.every((key) => actual[key] === expected[key]);
}

function assertPlist(input: Readonly<{ parsed: unknown; policy: CatalogBridgeCatalogLivePolicy;
  state: CatalogBridgePrivatePreparedState }>): void {
  const definition = catalogBridgeProvider(input.state.providerKey);
  if (!input.parsed || typeof input.parsed !== "object" || Array.isArray(input.parsed)) {
    refuseCatalogBridge("CATALOG_BRIDGE_BOOTSTRAP_PLIST_INVALID");
  }
  const value = input.parsed as Record<string, unknown>;
  const args = value.ProgramArguments;
  const environment = value.EnvironmentVariables;
  const expectedPath = `${path.dirname(input.policy.successorLaunchAgent.nodePath)}:/usr/bin:/bin:/usr/sbin:/sbin`;
  if (value.Label !== definition.launchdLabel || value.WorkingDirectory !== input.policy.pins.residentCheckout ||
    value.RunAtLoad !== true || value.ThrottleInterval !== 30 || value.ExitTimeOut !== 60 || value.Umask !== 63 ||
    !Array.isArray(args) || args.length !== expectedArguments(input.policy, input.state).length ||
    args.some((entry, index) => entry !== expectedArguments(input.policy, input.state)[index]) ||
    !exactObject(environment, { NODE_ENV: "development", PATH: expectedPath }) ||
    !exactObject(value.KeepAlive, { SuccessfulExit: false }) ||
    value.StandardOutPath !== input.policy.successorLaunchAgent.logPath ||
    value.StandardErrorPath !== input.policy.successorLaunchAgent.logPath) {
    refuseCatalogBridge("CATALOG_BRIDGE_BOOTSTRAP_PLIST_INVALID");
  }
}

function offline(value: CatalogBridgeDrainProcessObservation, label: string, port: number): boolean {
  return value.launchdLabel === label && value.residencyPort === port &&
    value.launchdLoaded === false && value.processCount === 0 && value.pids.length === 0 &&
    value.processIdentitySha256 === null && value.residencyPortListening === false;
}

function online(value: CatalogBridgeDrainProcessObservation, label: string, port: number): boolean {
  return value.launchdLabel === label && value.residencyPort === port &&
    value.launchdLoaded && value.processCount === 1 &&
    value.pids.length === 1 && value.processIdentitySha256 !== null && value.residencyPortListening;
}

export function createCatalogBridgeMacosBootstrapAdapter(input: Readonly<{
  policy: CatalogBridgeCatalogLivePolicy;
  state: CatalogBridgePrivatePreparedState;
  observeProcess: () => Promise<CatalogBridgeDrainProcessObservation>;
  runner?: CatalogBridgeMacosCommandRunner;
  files?: CatalogBridgeBootstrapFiles;
  uid?: number;
  platform?: NodeJS.Platform;
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}>): Readonly<{
  check(): Promise<void>;
  bootstrap(): Promise<CatalogBridgeDrainProcessObservation>;
}> {
  const definition = catalogBridgeProvider(input.state.providerKey);
  const runner = input.runner ?? createCatalogBridgeMacosCommandRunner();
  const files = input.files ?? createCatalogBridgeBootstrapFiles();
  const uid = input.uid ?? process.getuid?.();
  const platform = input.platform ?? process.platform;
  const wait = input.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = input.now ?? Date.now;
  if (platform !== "darwin" || !Number.isSafeInteger(uid) || (uid ?? -1) < 1) {
    refuseCatalogBridge("CATALOG_BRIDGE_BOOTSTRAP_PLATFORM_INVALID");
  }
  const prove = async () => {
    const staged = await files.readPrivate(input.policy.successorLaunchAgent.stagedPath);
    if (createHash("sha256").update(staged).digest("hex") !==
      input.policy.successorLaunchAgent.fileSha256) {
      refuseCatalogBridge("CATALOG_BRIDGE_BOOTSTRAP_PLIST_DIGEST_CHANGED");
    }
    const parsed = await runner.run("/usr/bin/plutil", ["-convert", "json", "-o", "-",
      input.policy.successorLaunchAgent.stagedPath], 5_000);
    if (parsed.exitCode !== 0) refuseCatalogBridge("CATALOG_BRIDGE_BOOTSTRAP_PLIST_INVALID");
    try { assertPlist({ parsed: JSON.parse(parsed.stdout), policy: input.policy, state: input.state }); }
    catch (error) {
      if (error instanceof SyntaxError) refuseCatalogBridge("CATALOG_BRIDGE_BOOTSTRAP_PLIST_INVALID");
      throw error;
    }
    return staged;
  };
  return Object.freeze({
    async check() { await prove(); },
    async bootstrap() {
      const staged = await prove();
      const before = await input.observeProcess();
      const installed = await files.readIfPresent(input.policy.successorLaunchAgent.installedPath);
      const installedExact = installed !== null && Buffer.compare(installed, staged) === 0;
      if (online(before, definition.launchdLabel, definition.residencyPort)) {
        if (!installedExact) refuseCatalogBridge("CATALOG_BRIDGE_BOOTSTRAP_RUNNING_PLIST_CHANGED");
        return before;
      }
      if (!offline(before, definition.launchdLabel, definition.residencyPort)) {
        refuseCatalogBridge("CATALOG_BRIDGE_BOOTSTRAP_PROCESS_NOT_OFFLINE");
      }
      if (!installedExact) await files.installAtomic({ source: staged,
        destination: input.policy.successorLaunchAgent.installedPath });
      const exactInstalled = await files.readPrivate(input.policy.successorLaunchAgent.installedPath);
      if (Buffer.compare(exactInstalled, staged) !== 0) {
        refuseCatalogBridge("CATALOG_BRIDGE_BOOTSTRAP_INSTALL_CHANGED");
      }
      const result = await runner.run("/bin/launchctl", ["bootstrap", `gui/${uid}`,
        input.policy.successorLaunchAgent.installedPath], 10_000);
      if (result.exitCode !== 0) refuseCatalogBridge("CATALOG_BRIDGE_BOOTSTRAP_REFUSED");
      const deadline = now() + input.policy.successorLaunchAgent.bootstrapTimeoutMilliseconds;
      while (now() <= deadline) {
        const observation = await input.observeProcess();
        if (online(observation, definition.launchdLabel, definition.residencyPort)) return observation;
        await wait(input.policy.successorLaunchAgent.bootstrapPollMilliseconds);
      }
      return refuseCatalogBridge("CATALOG_BRIDGE_BOOTSTRAP_TIMEOUT");
    },
  });
}

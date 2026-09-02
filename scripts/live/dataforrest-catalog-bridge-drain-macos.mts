import { execFile } from "node:child_process";
import {
  catalogBridgeDigest,
  catalogBridgeProvider,
  refuseCatalogBridge,
  type CatalogBridgeProviderKey,
} from "./dataforrest-catalog-bridge-plan.mts";
import type {
  CatalogBridgeBootoutReceipt,
  CatalogBridgeDrainProcessObservation,
} from "./dataforrest-catalog-bridge-drain-policy.mts";

export interface CatalogBridgeMacosCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CatalogBridgeMacosCommandRunner {
  run(executable: string, args: readonly string[], timeoutMilliseconds: number): Promise<CatalogBridgeMacosCommandResult>;
}

export function createCatalogBridgeMacosCommandRunner(): CatalogBridgeMacosCommandRunner {
  return Object.freeze({
    run(executable: string, args: readonly string[], timeoutMilliseconds: number) {
      return new Promise<CatalogBridgeMacosCommandResult>((resolve) => {
        execFile(executable, [...args], { encoding: "utf8", timeout: timeoutMilliseconds,
          maxBuffer: 256 * 1_024, windowsHide: true }, (error, stdout, stderr) => {
          const exitCode = error && "code" in error && typeof error.code === "number" ? error.code : error ? -1 : 0;
          resolve({ exitCode, stdout, stderr });
        });
      });
    },
  });
}

export interface CatalogBridgeMacosProcessAdapter {
  observe(): Promise<CatalogBridgeDrainProcessObservation>;
  bootout(input: Readonly<{
    launchdLabel: string;
    expectedPid: number;
    expectedProcessIdentitySha256: string;
  }>): Promise<CatalogBridgeBootoutReceipt>;
}

function processIds(output: string): number[] {
  return [...new Set(output.split(/\r?\n/u).flatMap((line) => {
    const match = /^p([1-9][0-9]*)$/u.exec(line.trim());
    if (!match) return [];
    const value = Number(match[1]);
    return Number.isSafeInteger(value) ? [value] : [];
  }))].sort((left, right) => left - right);
}

function launchdPid(output: string): number | null {
  const values = [...output.matchAll(/^\s*pid\s*=\s*([1-9][0-9]*)\s*$/gmu)]
    .map((match) => Number(match[1])).filter(Number.isSafeInteger);
  if (values.length === 0) return null;
  if (values.length !== 1) refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_PROCESS_NOT_EXACT");
  return values[0]!;
}

function sameExpectedProcess(observation: CatalogBridgeDrainProcessObservation, input: Readonly<{
  launchdLabel: string; expectedPid: number; expectedProcessIdentitySha256: string;
}>, expectedPort: number): boolean {
  return observation.launchdLoaded && observation.residencyPortListening && observation.processCount === 1 &&
    observation.launchdLabel === input.launchdLabel && observation.residencyPort === expectedPort &&
    observation.pids.length === 1 &&
    observation.pids[0] === input.expectedPid &&
    observation.processIdentitySha256 === input.expectedProcessIdentitySha256;
}

function offline(observation: CatalogBridgeDrainProcessObservation): boolean {
  return !observation.launchdLoaded && !observation.residencyPortListening && observation.processCount === 0 &&
    observation.pids.length === 0 && observation.processIdentitySha256 === null;
}

export function createCatalogBridgeMacosProcessAdapter(input: Readonly<{
  providerKey: CatalogBridgeProviderKey;
  runner?: CatalogBridgeMacosCommandRunner;
  platform?: NodeJS.Platform;
  uid?: number;
  commandTimeoutMilliseconds?: number;
  bootoutPollMilliseconds?: number;
  bootoutTimeoutMilliseconds?: number;
  now?: () => Date;
  wait?: (milliseconds: number) => Promise<void>;
  /** Re-reads and proves a paused drain or an admitted idle-head boundary immediately before bootout. */
  authorizeBootout: (expected: Readonly<{
    launchdLabel: string; expectedPid: number; expectedProcessIdentitySha256: string;
  }>) => Promise<CatalogBridgeDrainProcessObservation>;
}>): CatalogBridgeMacosProcessAdapter {
  const definition = catalogBridgeProvider(input.providerKey);
  const runner = input.runner ?? createCatalogBridgeMacosCommandRunner();
  const platform = input.platform ?? process.platform;
  const uid = input.uid ?? process.getuid?.();
  const commandTimeout = input.commandTimeoutMilliseconds ?? 5_000;
  const pollMilliseconds = input.bootoutPollMilliseconds ?? 100;
  const timeoutMilliseconds = input.bootoutTimeoutMilliseconds ?? 10_000;
  const now = input.now ?? (() => new Date());
  const wait = input.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  if (platform !== "darwin" || !Number.isSafeInteger(uid) || (uid ?? -1) < 1 || !Number.isSafeInteger(commandTimeout) ||
    commandTimeout < 100 || commandTimeout > 30_000 || !Number.isSafeInteger(pollMilliseconds) ||
    pollMilliseconds < 25 || pollMilliseconds > 2_000 || !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 100 || timeoutMilliseconds > 30_000) {
    refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_PROCESS_POLICY_INVALID");
  }
  const launchdTarget = `gui/${uid}/${definition.launchdLabel}`;

  const observe = async (): Promise<CatalogBridgeDrainProcessObservation> => {
    const [launchd, listening] = await Promise.all([
      runner.run("/bin/launchctl", ["print", launchdTarget], commandTimeout),
      runner.run("/usr/sbin/lsof", ["-nP", `-iTCP:${definition.residencyPort}`, "-sTCP:LISTEN", "-Fp"], commandTimeout),
    ]);
    const launchdAbsent = launchd.exitCode !== 0 &&
      /(?:could not find service|service not found)/iu.test(`${launchd.stdout}\n${launchd.stderr}`);
    if (![0, 1].includes(listening.exitCode) || (listening.exitCode === 1 && listening.stderr.trim().length > 0) ||
      (launchd.exitCode !== 0 && !launchdAbsent)) {
      refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_PROCESS_OBSERVATION_FAILED");
    }
    const loaded = launchd.exitCode === 0;
    const residentPid = loaded ? launchdPid(launchd.stdout) : null;
    const listenerPids = processIds(listening.stdout);
    const pids = [...new Set([...(residentPid === null ? [] : [residentPid]), ...listenerPids])]
      .sort((left, right) => left - right);
    let processIdentitySha256: string | null = null;
    if (pids.length === 1) {
      const identity = await runner.run("/bin/ps", ["-ww", "-p", String(pids[0]), "-o", "pid=", "-o", "ppid=",
        "-o", "lstart=", "-o", "command="], commandTimeout);
      if (identity.exitCode !== 0 || identity.stdout.trim().length < 1) {
        refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_PROCESS_OBSERVATION_FAILED");
      }
      processIdentitySha256 = catalogBridgeDigest({ pid: pids[0], identity: identity.stdout.trim() });
    }
    return Object.freeze({ launchdLabel: definition.launchdLabel, launchdLoaded: loaded,
      processCount: pids.length, pids, processIdentitySha256, residencyPort: definition.residencyPort,
      residencyPortListening: listenerPids.length > 0 });
  };

  return Object.freeze({
    observe,
    async bootout(expected: Readonly<{ launchdLabel: string; expectedPid: number;
      expectedProcessIdentitySha256: string }>): Promise<CatalogBridgeBootoutReceipt> {
      if (expected.launchdLabel !== definition.launchdLabel) {
        refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_PROCESS_NOT_EXACT");
      }
      const authorized = await input.authorizeBootout(expected);
      if (!sameExpectedProcess(authorized, expected, definition.residencyPort)) {
        refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_PROCESS_NOT_EXACT");
      }
      const observed = await observe();
      if (!sameExpectedProcess(observed, expected, definition.residencyPort)) {
        refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_PROCESS_NOT_EXACT");
      }
      const requestedAt = now();
      const result = await runner.run("/bin/launchctl", ["bootout", launchdTarget], commandTimeout);
      if (result.exitCode !== 0) refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_BOOTOUT_REFUSED");
      const deadline = requestedAt.getTime() + timeoutMilliseconds;
      while (now().getTime() <= deadline) {
        const current = await observe();
        if (offline(current)) return Object.freeze({ launchdLabel: definition.launchdLabel,
          expectedPid: expected.expectedPid, expectedProcessIdentitySha256: expected.expectedProcessIdentitySha256,
          requestedAt: requestedAt.toISOString(), completedAt: now().toISOString(), outcome: "unloaded" as const });
        await wait(pollMilliseconds);
      }
      return refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_BOOTOUT_TIMEOUT");
    },
  });
}

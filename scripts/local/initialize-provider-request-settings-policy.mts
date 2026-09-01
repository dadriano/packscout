import { z } from "zod";
import { assertBackfillPins, backfillDigest, backfillPinsSchema,
  refuseBackfill, type BackfillSnapshot } from "./provider-backfill-supervisor-policy.mts";

export const requestSettingsInitializationSchema = z.object({
  pins: backfillPinsSchema,
  recordsPerRequest: z.number().int().min(1).max(5_000),
  expectedCheckpointHash: z.string().regex(/^[a-f0-9]{64}$/u),
  expectedGeneration: z.string().regex(/^(0|[1-9][0-9]*)$/u),
  expectedImportFence: z.string().regex(/^(0|[1-9][0-9]*)$/u),
}).strict();
export type RequestSettingsInitialization = z.infer<typeof requestSettingsInitializationSchema>;

/** First initialization is a writer handoff, not an ordinary settings save. */
export function assertRequestSettingsInitialization(input: RequestSettingsInitialization,
  snapshot: BackfillSnapshot, configNumber: bigint): void {
  assertBackfillPins(snapshot, input.pins, configNumber);
  if (snapshot.run.id !== input.pins.initialRunId || snapshot.state !== "error" ||
    snapshot.run.state !== "failed" || snapshot.run.reachedHead || !snapshot.run.finishedAt ||
    snapshot.generation.toString() !== input.expectedGeneration ||
    snapshot.checkpointHash !== input.expectedCheckpointHash || !snapshot.run.finalMatches ||
    snapshot.run.finalHash !== input.expectedCheckpointHash ||
    snapshot.activeRunIds.length !== 0 || snapshot.actionableCommands.length !== 0 ||
    snapshot.lease.owner !== null || snapshot.lease.expiresAt !== null ||
    snapshot.lease.fence.toString() !== input.expectedImportFence ||
    !snapshot.lastPage?.matches || snapshot.lastPage.continuation !== "more" ||
    snapshot.lastPage.number !== snapshot.run.pageCount ||
    snapshot.lastPage.hash !== input.expectedCheckpointHash) {
    refuseBackfill("REQUEST_SETTINGS_HANDOFF_DRIFT");
  }
}

export function requestSettingsBoundaryDigest(snapshot: BackfillSnapshot): string {
  const { now: _now, ...stable } = snapshot;
  return backfillDigest(stable);
}

/** Inspect process arguments only in memory. Never emit this input. */
export function assertNoRequestSettingsWriter(text: string, providerId: string,
  providerKey: string, ownPid = process.pid): void {
  const rows = text.split("\n").filter(Boolean).map(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/u);
    if (!match) refuseBackfill("REQUEST_SETTINGS_PROCESS_INVENTORY_INVALID");
    return { pid: Number(match[1]), parent: Number(match[2]), command: match[3]! };
  });
  const byId = new Map(rows.map(row => [row.pid, row]));
  const supervisor = /(?:run-provider-backfill-supervisor|run-provider-continuous-poller)\.mts/u;
  const worker = /(?:provider-manual-import-local|clutchpacks-manual-import-local)\.ts/u;
  const invoking = (command: string) => supervisor.test(command) &&
    !command.includes("--check-only") && command.includes("--run");
  for (const row of rows) {
    if (row.pid === ownPid) continue;
    if (invoking(row.command) && (row.command.includes(providerId) ||
      row.command.includes(`--provider-key ${providerKey}`))) refuseBackfill("REQUEST_SETTINGS_WRITER_PRESENT");
    if (!worker.test(row.command)) continue;
    let current: typeof row | undefined = row;
    const seen = new Set<number>(); let identifiedOther = false;
    for (let depth = 0; current && depth < 32 && !seen.has(current.pid); depth += 1) {
      seen.add(current.pid);
      if (invoking(current.command)) {
        identifiedOther = ["clutchpacks", "courtyard", "collector_crypt", "phygitals"]
          .filter(key => key !== providerKey).some(key => current!.command.includes(`--provider-key ${key}`));
        if (!identifiedOther || current.command.includes(providerId)) refuseBackfill("REQUEST_SETTINGS_WRITER_PRESENT");
        break;
      }
      current = byId.get(current.parent);
    }
    if (!identifiedOther) refuseBackfill("REQUEST_SETTINGS_UNSCOPED_WRITER_PRESENT");
  }
}

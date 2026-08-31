import { z } from "zod";
import { backfillDigest, backfillId, backfillPinsSchema } from "./provider-backfill-supervisor-policy.mts";

const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/u);
export const continuationReviewSchema = z.object({
  pins: backfillPinsSchema,
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  authorization: z.literal("operator_requested_one_time_continuation"),
  expectedGeneration: decimal,
  expectedImportFence: decimal,
  expectedCheckpointHash: z.string().regex(/^[a-f0-9]{64}$/u),
  expectedFailureCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u),
  expectedFinishedAt: z.string().datetime(),
  expectedPageCount: z.number().int().min(1).max(50_000),
}).strict();
export type ContinuationReview = z.infer<typeof continuationReviewSchema>;
export class OperatorContinuationError extends Error {
  constructor(readonly code: string) { super(code); this.name = "OperatorContinuationError"; }
}
export function refuseContinuation(code: string): never { throw new OperatorContinuationError(code); }
export const continuationAction = "provider.local_operator_continuation";
export function continuationIds(review: ContinuationReview) {
  const operation = review.pins.operationId;
  return { run: backfillId(operation, "operator-continuation/run"),
    command: backfillId(operation, "operator-continuation/command"),
    resume: backfillId(operation, "operator-continuation/resume"),
    owner: `local:operator-continuation:${operation}`,
    runKey: `operator-continuation/${operation}/run`, resumeKey: `operator-continuation/${operation}/resume` };
}
export const continuationReceiptSchema = z.object({
  version: z.literal(1), review: continuationReviewSchema,
  authorityDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  historyDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  entryRowVersion: decimal, ledgerSequence: decimal,
  automaticFailureClassification: z.literal("unchanged"),
  originalFailureCauseKnown: z.literal(false), sourceRequestPerformed: z.literal(false),
}).strict();
export type ContinuationReceipt = z.infer<typeof continuationReceiptSchema>;
export const continuationDigest = backfillDigest;

/** Process commands stay in memory; unknown worker ancestry fails closed. */
export function assertNoContinuationWriter(text: string, review: ContinuationReview, ownPid = process.pid) {
  const rows = text.split("\n").filter(Boolean).map(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/u);
    if (!match) refuseContinuation("CONTINUATION_PROCESS_INVENTORY_INVALID");
    return { pid: Number(match[1]), parent: Number(match[2]), command: match[3]! };
  });
  const byId = new Map(rows.map(row => [row.pid, row]));
  const knownKeys = backfillPinsSchema.shape.providerKey.options;
  const supervisor = (command: string) => /(?:run-provider-backfill-supervisor|run-provider-continuous-poller)\.mts/u.test(command)
    && command.includes("--run") && !command.includes("--check-only");
  const target = (command: string) => command.includes(review.pins.providerId)
    || command.includes(`--provider-key ${review.pins.providerKey}`);
  for (const row of rows) {
    if (row.pid === ownPid) continue;
    if (supervisor(row.command) && target(row.command)) refuseContinuation("CONTINUATION_WRITER_PRESENT");
    if (!/(?:provider-manual-import-local|clutchpacks-manual-import-local)\.ts/u.test(row.command)) continue;
    let current: typeof row | undefined = row; let identified = false;
    const seen = new Set<number>();
    for (let depth = 0; current && depth < 32 && !seen.has(current.pid); depth++) {
      seen.add(current.pid);
      if (supervisor(current.command)) {
        identified = !target(current.command) && knownKeys.filter(key => key !== review.pins.providerKey)
          .some(key => current!.command.includes(`--provider-key ${key}`));
        break;
      }
      current = byId.get(current.parent);
    }
    if (!identified) refuseContinuation("CONTINUATION_UNSCOPED_WRITER_PRESENT");
  }
}

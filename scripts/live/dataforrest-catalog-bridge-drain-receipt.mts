import { z } from "zod";

const sha256 = /^[a-f0-9]{64}$/u;
const positiveInteger = /^[1-9][0-9]*$/u;

const terminalSchema = z.object({
  kind: z.enum(["interrupted_checkpoint", "succeeded_reconciled_head"]),
  runId: z.string().uuid(),
  runFence: z.string().regex(positiveInteger),
  state: z.enum(["incomplete", "failed", "succeeded"]),
  failureCode: z.string().nullable(),
  reachedSourceHead: z.boolean(),
  finishedAt: z.string().datetime(),
  pageCount: z.number().int().positive(),
  finalCursorHash: z.string().regex(sha256),
  lastPageNumber: z.number().int().positive(),
  lastPageCursorHash: z.string().regex(sha256),
  lastPageContinuation: z.enum(["more", "head"]),
  runDigest: z.string().regex(sha256),
  lastPageDigest: z.string().regex(sha256),
  headProofDigest: z.string().regex(sha256).nullable(),
}).strict();

export const catalogBridgeDrainReceiptSchema = z.object({
  schemaVersion: z.literal("dataforrest_catalog_bridge_drain_receipt_v1"),
  operationId: z.string().uuid(),
  providerKey: z.enum(["collector_crypt", "courtyard", "phygitals"]),
  providerId: z.string().uuid(),
  operatorId: z.string().uuid(),
  entryKind: z.enum(["running", "offline_idle_head"]),
  currentConfigId: z.string().uuid(),
  drainedAt: z.string().datetime(),
  intentDigests: z.array(z.string().regex(sha256)).min(1).max(2),
  pause: z.object({
    commandId: z.string().uuid(),
    commandDigest: z.string().regex(sha256),
    expectedGeneration: z.string().regex(positiveInteger),
    resultGeneration: z.string().regex(positiveInteger),
    reason: z.string().min(1).max(512),
    correlationId: z.string().uuid(),
    requestedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
  }).strict(),
  terminal: terminalSchema,
  worker: z.object({
    launchdLabel: z.string().min(1).max(256),
    initialPid: z.number().int().positive(),
    initialProcessIdentitySha256: z.string().regex(sha256),
    bootoutReceiptDigest: z.string().regex(sha256),
    offlineProcessEvidenceDigest: z.string().regex(sha256),
  }).strict(),
  drainedEvidenceDigest: z.string().regex(sha256),
}).strict().superRefine((value, context) => {
  const interrupted = value.terminal.kind === "interrupted_checkpoint";
  const admittedInterruption =
    (value.terminal.state === "incomplete" && value.terminal.failureCode === "PROVIDER_IMPORT_RUNTIME_UNAVAILABLE") ||
    (value.terminal.state === "failed" && value.terminal.failureCode === "PROVIDER_MIXED_PAGE_RUNTIME_NOT_RUNNING");
  if (interrupted
    ? !admittedInterruption || value.terminal.reachedSourceHead || value.terminal.lastPageContinuation !== "more" ||
      value.terminal.headProofDigest !== null
    : value.terminal.state !== "succeeded" || value.terminal.failureCode !== null ||
      !value.terminal.reachedSourceHead || value.terminal.lastPageContinuation !== "head" ||
      value.terminal.headProofDigest === null) {
    context.addIssue({ code: "custom", message: "Terminal proof is not admitted." });
  }
});

export type CatalogBridgeDrainReceipt = z.infer<typeof catalogBridgeDrainReceiptSchema>;

import { Prisma } from "../prisma/generated/provider/index.js";

const RECORD_SQLSTATES = new Set(["23502", "23503", "23505", "23514", "22001", "22003", "22P02"]);

/** Only selects a chunk rollback + ordinary per-record validation; never a transaction retry. */
export function providerBatchRecordConstraint(error: unknown): boolean {
  try {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
    const code = Object.getOwnPropertyDescriptor(error, "code");
    const meta = Object.getOwnPropertyDescriptor(error, "meta");
    if (!code || !("value" in code) || code.value !== "P2010" || !meta || !("value" in meta)
      || meta.value === null || typeof meta.value !== "object") return false;
    const descriptor = Object.getOwnPropertyDescriptor(meta.value, "code");
    return descriptor !== undefined && "value" in descriptor
      && typeof descriptor.value === "string" && RECORD_SQLSTATES.has(descriptor.value);
  } catch { return false; }
}

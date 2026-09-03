import { Prisma } from "../prisma/generated/provider/index.js";
import type { ProviderPrismaClient, ProviderTransactionClient } from "./provider-database.ts";

export class ProviderPageTransactionExpiredError extends Error {
  readonly code = "PROVIDER_PAGE_TRANSACTION_EXPIRED";
  constructor(readonly timeoutMilliseconds: number, readonly elapsedMilliseconds: number) {
    super("The provider page transaction expired before its callback completed.");
    this.name = "ProviderPageTransactionExpiredError";
  }
}

export class ProviderPageTransactionWindowError extends Error {
  readonly code = "PROVIDER_PAGE_TRANSACTION_WINDOW_EXHAUSTED";
  constructor() { super("The bounded provider page transaction window is exhausted."); }
}

function own(value: unknown, name: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  const field = Object.getOwnPropertyDescriptor(value, name);
  return field && "value" in field ? field.value : undefined;
}

/** Inspect only Prisma's closed timeout template, never log error text, SQL, or metadata. */
export function providerPageQueryExpiration(error: unknown): ProviderPageTransactionExpiredError | null {
  try {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || own(error, "code") !== "P2028") return null;
    const detail = own(own(error, "meta"), "error");
    if (typeof detail !== "string" || detail.length > 1_024) return null;
    const match = /^(?:Transaction already closed: )?A query cannot be executed on an expired transaction\. The timeout for this transaction was ([0-9]+) ms, however ([0-9]+) ms passed since the start of the transaction\. Consider increasing the interactive transaction timeout or doing less work in the transaction\.$/u.exec(detail);
    if (!match) return null;
    const timeout = Number(match[1]), elapsed = Number(match[2]);
    return Number.isSafeInteger(timeout) && timeout > 0 && Number.isSafeInteger(elapsed) && elapsed >= timeout
      ? new ProviderPageTransactionExpiredError(timeout, elapsed) : null;
  } catch { return null; }
}

/** Two sequential attempts at most. Only an expired query inside a rejected callback can retry. */
export async function runProviderPageTransaction<T>(input: {
  database: Pick<ProviderPrismaClient, "$transaction">;
  deadlineAt: number;
  maximumTransactionMilliseconds?: number;
  operation(transaction: ProviderTransactionClient, attempt: number, timeoutMilliseconds: number): Promise<T>;
  now?: () => number;
}): Promise<T> {
  const now = input.now ?? Date.now;
  const maximum = input.maximumTransactionMilliseconds ?? 30_000;
  if (!Number.isSafeInteger(maximum) || maximum < 1_000 || maximum > 480_000) {
    throw new RangeError("The provider page transaction budget is invalid.");
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const timeout = Math.min(maximum, Math.floor(input.deadlineAt - now() - 5_000));
    if (!Number.isSafeInteger(timeout) || timeout < 1_000) throw new ProviderPageTransactionWindowError();
    let callbackFailure: unknown;
    try {
      return await input.database.$transaction(async transaction => {
        try { return await input.operation(transaction, attempt, timeout); }
        catch (error) { callbackFailure = error; throw error; }
      }, { maxWait: 5_000, timeout, isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      // Awaiting $transaction proves its rollback attempt has settled. A commit
      // rejection or any unknown outcome is never admitted to this retry path.
      const expired = callbackFailure === error ? providerPageQueryExpiration(error) : null;
      if (expired === null) throw error;
      if (attempt === 1 || input.deadlineAt - now() < 6_000) throw expired;
    }
  }
  throw new ProviderPageTransactionWindowError();
}

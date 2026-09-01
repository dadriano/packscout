import { ProviderBackfillSupervisorError } from "./provider-backfill-supervisor-policy.mts";

/** Error objects are untrusted: never invoke getters, inspect prototypes or
 * stringify their values. Proxies may throw even while reading a descriptor. */
function ownString(error: unknown, key: string): string | null {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) return null;
  try {
    const property = Object.getOwnPropertyDescriptor(error, key);
    return property && "value" in property && typeof property.value === "string" ? property.value : null;
  } catch { return null; }
}
export function residentFailureCode(error: unknown): string {
  const code = ownString(error, "code");
  return code && /^(BACKFILL|CONTINUOUS)_[A-Z0-9_]{1,100}$/u.test(code) ? code : "CONTINUOUS_OPERATION_FAILED";
}
/** Only called around connection startup and the initial read-only authority
 * check. This capability is never issued by a queue/write/child failure. */
export async function withResidentStartup<T>(start: () => Promise<T>): Promise<T> {
  try { return await start(); }
  catch (error) {
    const code = ownString(error, "code") ?? ownString(error, "errorCode");
    if (code && ["P1001", "P1002", "P1017", "P2024", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT",
      "EHOSTUNREACH", "ENETUNREACH"].includes(code)) throw new ProviderBackfillSupervisorError("CONTINUOUS_STARTUP_UNAVAILABLE");
    throw error;
  }
}

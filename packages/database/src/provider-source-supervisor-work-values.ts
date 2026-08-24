import { PersistenceError } from "./persistence-error.ts";

export function providerSourceCursorValue(
  cursor: string | null,
): string | null {
  if (cursor === null) return null;
  if (new TextEncoder().encode(cursor).byteLength === 0) {
    throw new PersistenceError("SOURCE_FENCED", "Opaque cursor storage is empty.");
  }
  return cursor;
}

export function providerSourceBoundedCounter(
  value: unknown,
  key: string,
): number {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return 0;
  }
  const candidate = (value as Record<string, unknown>)[key];
  return Number.isSafeInteger(candidate) && Number(candidate) >= 0
    ? Number(candidate)
    : 0;
}

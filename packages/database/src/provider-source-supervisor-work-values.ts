import { PersistenceError } from "./persistence-error.ts";

export function providerSourceCheckpointValue(
  bytes: Uint8Array | null,
): string | null {
  if (bytes === null) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PersistenceError(
      "SOURCE_FENCED",
      "Opaque checkpoint storage is not valid UTF-8.",
    );
  }
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

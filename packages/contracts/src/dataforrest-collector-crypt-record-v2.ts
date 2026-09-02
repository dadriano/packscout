type NativeRecord = Readonly<Record<string, unknown>>;

function nativeRecord(value: unknown): NativeRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as NativeRecord
    : null;
}

/**
 * Collector Crypt catalog packs have been observed without the outer
 * availability field. V2 treats only that absent outer field as unknown; all
 * present values remain available to the strict envelope schema unchanged.
 */
export function adaptDataforrestCollectorCryptRecordV2(record: unknown): unknown {
  const native = nativeRecord(record);
  if (
    native === null ||
    native.stream !== "catalog" ||
    native.entity !== "pack" ||
    Object.hasOwn(native, "available")
  ) {
    return record;
  }
  return { ...native, available: null };
}

import { isProxy } from "node:util/types";

export class SharedPublicationPersistenceError extends Error {
  constructor(readonly code: "SHARED_SCOPE_MISMATCH" | "SHARED_LEASE_LOST" | "SHARED_STATE_CONFLICT" |
    "SHARED_INPUT_INVALID" | "SHARED_LIMIT_EXCEEDED" | "SHARED_PERSISTENCE_FAILED") {
    super(code); this.name = "SharedPublicationPersistenceError";
  }
}
export function sharedInvariant(value: unknown, code: SharedPublicationPersistenceError["code"] = "SHARED_STATE_CONFLICT"): asserts value {
  if (!value) throw new SharedPublicationPersistenceError(code);
}
export function sharedBound(value: number, maximum: number) {
  sharedInvariant(Number.isSafeInteger(value) && value > 0 && value <= maximum, "SHARED_LIMIT_EXCEEDED"); return value;
}
export function sharedParse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const parsed = schema.safeParse(value); sharedInvariant(parsed.success, "SHARED_INPUT_INVALID"); return parsed.data;
}
/** Bound trusted-server DTOs before cloning, parsing, hashing, getters, or asynchronous work. */
export function captureSharedInput<T>(input: T, maximumBytes = 8_000_000): T {
  let nodes = 0, bytes = 0;
  const ancestors = new Set<object>(), encoder = new TextEncoder();
  const visit = (value: unknown, depth: number): void => {
    sharedInvariant(++nodes <= 100_000 && depth <= 24, "SHARED_LIMIT_EXCEEDED");
    if (typeof value === "string") { sharedInvariant(value.length <= maximumBytes, "SHARED_LIMIT_EXCEEDED"); bytes += encoder.encode(value).length; }
    else if (value === null || typeof value === "boolean") bytes += 5;
    else if (typeof value === "number") { sharedInvariant(Number.isSafeInteger(value) && !Object.is(value, -0), "SHARED_INPUT_INVALID"); bytes += 20; }
    else {
      sharedInvariant(typeof value === "object" && !isProxy(value) && !ancestors.has(value), "SHARED_INPUT_INVALID");
      const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
      sharedInvariant(array ? prototype === Array.prototype && value.length <= 10_000 : prototype === Object.prototype || prototype === null, "SHARED_INPUT_INVALID");
      const keys = Reflect.ownKeys(value);
      sharedInvariant(keys.length <= (array ? 10_001 : 128), "SHARED_LIMIT_EXCEEDED"); ancestors.add(value);
      for (const key of keys) {
        sharedInvariant(typeof key === "string" && key.length <= 256, "SHARED_INPUT_INVALID");
        if (array && key === "length") continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        sharedInvariant("value" in descriptor && descriptor.enumerable, "SHARED_INPUT_INVALID");
        if (array) sharedInvariant(/^(0|[1-9][0-9]*)$/u.test(key) && Number(key) < value.length, "SHARED_INPUT_INVALID");
        bytes += key.length; visit(descriptor.value, depth + 1);
      }
      if (array) sharedInvariant(keys.length === value.length + 1, "SHARED_INPUT_INVALID"); ancestors.delete(value);
    }
    sharedInvariant(bytes <= maximumBytes, "SHARED_LIMIT_EXCEEDED");
  };
  visit(input, 0); return structuredClone(input);
}

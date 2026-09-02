import { createHash } from "node:crypto";

const HASH_DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,127})$/u;
const FRAGMENTS_PER_EVENT_LOOP_TURN = 4_096;

function* canonicalJsonFragments(
  candidate: unknown,
  ancestors: Set<object>,
): Generator<string, void, undefined> {
  if (candidate === null) {
    yield "null";
    return;
  }
  if (typeof candidate === "string" || typeof candidate === "boolean") {
    yield JSON.stringify(candidate);
    return;
  }
  if (typeof candidate === "number") {
    if (!Number.isFinite(candidate)) {
      throw new TypeError("Canonical JSON cannot contain non-finite numbers.");
    }
    yield JSON.stringify(candidate);
    return;
  }
  if (typeof candidate !== "object") {
    throw new TypeError(`Canonical JSON cannot contain ${typeof candidate}.`);
  }
  if (ancestors.has(candidate)) {
    throw new TypeError("Canonical JSON cannot contain cycles.");
  }
  ancestors.add(candidate);
  try {
    if (Array.isArray(candidate)) {
      yield "[";
      for (let index = 0; index < candidate.length; index += 1) {
        if (index > 0) yield ",";
        if (index in candidate) {
          yield* canonicalJsonFragments(candidate[index], ancestors);
        }
      }
      yield "]";
      return;
    }
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON accepts only plain objects.");
    }
    const source = candidate as Record<string, unknown>;
    yield "{";
    const keys = Object.keys(source).sort();
    for (let index = 0; index < keys.length; index += 1) {
      if (index > 0) yield ",";
      const key = keys[index]!;
      yield JSON.stringify(key);
      yield ":";
      yield* canonicalJsonFragments(source[key], ancestors);
    }
    yield "}";
  } finally {
    ancestors.delete(candidate);
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function awaitWhileActive<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let aborted!: () => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
  try {
    return await Promise.race([operation, cancellation]);
  } finally {
    signal.removeEventListener("abort", aborted);
  }
}

/**
 * Hashes governed canonical JSON without materializing the canonical graph.
 * Event-loop turns make request cancellation observable during large graphs.
 */
export async function interruptibleSha256CanonicalJson(
  domain: string,
  value: unknown,
  signal: AbortSignal,
): Promise<string> {
  if (!HASH_DOMAIN_PATTERN.test(domain)) {
    throw new TypeError("Canonical hash domain is invalid.");
  }
  signal.throwIfAborted();
  const hash = createHash("sha256");
  let fragments = 0;
  for (const fragment of canonicalJsonFragments(
    { domain, value },
    new Set<object>(),
  )) {
    hash.update(fragment, "utf8");
    fragments += 1;
    if (fragments % FRAGMENTS_PER_EVENT_LOOP_TURN === 0) {
      await yieldToEventLoop();
      signal.throwIfAborted();
    }
  }
  signal.throwIfAborted();
  const digest = await awaitWhileActive(
    Promise.resolve(hash.digest("hex")),
    signal,
  );
  signal.throwIfAborted();
  return digest;
}

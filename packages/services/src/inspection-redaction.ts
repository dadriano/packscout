/**
 * Removes credential-shaped values from anything the inspection surfaces
 * return.
 *
 * Canonical provenance records where a revision came from, and a provider
 * adapter's diagnostics can carry request context. That context is the one
 * place a bearer token, an API key, or a connection string could reach an
 * operator's browser. Redaction is therefore applied on the way out, at every
 * nesting depth, keyed on both the field name and the value's shape — a caller
 * that forgets to sanitize a new field gets redaction anyway rather than a leak.
 *
 * This is deliberately aggressive: a redacted field that was harmless costs an
 * operator one lookup elsewhere, while a surfaced credential is a live secret in
 * a browser, a screenshot, and a bug report.
 */

export const REDACTED = "[redacted]";

/** Field names whose value never leaves the server, whatever it holds. */
const SENSITIVE_KEY = new RegExp(
  [
    "secret",
    "token",
    "password",
    "passphrase",
    "authorization",
    "auth",
    "credential",
    "api[-_]?key",
    "access[-_]?key",
    "private[-_]?key",
    "signature",
    "cookie",
    "session",
    "bearer",
    "connection[-_]?string",
    "dsn",
  ].join("|"),
  "iu",
);

/** Value shapes that are credentials regardless of the field they sit in. */
const SENSITIVE_VALUE: readonly RegExp[] = [
  /^bearer\s+\S+/iu,
  /^basic\s+[A-Za-z0-9+/=]{8,}/iu,
  // A URL carrying inline credentials, e.g. postgres://user:pass@host/db
  /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/iu,
  // Common vendor key prefixes followed by a long opaque tail. The tail may
  // carry its own separators (`sk_live_…`), so underscores count toward it.
  /^(?:sk|pk|rk|ak)_[A-Za-z0-9_]{16,}/u,
  // A JWT: three base64url segments.
  /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/u,
];

/** Deepest structure walked before a value is dropped rather than recursed. */
const MAX_DEPTH = 12;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

function isSensitiveValue(value: string): boolean {
  return SENSITIVE_VALUE.some((pattern) => pattern.test(value.trim()));
}

/**
 * Returns a structurally identical value with credential-shaped content
 * replaced. Cycles are broken rather than followed, so a self-referential
 * payload cannot hang the request.
 */
export function redactSensitive(value: unknown): unknown {
  return redactAt(value, 0, new WeakSet());
}

function redactAt(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") {
    return isSensitiveValue(value) ? REDACTED : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return REDACTED;
  if (seen.has(value)) return REDACTED;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => redactAt(entry, depth + 1, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = isSensitiveKey(key)
      ? REDACTED
      : redactAt(entry, depth + 1, seen);
  }
  return result;
}

/**
 * Narrows a provenance document to a summary an operator can act on. Everything
 * not recognized is carried through redaction rather than dropped, so a mapper
 * that records something new stays visible without a code change here — but it
 * arrives sanitized.
 */
export function summarizeProvenance(provenance: unknown): {
  sourceRecordId: string | null;
  importRunId: string | null;
  mapperKey: string | null;
  mapperVersion: string | null;
  adapterKey: string | null;
  additional: Record<string, unknown>;
} | null {
  if (provenance === null || typeof provenance !== "object") return null;
  if (Array.isArray(provenance)) return null;
  const source = provenance as Record<string, unknown>;

  const named = new Set([
    "sourceRecordId",
    "source_record_id",
    "importRunId",
    "import_run_id",
    "runId",
    "run_id",
    "mapperKey",
    "mapper_key",
    "mapperVersion",
    "mapper_version",
    "adapterKey",
    "adapter_key",
    "sourceTypeKey",
    "source_type_key",
  ]);

  const additional: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (named.has(key)) continue;
    additional[key] = isSensitiveKey(key)
      ? REDACTED
      : redactAt(value, 1, new WeakSet());
  }

  return {
    sourceRecordId: readText(source, ["sourceRecordId", "source_record_id"]),
    importRunId: readText(source, [
      "importRunId",
      "import_run_id",
      "runId",
      "run_id",
    ]),
    mapperKey: readText(source, ["mapperKey", "mapper_key"]),
    mapperVersion: readText(source, ["mapperVersion", "mapper_version"]),
    adapterKey: readText(source, [
      "adapterKey",
      "adapter_key",
      "sourceTypeKey",
      "source_type_key",
    ]),
    additional,
  };
}

function readText(
  source: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) {
      return isSensitiveValue(value) ? REDACTED : value;
    }
  }
  return null;
}

#!/usr/bin/env node

import { createHash } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

export const DATAFOREST_ENDPOINT =
  "https://198.204.245.26.sslip.io/v1/events";
export const DATAFOREST_PLATFORM_FILTERS = Object.freeze([
  "courtyard",
  "collector_crypt",
  "phygitals",
  "clutchpacks",
]);
export const DATAFOREST_CAPTURE_DEFAULTS = Object.freeze({
  limit: 500,
  maxBytes: 2 * 1024 * 1024,
  timeoutMs: 10_000,
  concurrency: 2,
});

const MAX_CONCURRENCY = 4;
const MAX_REQUESTS = 24;
const MAX_SHAPE_DEPTH = 16;
const MAX_SHAPE_KEYS_PER_OBJECT = 128;
const MAX_SHAPE_NODES = 100_000;
const UNKNOWN_FILTER_SENTINEL = "__packscout_unknown__";
const MALFORMED_CURSOR_SENTINEL = "packscout-malformed-cursor";

const HELP = `Usage: npm run capture:dataforest-evidence:local -- [options]

Reads PACKSCOUT_DATA_API_TOKEN from the environment and writes one sanitized
JSON evidence report to stdout. The endpoint is fixed and cannot be overridden.

Options may only make the approved request bounds stricter:
  --limit <1-500>             Records requested per filtered page (default 500)
  --max-bytes <1-2097152>     Maximum response bytes (default 2097152)
  --timeout-ms <1-10000>      Per-request timeout (default 10000)
  --concurrency <2-4>         Parallel filtered probes (default 2)
  --help                      Show this message

Never pass the token as a command-line argument.`;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && !Number.isFinite(value)) return "non_finite_number";
  return typeof value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function roundedMilliseconds(startedAt) {
  return Math.round((performance.now() - startedAt) * 1_000) / 1_000;
}

function safeFieldName(key) {
  return /^[A-Za-z_][A-Za-z0-9_-]{0,79}$/u.test(key)
    ? key
    : "<dynamic-key>";
}

function parseBoundedInteger(raw, optionName, minimum, maximum) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${optionName} must be an integer from ${minimum} through ${maximum}.`,
    );
  }
  return value;
}

export function parseCaptureOptions(argumentsList) {
  const options = { ...DATAFOREST_CAPTURE_DEFAULTS };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--help") return { help: true, options };
    const next = argumentsList[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error("Every capture option requires a value. Use --help.");
    }
    if (argument === "--limit") {
      options.limit = parseBoundedInteger(next, argument, 1, 500);
    } else if (argument === "--max-bytes") {
      options.maxBytes = parseBoundedInteger(
        next,
        argument,
        1,
        DATAFOREST_CAPTURE_DEFAULTS.maxBytes,
      );
    } else if (argument === "--timeout-ms") {
      options.timeoutMs = parseBoundedInteger(next, argument, 1, 10_000);
    } else if (argument === "--concurrency") {
      options.concurrency = parseBoundedInteger(
        next,
        argument,
        2,
        MAX_CONCURRENCY,
      );
    } else {
      throw new Error("Unsupported capture option. Use --help.");
    }
    index += 1;
  }
  return { help: false, options };
}

export function readDataforestToken(environment) {
  const token = environment.PACKSCOUT_DATA_API_TOKEN;
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.trim() !== token ||
    /[\r\n\0]/u.test(token)
  ) {
    throw new Error(
      "PACKSCOUT_DATA_API_TOKEN must be a nonblank environment value without surrounding whitespace.",
    );
  }
  return token;
}

export function summarizeJsonStructure(value) {
  const entries = new Map();
  const state = { nodes: 0, truncated: false, dynamicKeyCount: 0 };

  function record(pathName, type) {
    const existing = entries.get(pathName) ?? {
      path: pathName,
      types: new Set(),
      occurrences: 0,
      nulls: 0,
    };
    existing.types.add(type);
    existing.occurrences += 1;
    if (type === "null") existing.nulls += 1;
    entries.set(pathName, existing);
  }

  function visit(current, pathName, depth) {
    if (state.nodes >= MAX_SHAPE_NODES || depth > MAX_SHAPE_DEPTH) {
      state.truncated = true;
      return;
    }
    state.nodes += 1;
    const type = valueType(current);
    record(pathName, type);

    if (Array.isArray(current)) {
      for (const item of current) visit(item, `${pathName}[]`, depth + 1);
      return;
    }
    if (!isPlainObject(current)) return;

    const keys = Object.keys(current).sort();
    if (keys.length > MAX_SHAPE_KEYS_PER_OBJECT) state.truncated = true;
    for (const key of keys.slice(0, MAX_SHAPE_KEYS_PER_OBJECT)) {
      const fieldName = safeFieldName(key);
      if (fieldName !== key) state.dynamicKeyCount += 1;
      visit(current[key], `${pathName}.${fieldName}`, depth + 1);
    }
  }

  visit(value, "$", 0);
  const paths = [...entries.values()]
    .map((entry) => ({
      path: entry.path,
      types: [...entry.types].sort(),
      occurrences: entry.occurrences,
      nulls: entry.nulls,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));

  return {
    algorithm: "field-path-and-json-type-v1",
    sha256: sha256(JSON.stringify(paths)),
    rootType: valueType(value),
    pathCount: paths.length,
    paths,
    truncated: state.truncated,
    dynamicKeyCount: state.dynamicKeyCount,
  };
}

function findScalarValuesByKey(value, expectedKey, output, depth = 0) {
  if (depth > MAX_SHAPE_DEPTH) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      findScalarValuesByKey(item, expectedKey, output, depth + 1);
    }
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (
      key === expectedKey &&
      (typeof child === "string" || typeof child === "number")
    ) {
      output.push(`${typeof child}:${String(child)}`);
    }
    findScalarValuesByKey(child, expectedKey, output, depth + 1);
  }
}

function summarizeFilterIsolation(records, requestedFilter) {
  if (!Array.isArray(records) || !requestedFilter) return null;
  let recordsWithPlatform = 0;
  let matchingRecords = 0;
  let mismatchingRecords = 0;
  let ambiguousRecords = 0;
  for (const record of records) {
    const values = [];
    findScalarValuesByKey(record, "platform", values);
    if (values.length === 0) continue;
    recordsWithPlatform += 1;
    const matches = values.filter(
      (value) => value === `string:${requestedFilter}`,
    ).length;
    if (matches > 0) matchingRecords += 1;
    else mismatchingRecords += 1;
    if (values.length > 1) ambiguousRecords += 1;
  }
  return {
    requestedFilter,
    recordsWithPlatform,
    matchingRecords,
    mismatchingRecords,
    missingPlatformRecords: records.length - recordsWithPlatform,
    ambiguousRecords,
  };
}

function summarizeRecordIdentities(records) {
  if (!Array.isArray(records)) {
    return {
      evidence: null,
      privateSequence: [],
    };
  }
  const privateSequence = [];
  let missingRecords = 0;
  let ambiguousRecords = 0;
  for (const record of records) {
    const values = [];
    findScalarValuesByKey(record, "record_id", values);
    if (values.length === 0) {
      missingRecords += 1;
      privateSequence.push(null);
    } else {
      if (values.length > 1) ambiguousRecords += 1;
      privateSequence.push(values[0]);
    }
  }
  const present = privateSequence.filter((value) => value !== null);
  return {
    evidence: {
      recordsWithIdentity: present.length,
      missingIdentityRecords: missingRecords,
      ambiguousIdentityRecords: ambiguousRecords,
      uniqueIdentityCount: new Set(present).size,
      duplicateIdentityCount: present.length - new Set(present).size,
    },
    privateSequence,
  };
}

function pollAfterClass(value, present) {
  if (!present) return "missing";
  if (value === null) return "null";
  if (!Number.isInteger(value)) return "invalid_type_or_fraction";
  if (value < 0) return "negative_integer";
  if (value === 0) return "zero";
  return "positive_integer";
}

function summarizePage(payload, requestedFilter) {
  const objectPayload = isPlainObject(payload) ? payload : null;
  const records = Array.isArray(objectPayload?.records)
    ? objectPayload.records
    : null;
  const nextCursorValue = objectPayload?.next_cursor;
  const nextCursor =
    typeof nextCursorValue === "string" && nextCursorValue.length > 0
      ? nextCursorValue
      : null;
  const identity = summarizeRecordIdentities(records);
  return {
    evidence: {
      wrapperIsObject: objectPayload !== null,
      records: {
        present: objectPayload ? Object.hasOwn(objectPayload, "records") : false,
        isArray: records !== null,
        count: records?.length ?? null,
      },
      nextCursor: {
        present: objectPayload
          ? Object.hasOwn(objectPayload, "next_cursor")
          : false,
        type: valueType(nextCursorValue),
        nonblankString: nextCursor !== null,
      },
      pollAfter: {
        present: objectPayload
          ? Object.hasOwn(objectPayload, "poll_after_seconds")
          : false,
        type: valueType(objectPayload?.poll_after_seconds),
        class: pollAfterClass(
          objectPayload?.poll_after_seconds,
          objectPayload
            ? Object.hasOwn(objectPayload, "poll_after_seconds")
            : false,
        ),
      },
      filterIsolation: summarizeFilterIsolation(records, requestedFilter),
      recordIdentity: identity.evidence,
    },
    private: {
      nextCursor,
      recordIdentitySequence: identity.privateSequence,
    },
  };
}

function classifyHttpStatus(status) {
  if (status >= 200 && status < 300) {
    return { statusClass: "success", retryClass: "none" };
  }
  if (status === 401 || status === 403) {
    return {
      statusClass: "authentication_or_authorization",
      retryClass: "action_required",
    };
  }
  if (status === 408 || status === 425 || status === 429) {
    return { statusClass: "remote_throttle_or_timeout", retryClass: "retryable" };
  }
  if (status >= 500) {
    return { statusClass: "server_failure", retryClass: "retryable" };
  }
  if (status >= 400) {
    return { statusClass: "request_validation", retryClass: "action_required" };
  }
  return { statusClass: "other_http", retryClass: "do_not_guess" };
}

export async function readBoundedResponseBody(response, maximumBytes) {
  const contentLengthHeader = response.headers.get("content-length");
  const contentLength = /^\d+$/u.test(contentLengthHeader ?? "")
    ? Number(contentLengthHeader)
    : null;
  if (contentLength !== null && contentLength > maximumBytes) {
    await response.body?.cancel();
    return {
      exceeded: true,
      bytes: 0,
      advertisedBytes: contentLength,
      buffer: null,
    };
  }

  if (!response.body) {
    return {
      exceeded: false,
      bytes: 0,
      advertisedBytes: contentLength,
      buffer: Buffer.alloc(0),
    };
  }

  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel();
      return {
        exceeded: true,
        bytes,
        advertisedBytes: contentLength,
        buffer: null,
      };
    }
    chunks.push(Buffer.from(value));
  }
  return {
    exceeded: false,
    bytes,
    advertisedBytes: contentLength,
    buffer: Buffer.concat(chunks, bytes),
  };
}

function requestMetadata(specification) {
  return {
    id: specification.id,
    kind: specification.kind,
    method: "GET",
    endpoint: {
      protocol: "https:",
      host: "198.204.245.26.sslip.io",
      path: "/v1/events",
    },
    authentication: specification.authentication,
    filter: specification.outputFilter ?? specification.filter ?? null,
    cursorMode: specification.cursorMode,
    cursorSourceFilter: specification.cursorSourceFilter ?? null,
    limit: specification.includeLimit === false ? null : specification.limit,
  };
}

function buildRequestUrl(specification) {
  const url = new URL(DATAFOREST_ENDPOINT);
  if (specification.filter) url.searchParams.set("platform", specification.filter);
  if (specification.includeLimit !== false) {
    url.searchParams.set("limit", String(specification.limit));
  }
  if (specification.cursor !== null && specification.cursor !== undefined) {
    url.searchParams.set("cursor", specification.cursor);
  }
  return url;
}

async function captureRequest(specification, context) {
  const startedAt = performance.now();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, context.timeoutMs);

  const headers = { accept: "application/json" };
  if (specification.authentication === "configured_bearer") {
    headers.authorization = `Bearer ${context.token}`;
  }

  let response;
  try {
    response = await context.fetchImpl(buildRequestUrl(specification), {
      method: "GET",
      headers,
      redirect: "error",
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    return {
      evidence: {
        request: requestMetadata(specification),
        response: {
          outcome: timedOut ? "timeout" : "network_failure",
          status: null,
          statusClass: timedOut ? "client_timeout" : "network_failure",
          retryClass: "retryable",
          latencyMs: roundedMilliseconds(startedAt),
          bytes: null,
          responseLimitExceeded: false,
          json: null,
          page: null,
        },
      },
      private: {
        bodySha256: null,
        nextCursor: null,
        recordIdentitySequence: [],
      },
    };
  }

  try {
    const body = await readBoundedResponseBody(response, context.maxBytes);
    const classification = classifyHttpStatus(response.status);
    if (body.exceeded) {
      return {
        evidence: {
          request: requestMetadata(specification),
          response: {
            outcome: "response_too_large",
            status: response.status,
            ...classification,
            latencyMs: roundedMilliseconds(startedAt),
            bytes: body.bytes,
            advertisedBytes: body.advertisedBytes,
            responseLimitExceeded: true,
            json: null,
            page: null,
          },
        },
        private: {
          bodySha256: null,
          nextCursor: null,
          recordIdentitySequence: [],
        },
      };
    }

    const bodySha256 = sha256(body.buffer);
    let payload = null;
    let jsonFormat = "empty";
    if (body.buffer.length > 0) {
      try {
        payload = JSON.parse(body.buffer.toString("utf8"));
        jsonFormat = "valid_json";
      } catch {
        jsonFormat = "non_json";
      }
    }
    const shape = payload === null ? null : summarizeJsonStructure(payload);
    const page =
      payload === null
        ? {
            evidence: null,
            private: { nextCursor: null, recordIdentitySequence: [] },
          }
        : summarizePage(payload, specification.filter ?? null);

    return {
      evidence: {
        request: requestMetadata(specification),
        response: {
          outcome: "response",
          status: response.status,
          ...classification,
          latencyMs: roundedMilliseconds(startedAt),
          bytes: body.bytes,
          advertisedBytes: body.advertisedBytes,
          responseLimitExceeded: false,
          json: {
            format: jsonFormat,
            structure: shape,
          },
          page: page.evidence,
        },
      },
      private: { ...page.private, bodySha256 },
    };
  } catch {
    return {
      evidence: {
        request: requestMetadata(specification),
        response: {
          outcome: timedOut ? "timeout" : "body_read_failure",
          status: response.status,
          statusClass: timedOut ? "client_timeout" : "response_failure",
          retryClass: "retryable",
          latencyMs: roundedMilliseconds(startedAt),
          bytes: null,
          responseLimitExceeded: false,
          json: null,
          page: null,
        },
      },
      private: {
        bodySha256: null,
        nextCursor: null,
        recordIdentitySequence: [],
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

function skippedProbe(id, kind, reason) {
  return {
    request: { id, kind },
    response: { outcome: "skipped", reason },
  };
}

function sequenceComparison(left, right) {
  const comparableCount = Math.min(left.length, right.length);
  let equalAtSamePosition = 0;
  for (let index = 0; index < comparableCount; index += 1) {
    if (left[index] !== null && left[index] === right[index]) {
      equalAtSamePosition += 1;
    }
  }
  return {
    comparableCount,
    equalAtSamePosition,
    sameLength: left.length === right.length,
    exactSequenceEqual:
      left.length === right.length &&
      left.every((value, index) => value === right[index]),
  };
}

function replayComparison(continuation, replay) {
  return {
    sameInputCursor: true,
    statusEqual:
      continuation.evidence.response.status === replay.evidence.response.status,
    bodyHashEqual:
      continuation.private.bodySha256 !== null &&
      continuation.private.bodySha256 === replay.private.bodySha256,
    structureHashEqual:
      continuation.evidence.response.json?.structure?.sha256 !== undefined &&
      continuation.evidence.response.json?.structure?.sha256 ===
        replay.evidence.response.json?.structure?.sha256,
    nextCursorRelationshipEqual:
      continuation.private.nextCursor !== null &&
      continuation.private.nextCursor === replay.private.nextCursor,
    recordIdentity: sequenceComparison(
      continuation.private.recordIdentitySequence,
      replay.private.recordIdentitySequence,
    ),
  };
}

function assertTokenAbsent(report, token) {
  if (JSON.stringify(report).includes(token)) {
    throw new Error("Sanitization invariant failed before report output.");
  }
}

export async function captureDataforestEvidence({
  token,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  ...requestedOptions
} = {}) {
  readDataforestToken({ PACKSCOUT_DATA_API_TOKEN: token });
  if (typeof fetchImpl !== "function") {
    throw new Error("A Fetch-compatible implementation is required.");
  }
  const options = {
    ...DATAFOREST_CAPTURE_DEFAULTS,
    ...requestedOptions,
  };
  parseBoundedInteger(String(options.limit), "limit", 1, 500);
  parseBoundedInteger(
    String(options.maxBytes),
    "maxBytes",
    1,
    DATAFOREST_CAPTURE_DEFAULTS.maxBytes,
  );
  parseBoundedInteger(String(options.timeoutMs), "timeoutMs", 1, 10_000);
  parseBoundedInteger(
    String(options.concurrency),
    "concurrency",
    2,
    MAX_CONCURRENCY,
  );

  let requestCount = 0;
  let inFlightRequests = 0;
  let maximumInFlightRequests = 0;
  const request = async (specification) => {
    requestCount += 1;
    if (requestCount > MAX_REQUESTS) {
      throw new Error("The fixed evidence request budget was exceeded.");
    }
    inFlightRequests += 1;
    maximumInFlightRequests = Math.max(
      maximumInFlightRequests,
      inFlightRequests,
    );
    try {
      return await captureRequest(
        { ...specification, limit: options.limit },
        { ...options, token, fetchImpl },
      );
    } finally {
      inFlightRequests -= 1;
    }
  };

  const profileProbe = await request({
    id: "profile_connection",
    kind: "profile_connection",
    authentication: "configured_bearer",
    filter: null,
    cursor: null,
    cursorMode: "omitted",
    includeLimit: false,
  });

  const platformRuns = [];
  for (const filter of DATAFOREST_PLATFORM_FILTERS) {
    const initial = await request({
      id: `${filter}_initial`,
      kind: "initial",
      authentication: "configured_bearer",
      filter,
      cursor: null,
      cursorMode: "omitted",
    });
    let continuation = null;
    let replay = null;
    if (initial.private.nextCursor !== null) {
      continuation = await request({
        id: `${filter}_continuation`,
        kind: "continuation",
        authentication: "configured_bearer",
        filter,
        cursor: initial.private.nextCursor,
        cursorMode: "continuation",
      });
      replay = await request({
        id: `${filter}_same_cursor_replay`,
        kind: "same_cursor_replay",
        authentication: "configured_bearer",
        filter,
        cursor: initial.private.nextCursor,
        cursorMode: "same_cursor_replay",
      });
    }
    platformRuns.push({ filter, initial, continuation, replay });
  }

  const unauthorized = await request({
    id: "unauthorized_without_token",
    kind: "negative_401",
    authentication: "omitted",
    filter: null,
    cursor: null,
    cursorMode: "omitted",
    includeLimit: false,
  });
  const unknownFilter = await request({
    id: "unknown_filter",
    kind: "negative_unknown_filter",
    authentication: "configured_bearer",
    filter: UNKNOWN_FILTER_SENTINEL,
    outputFilter: "<unknown-filter-sentinel>",
    cursor: null,
    cursorMode: "omitted",
  });
  const malformedCursor = await request({
    id: "malformed_cursor",
    kind: "negative_malformed_cursor",
    authentication: "configured_bearer",
    filter: DATAFOREST_PLATFORM_FILTERS[0],
    cursor: MALFORMED_CURSOR_SENTINEL,
    cursorMode: "malformed_sentinel",
  });

  const crossFilterEvidence = [];
  for (let index = 0; index < platformRuns.length; index += 1) {
    const source = platformRuns[index];
    const targetFilter = DATAFOREST_PLATFORM_FILTERS[
      (index + 1) % DATAFOREST_PLATFORM_FILTERS.length
    ];
    if (source.initial.private.nextCursor === null) {
      crossFilterEvidence.push(
        skippedProbe(
          `${source.filter}_cursor_on_${targetFilter}`,
          "negative_cross_filter_cursor",
          "initial_cursor_unavailable",
        ),
      );
      continue;
    }
    const result = await request({
      id: `${source.filter}_cursor_on_${targetFilter}`,
      kind: "negative_cross_filter_cursor",
      authentication: "configured_bearer",
      filter: targetFilter,
      cursor: source.initial.private.nextCursor,
      cursorMode: "cross_filter",
      cursorSourceFilter: source.filter,
    });
    crossFilterEvidence.push(result.evidence);
  }

  const parallelFilters = DATAFOREST_PLATFORM_FILTERS.slice(
    0,
    options.concurrency,
  );
  const parallelStartedAt = performance.now();
  const parallelResults = await Promise.all(
    parallelFilters.map((filter) =>
      request({
        id: `${filter}_parallel`,
        kind: "parallel_initial",
        authentication: "configured_bearer",
        filter,
        cursor: null,
        cursorMode: "omitted",
      }),
    ),
  );
  const parallelCursors = parallelResults
    .map((result) => result.private.nextCursor)
    .filter((cursor) => cursor !== null);

  const report = {
    schemaVersion: 1,
    evidenceKind: "sanitized_dataforest_contract_capture",
    capturedAt: now().toISOString(),
    endpoint: {
      protocol: "https:",
      host: "198.204.245.26.sslip.io",
      path: "/v1/events",
      redirects: "rejected",
      method: "GET",
    },
    bounds: {
      recordsPerFilteredRequest: options.limit,
      maximumResponseBytes: options.maxBytes,
      requestTimeoutMs: options.timeoutMs,
      parallelRequestCount: options.concurrency,
      maximumRequestBudget: MAX_REQUESTS,
      actualRequestCount: requestCount,
    },
    sanitization: {
      version: "structure-only-v1",
      preserves: [
        "field_names",
        "json_types",
        "nesting",
        "null_counts",
        "record_counts",
        "response_bytes",
        "latency",
        "status_classes",
        "raw_body_hash_equality_boolean",
        "cursor_relationship_booleans",
      ],
      omits: [
        "authorization",
        "credentials",
        "cursor_values",
        "record_identity_values",
        "transaction_values",
        "wallet_values",
        "username_values",
        "provider_payload_values",
      ],
    },
    profileProbe: profileProbe.evidence,
    platforms: platformRuns.map((run) => ({
      filter: run.filter,
      initial: run.initial.evidence,
      continuation:
        run.continuation?.evidence ??
        skippedProbe(
          `${run.filter}_continuation`,
          "continuation",
          "initial_cursor_unavailable",
        ),
      sameCursorReplay:
        run.replay?.evidence ??
        skippedProbe(
          `${run.filter}_same_cursor_replay`,
          "same_cursor_replay",
          "initial_cursor_unavailable",
        ),
      replayComparison:
        run.continuation && run.replay
          ? replayComparison(run.continuation, run.replay)
          : null,
    })),
    negativeProbes: {
      unauthorized: unauthorized.evidence,
      unknownFilter: unknownFilter.evidence,
      malformedCursor: malformedCursor.evidence,
      crossFilterCursor: crossFilterEvidence,
    },
    parallelProbe: {
      requestedConcurrency: options.concurrency,
      filters: parallelFilters,
      wallClockMs: roundedMilliseconds(parallelStartedAt),
      maximumClientInFlightRequests: maximumInFlightRequests,
      clientOverlapObserved: maximumInFlightRequests >= 2,
      allSuccessful: parallelResults.every(
        (result) => result.evidence.response.statusClass === "success",
      ),
      allFilterCorrect: parallelResults.every(
        (result) =>
          result.evidence.response.page?.filterIsolation?.mismatchingRecords ===
          0,
      ),
      allCursorsPresent: parallelCursors.length === parallelResults.length,
      cursorsIndependent:
        parallelCursors.length === parallelResults.length &&
        new Set(parallelCursors).size === parallelCursors.length,
      requests: parallelResults.map((result) => result.evidence),
    },
  };

  assertTokenAbsent(report, token);
  return report;
}

export async function runCaptureCli({
  argumentsList = process.argv.slice(2),
  environment = process.env,
  fetchImpl = globalThis.fetch,
  write = (value) => process.stdout.write(value),
} = {}) {
  const parsed = parseCaptureOptions(argumentsList);
  if (parsed.help) {
    write(`${HELP}\n`);
    return;
  }
  const token = readDataforestToken(environment);
  if (environment === process.env) {
    delete process.env.PACKSCOUT_DATA_API_TOKEN;
  }
  const report = await captureDataforestEvidence({
    token,
    fetchImpl,
    ...parsed.options,
  });
  write(`${JSON.stringify(report, null, 2)}\n`);
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMain) {
  runCaptureCli().catch((error) => {
    const message =
      error instanceof Error
        ? error.message
        : "The capture failed without a safe error detail.";
    console.error(`DataForrest evidence capture failed: ${message}`);
    process.exitCode = 1;
  });
}

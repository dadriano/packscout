import assert from "node:assert/strict";
import { test } from "node:test";
import { createPublicRequestLogEntry } from "./public-request-log.server";

test("creates a bounded pathname-only public request outcome", () => {
  assert.deepEqual(
    createPublicRequestLogEntry({
      pathname: "/api/public-read-failure",
      source: "public-read-failure-route",
      outcome: "failed",
      code: "TRANSPORT_UNAVAILABLE",
      publicReleaseId: null,
      retainedPreviousResult: true,
    }),
    {
      pathname: "/api/public-read-failure",
      source: "public-read-failure-route",
      outcome: "failed",
      code: "TRANSPORT_UNAVAILABLE",
      publicReleaseId: null,
      retainedPreviousResult: true,
    },
  );
});

test("rejects full URLs, query strings, fragments, and unknown logging fields", () => {
  const base = {
    pathname: "/packs",
    source: "server-preload",
    outcome: "failed",
    code: "RELEASE_UNAVAILABLE",
    publicReleaseId: null,
    retainedPreviousResult: false,
  } as const;
  for (const pathname of [
    "https://packscout.example/packs?q=sentinel",
    "/packs?q=sentinel",
    "/packs#sentinel",
  ]) {
    assert.equal(createPublicRequestLogEntry({ ...base, pathname }), null);
  }
  assert.equal(
    createPublicRequestLogEntry({
      ...base,
      q: "query-sentinel",
      cursor: "cursor-sentinel",
      cursorStack: "stack-sentinel",
      fingerprint: "fingerprint-sentinel",
    }),
    null,
  );
});

test("rejects unbounded codes and unsafe release identifiers", () => {
  const base = {
    pathname: "/packs",
    source: "reactive-client",
    outcome: "rejected",
    code: "INVALID_QUERY",
    publicReleaseId: "20000000-0000-4000-8000-000000000002",
    retainedPreviousResult: true,
  } as const;
  assert.ok(createPublicRequestLogEntry(base));
  assert.equal(
    createPublicRequestLogEntry({ ...base, code: "PROVIDER_SECRET" }),
    null,
  );
  assert.equal(
    createPublicRequestLogEntry({ ...base, publicReleaseId: "../secret" }),
    null,
  );
});

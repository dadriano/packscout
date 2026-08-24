import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REDACTED,
  redactSensitive,
  summarizeProvenance,
} from "./inspection-redaction.ts";

test("credential-shaped field names are redacted at any depth", () => {
  const redacted = redactSensitive({
    safe: "keep",
    request: {
      headers: { authorization: "Bearer abc.def.ghi", accept: "json" },
      nested: [{ apiKey: "value" }, { api_key: "value" }, { ok: "value" }],
    },
  }) as {
    safe: string;
    request: {
      headers: Record<string, string>;
      nested: Record<string, string>[];
    };
  };

  assert.equal(redacted.safe, "keep");
  assert.equal(redacted.request.headers.authorization, REDACTED);
  assert.equal(redacted.request.headers.accept, "json");
  assert.equal(redacted.request.nested[0].apiKey, REDACTED);
  assert.equal(redacted.request.nested[1].api_key, REDACTED);
  assert.equal(redacted.request.nested[2].ok, "value");
});

test("credential-shaped values are redacted whatever field they sit in", () => {
  const redacted = redactSensitive({
    note: "Bearer sk_live_0123456789abcdef",
    dsnLike: "postgres://user:hunter2@db.internal:5432/packscout",
    jwtLike: "eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM",
    vendorKey: "sk_live_0123456789abcdefgh",
    innocent: "courtyard-pack-0001",
    number: 42,
  }) as Record<string, unknown>;

  assert.equal(redacted.note, REDACTED);
  assert.equal(redacted.dsnLike, REDACTED);
  assert.equal(redacted.jwtLike, REDACTED);
  assert.equal(redacted.vendorKey, REDACTED);
  assert.equal(redacted.innocent, "courtyard-pack-0001");
  assert.equal(redacted.number, 42);
});

test("a self-referential payload terminates instead of hanging", () => {
  const cyclic: Record<string, unknown> = { name: "root" };
  cyclic.self = cyclic;
  const redacted = redactSensitive(cyclic) as Record<string, unknown>;
  assert.equal(redacted.name, "root");
  assert.equal(redacted.self, REDACTED);
});

test("deeply nested structures stop at the depth bound", () => {
  let deep: unknown = "leaf";
  for (let index = 0; index < 40; index += 1) deep = { next: deep };
  // The point is that it returns at all, with the tail collapsed rather than
  // recursed to exhaustion.
  const redacted = redactSensitive(deep);
  assert.ok(redacted);
});

test("provenance is summarized and its unknown fields still redacted", () => {
  const summary = summarizeProvenance({
    source_record_id: "11111111-1111-4111-8111-111111111111",
    run_id: "22222222-2222-4222-8222-222222222222",
    mapper_key: "courtyard-catalog",
    mapper_version: "3",
    source_type_key: "dataforrest-events-v1",
    upstream: { bearerToken: "abc", page: 4 },
    requestSignature: "deadbeef",
  });

  assert.ok(summary);
  assert.equal(summary.sourceRecordId, "11111111-1111-4111-8111-111111111111");
  assert.equal(summary.importRunId, "22222222-2222-4222-8222-222222222222");
  assert.equal(summary.mapperKey, "courtyard-catalog");
  assert.equal(summary.mapperVersion, "3");
  assert.equal(summary.adapterKey, "dataforrest-events-v1");
  assert.equal(summary.additional.requestSignature, REDACTED);
  assert.deepEqual(summary.additional.upstream, {
    bearerToken: REDACTED,
    page: 4,
  });
});

test("a non-object provenance summarizes to nothing rather than guessing", () => {
  assert.equal(summarizeProvenance(null), null);
  assert.equal(summarizeProvenance("text"), null);
  assert.equal(summarizeProvenance([1, 2]), null);
});

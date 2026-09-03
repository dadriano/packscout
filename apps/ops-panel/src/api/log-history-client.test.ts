import assert from "node:assert/strict";
import { test } from "node:test";
import { planContextRead } from "../logs/history-session.ts";
import {
  fetchHistoryPage,
  historyPageUrl,
  isGenerationChanged,
  rawLogUrl,
} from "./log-history-client.ts";
import { LOG_GENERATION_CHANGED_CODE } from "./panel-types.ts";

/**
 * What a history request puts on the wire, and what it does with a refusal.
 *
 * The generation is the part worth testing rather than assuming: it is the only
 * thing that lets the server refuse a cursor whose file no longer exists, and a
 * request that omits it is answered from whatever now sits at that offset.
 */

test("a request carries the generation it believes it is reading", () => {
  const url = historyPageUrl({
    service: "worker",
    direction: "backward",
    cursor: 4_096,
    generation: 3,
    lines: 300,
  });
  assert.match(url, /service=worker/u);
  assert.match(url, /direction=backward/u);
  assert.match(url, /cursor=4096/u);
  assert.match(url, /generation=3/u);
});

test("a generation the caller does not know is left out rather than guessed", () => {
  const url = historyPageUrl({
    service: "worker",
    direction: "forward",
    cursor: 0,
    generation: null,
  });
  assert.ok(!url.includes("generation="));
});

test("opening a search result puts that match's generation on the wire", () => {
  const url = historyPageUrl({
    service: "worker",
    ...planContextRead({ offset: 900, generation: 4 }),
  });
  assert.match(url, /direction=around/u);
  assert.match(url, /cursor=900/u);
  assert.match(url, /generation=4/u);
});

/**
 * The reproduction: results come back from generation 4, the file rotates, and
 * only then is a match clicked. The server can refuse because the request names
 * the generation — and the refusal is what returns the reader to live instead
 * of showing the replacement file's bytes as that match's context.
 */
test("a context read of a rotated file is refused rather than answered", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  const requested: string[] = [];
  // Stands in for the panel after a rotation: generation 5 is what it has now.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    const generation = new URL(url, "http://panel.invalid").searchParams.get(
      "generation",
    );
    if (generation !== null && generation !== "5") {
      return new Response(
        JSON.stringify({
          error: "This log started a new generation.",
          code: LOG_GENERATION_CHANGED_CODE,
          service: "worker",
          generation: 5,
          requestedGeneration: Number(generation),
          reason: "generation",
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ service: "worker", generation: 5, lines: [] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;

  const match = { offset: 900, generation: 4 };
  await assert.rejects(
    () => fetchHistoryPage({ service: "worker", ...planContextRead(match) }),
    (error: unknown) => {
      assert.equal(isGenerationChanged(error), true);
      return true;
    },
  );
  assert.equal(requested.length, 1);
  assert.match(requested[0] ?? "", /generation=4/u);
});

test("a raw download names its service without any other parameter", () => {
  assert.equal(rawLogUrl("worker"), "/api/logs/download?service=worker");
  assert.match(rawLogUrl("../etc/passwd"), /%2E%2E%2Fetc%2Fpasswd|\.\.%2Fetc%2Fpasswd/u);
});

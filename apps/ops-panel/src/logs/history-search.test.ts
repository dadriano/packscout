import assert from "node:assert/strict";
import { test } from "node:test";
import type { LogLineRecord } from "../api/panel-types.ts";
import {
  compileFilter,
  createFilterTerm,
  EMPTY_FILTER,
  type FilterSpec,
} from "./filter.ts";
import {
  runHistorySearch,
  type SearchPageReply,
  type SearchProgress,
} from "./history-search.ts";

function line(
  service: string,
  offset: number,
  text: string,
  generation = 1,
): LogLineRecord {
  return {
    id: `line:${service}:${generation}:${offset}`,
    service,
    generation,
    offset,
    endOffset: offset + text.length + 1,
    text,
    observedAt: "2026-08-19T12:00:00.000Z",
    backfilled: true,
    partial: false,
  };
}

function withTerm(text: string): FilterSpec {
  return { ...EMPTY_FILTER, terms: [createFilterTerm(text)] };
}

/**
 * A service whose history is a fixed list of pages, oldest last. Each call
 * hands back the next one and reports the start of the log after them.
 */
function pagedService(
  service: string,
  pages: readonly (readonly LogLineRecord[])[],
  bytesPerPage = 1_000,
) {
  let index = 0;
  return {
    service,
    calls: () => index,
    next(): SearchPageReply {
      const lines = pages[index] ?? [];
      index += 1;
      return {
        service,
        generation: 1,
        lines,
        startCursor: Math.max(0, 10_000 - index * bytesPerPage),
        atStart: index >= pages.length,
        bytesRead: lines.length === 0 ? 0 : bytesPerPage,
      };
    },
  };
}

test("a search reports the matches the active filter admits, newest first", async () => {
  const worker = pagedService("worker", [
    [line("worker", 40, "ready"), line("worker", 50, "ECONNREFUSED once more")],
    [line("worker", 10, "ECONNREFUSED first"), line("worker", 20, "quiet")],
  ]);

  const outcome = await runHistorySearch({
    scopes: [{ service: "worker", generation: 1, before: 10_000 }],
    filter: compileFilter(withTerm("ECONNREFUSED")),
    fetchPage: async () => worker.next(),
  });

  assert.deepEqual(outcome.matches.map((match) => match.offset), [50, 10]);
  assert.equal(outcome.stopReason, "start_of_logs");
  assert.equal(outcome.linesScanned, 4);
  assert.equal(outcome.bytesScanned, 2_000);
  assert.match(outcome.note, /back to the beginning of worker and found 2 matches/u);
});

test("an inactive filter is refused rather than answered with every line", async () => {
  let fetched = 0;
  const outcome = await runHistorySearch({
    scopes: [{ service: "worker", generation: 1, before: 100 }],
    filter: compileFilter(EMPTY_FILTER),
    fetchPage: async () => {
      fetched += 1;
      throw new Error("must not read");
    },
  });

  assert.equal(fetched, 0);
  assert.equal(outcome.stopReason, "no_query");
  assert.deepEqual(outcome.matches, []);
  assert.match(outcome.note, /Add a filter term/u);
});

test("a search stops at its match cap and says where it stopped", async () => {
  const pages = Array.from({ length: 10 }, (_unused, page) =>
    Array.from({ length: 5 }, (_ignored, index) =>
      line("worker", page * 100 + index, `boom ${page}-${index}`),
    ),
  );
  const worker = pagedService("worker", pages);

  const outcome = await runHistorySearch({
    scopes: [{ service: "worker", generation: 1, before: 10_000 }],
    filter: compileFilter(withTerm("boom")),
    fetchPage: async () => worker.next(),
    matchCap: 7,
  });

  assert.equal(outcome.stopReason, "match_cap");
  assert.equal(outcome.matches.length, 7);
  assert.equal(worker.calls(), 2, "it stops reading as soon as the cap is reached");
  assert.deepEqual(outcome.frontier, [
    { service: "worker", offset: 8_000, atStart: false },
  ]);
  assert.match(outcome.note, /Stopped at 7 matches/u);
  assert.match(outcome.note, /worker still has older output that was not read/u);
});

test("a search stops at its byte cap before reading another page", async () => {
  const worker = pagedService(
    "worker",
    Array.from({ length: 50 }, () => [line("worker", 1, "nothing here")]),
    4_000,
  );

  const outcome = await runHistorySearch({
    scopes: [{ service: "worker", generation: 1, before: 200_000 }],
    filter: compileFilter(withTerm("never")),
    fetchPage: async () => worker.next(),
    byteCap: 10_000,
  });

  assert.equal(outcome.stopReason, "byte_cap");
  assert.equal(outcome.bytesScanned, 12_000, "the cap is checked between pages");
  assert.equal(worker.calls(), 3);
  assert.deepEqual(outcome.matches, []);
  assert.match(outcome.note, /Stopped after scanning 11.7 KB/u);
});

test("a cancelled search stops between pages and reports how far it reached", async () => {
  const control = { aborted: false };
  const worker = pagedService(
    "worker",
    Array.from({ length: 50 }, () => [line("worker", 1, "still going")]),
  );

  const outcome = await runHistorySearch({
    scopes: [{ service: "worker", generation: 1, before: 50_000 }],
    filter: compileFilter(withTerm("still")),
    fetchPage: async () => {
      const page = worker.next();
      if (worker.calls() >= 3) control.aborted = true;
      return page;
    },
    signal: control,
  });

  assert.equal(outcome.stopReason, "canceled");
  assert.equal(worker.calls(), 3, "the page in flight is not abandoned mid-read");
  assert.equal(outcome.matches.length, 3);
  assert.match(outcome.note, /Canceled after scanning 2.9 KB/u);
});

test("progress is reported as each page lands, and once more when it ends", async () => {
  const worker = pagedService("worker", [
    [line("worker", 20, "hit one")],
    [line("worker", 10, "hit two")],
  ]);
  const progress: SearchProgress[] = [];

  await runHistorySearch({
    scopes: [{ service: "worker", generation: 1, before: 10_000 }],
    filter: compileFilter(withTerm("hit")),
    fetchPage: async () => worker.next(),
    onProgress: (update) => progress.push(update),
  });

  assert.deepEqual(
    progress.map((update) => [update.bytesScanned, update.matches, update.running]),
    [
      [1_000, 1, true],
      [2_000, 2, true],
      [2_000, 2, false],
    ],
  );
  assert.equal(progress.at(-1)?.service, null);
});

test("several services are scanned in turn, so results are not grouped by file", async () => {
  const pages = new Map([
    [
      "frontend",
      [[line("frontend", 90, "boom frontend")], [line("frontend", 10, "quiet")]],
    ],
    ["worker", [[line("worker", 80, "boom worker")], [line("worker", 5, "quiet")]]],
  ]);
  const readers = new Map(
    [...pages].map(([service, servicePages]) => [
      service,
      pagedService(service, servicePages),
    ]),
  );

  const outcome = await runHistorySearch({
    scopes: [
      { service: "frontend", generation: 1, before: 10_000 },
      { service: "worker", generation: 1, before: 10_000 },
    ],
    filter: compileFilter(withTerm("boom")),
    fetchPage: async (request) => {
      const reader = readers.get(request.service);
      assert.ok(reader, `unexpected service ${request.service}`);
      return reader.next();
    },
  });

  assert.deepEqual(
    outcome.matches.map((match) => match.service),
    ["frontend", "worker"],
  );
  assert.equal(outcome.stopReason, "start_of_logs");
  assert.deepEqual(
    outcome.frontier.map((entry) => entry.atStart),
    [true, true],
  );
});

test("a page that fails ends the search honestly instead of looking exhausted", async () => {
  const outcome = await runHistorySearch({
    scopes: [{ service: "worker", generation: 1, before: 500 }],
    filter: compileFilter(withTerm("anything")),
    fetchPage: async () => {
      throw new Error("the panel could not read that page");
    },
  });

  assert.equal(outcome.stopReason, "failed");
  assert.match(outcome.note, /could not be read/u);
});

test("a page that reads nothing ends that service rather than looping on it", async () => {
  let calls = 0;
  const outcome = await runHistorySearch({
    scopes: [{ service: "worker", generation: 1, before: 500 }],
    filter: compileFilter(withTerm("anything")),
    fetchPage: async () => {
      calls += 1;
      return {
        service: "worker",
        generation: 1,
        lines: [],
        startCursor: 500,
        atStart: false,
        bytesRead: 0,
      };
    },
  });

  assert.equal(calls, 1);
  assert.equal(outcome.stopReason, "start_of_logs");
});

test("the search asks the compiled filter, so severity and negation apply too", async () => {
  const worker = pagedService("worker", [
    [
      line("worker", 10, "ERROR boom in the poller"),
      line("worker", 20, "ERROR boom elsewhere"),
    ],
  ]);
  const spec: FilterSpec = {
    ...EMPTY_FILTER,
    terms: [createFilterTerm("boom"), createFilterTerm("poller", { negated: true })],
  };

  const outcome = await runHistorySearch({
    scopes: [{ service: "worker", generation: 1, before: 10_000 }],
    filter: compileFilter(spec),
    fetchPage: async () => worker.next(),
  });

  assert.deepEqual(outcome.matches.map((match) => match.offset), [20]);
});

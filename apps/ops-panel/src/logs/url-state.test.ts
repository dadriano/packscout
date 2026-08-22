import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ALL_SEVERITIES,
  createFilterTerm,
  EMPTY_FILTER,
  ERRORS_PRESET,
  type FilterTerm,
} from "./filter.ts";
import {
  decodeFilterTerm,
  decodePanelViewState,
  encodeFilterTerm,
  encodePanelViewState,
  MAX_ENCODED_TERMS,
  panelHistoryMode,
  UNDECODABLE_FILTER_NOTICE,
  type PanelViewState,
} from "./url-state.ts";

function term(text: string, overrides: Partial<Omit<FilterTerm, "id" | "text">> = {}): FilterTerm {
  return createFilterTerm(text, overrides);
}

/** Term identity is per-session; only the meaning has to survive a link. */
function meaning(terms: readonly FilterTerm[]) {
  return terms.map(({ text, negated, regex, caseSensitive }) => ({
    text,
    negated,
    regex,
    caseSensitive,
  }));
}

function roundTrip(state: PanelViewState): PanelViewState {
  const decoded = decodePanelViewState(encodePanelViewState(state));
  assert.equal(decoded.degraded, false);
  return decoded.state;
}

test("the default view needs no query string at all", () => {
  assert.equal(
    encodePanelViewState({ surface: "live", service: null, filter: EMPTY_FILTER }),
    "",
  );
  const decoded = decodePanelViewState("");
  assert.deepEqual(decoded.state.filter, EMPTY_FILTER);
  assert.equal(decoded.state.service, null);
  assert.equal(decoded.degraded, false);
});

test("surface, focus, and the whole filter survive a round trip", () => {
  const state: PanelViewState = {
    surface: "history",
    service: "worker",
    filter: {
      draft: term("quar"),
      terms: [
        term("import"),
        term("poller", { negated: true }),
        term("run \\d+", { regex: true, caseSensitive: true }),
      ],
      severities: ERRORS_PRESET,
    },
  };
  const restored = roundTrip(state);
  assert.equal(restored.surface, "history");
  assert.equal(restored.service, "worker");
  assert.deepEqual(meaning(restored.filter.terms), meaning(state.filter.terms));
  assert.deepEqual(meaning([restored.filter.draft as FilterTerm]), meaning([state.filter.draft as FilterTerm]));
  assert.deepEqual(restored.filter.severities, ERRORS_PRESET);
});

test("re-encoding a decoded link produces the same link", () => {
  const original: PanelViewState = {
    surface: "live",
    service: "frontend",
    filter: {
      draft: null,
      terms: [term("a,b:c"), term("d e", { negated: true, caseSensitive: true })],
      severities: ALL_SEVERITIES,
    },
  };
  const encoded = encodePanelViewState(original);
  assert.equal(encodePanelViewState(decodePanelViewState(encoded).state), encoded);
});

test("separators inside a term are encoded, not confused for structure", () => {
  const tricky = term("a,b:c%d+e f");
  const token = encodeFilterTerm(tricky);
  assert.equal(token.split(",").length, 1, "the comma is encoded away");
  assert.equal(decodeFilterTerm(token)?.text, tricky.text);
});

test("include and exclude do not use a character that means a space", () => {
  assert.ok(encodeFilterTerm(term("x")).startsWith("i:"));
  assert.ok(encodeFilterTerm(term("x", { negated: true })).startsWith("x:"));
  assert.ok(!encodeFilterTerm(term("x")).includes("+"));
});

test("an unrecognised surface falls back to the live view without complaint", () => {
  const decoded = decodePanelViewState("?view=telemetry");
  assert.equal(decoded.state.surface, "live");
  assert.equal(decoded.degraded, false);
});

test("an undecodable filter degrades to unfiltered, with a notice", () => {
  for (const search of [
    "?f=not-a-token",
    "?f=i:%zz",
    "?f=z:oops",
    "?f=irr:double",
    "?q=broken",
    "?sev=loud",
    "?sev=",
  ]) {
    const decoded = decodePanelViewState(search);
    assert.equal(decoded.degraded, true, `for ${search}`);
    assert.equal(decoded.notice, UNDECODABLE_FILTER_NOTICE);
    assert.deepEqual(decoded.state.filter, EMPTY_FILTER);
  }
});

test("focus survives a filter that did not", () => {
  const decoded = decodePanelViewState("?service=worker&f=garbage");
  assert.equal(decoded.degraded, true);
  assert.equal(decoded.state.service, "worker", "the part that parsed is still honoured");
});

test("a link with implausibly many chips is treated as corrupt", () => {
  const tokens = Array.from({ length: MAX_ENCODED_TERMS + 1 }, (_, index) =>
    encodeFilterTerm(term(`term${index}`)),
  ).join(",");
  assert.equal(decodePanelViewState(`?f=${tokens}`).degraded, true);
});

test("a term longer than the pattern bound is refused", () => {
  const token = encodeFilterTerm(term("a".repeat(201)));
  assert.equal(decodeFilterTerm(token), null);
  assert.equal(decodePanelViewState(`?f=${token}`).degraded, true);
});

test("an all-severities facet is left out of the link entirely", () => {
  const encoded = encodePanelViewState({
    surface: "live",
    service: null,
    filter: { draft: null, terms: [term("x")], severities: ALL_SEVERITIES },
  });
  assert.ok(!encoded.includes("sev"));
});

test("an empty draft is not written into the link", () => {
  const encoded = encodePanelViewState({
    surface: "live",
    service: null,
    filter: { draft: term(""), terms: [], severities: ALL_SEVERITIES },
  });
  assert.equal(encoded, "");
});

test("run state is never encoded", () => {
  const encoded = encodePanelViewState({
    surface: "live",
    service: "worker",
    filter: { draft: null, terms: [term("boom")], severities: ERRORS_PRESET },
  });
  for (const forbidden of ["pause", "paused", "scroll", "anchor", "expand"]) {
    assert.ok(!encoded.includes(forbidden), `${forbidden} must not be in the link`);
  }
});

test("changing what you look at pushes; refining the filter replaces", () => {
  const base: PanelViewState = { surface: "live", service: null, filter: EMPTY_FILTER };
  assert.equal(panelHistoryMode(base, { ...base, service: "worker" }), "push");
  assert.equal(panelHistoryMode(base, { ...base, surface: "history" }), "push");
  assert.equal(
    panelHistoryMode(base, {
      ...base,
      filter: { draft: term("q"), terms: [], severities: ALL_SEVERITIES },
    }),
    "replace",
  );
});

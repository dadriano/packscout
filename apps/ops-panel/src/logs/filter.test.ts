import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ALL_SEVERITIES,
  compileFilter,
  createFilterTerm,
  describeFilterTerm,
  DRAFT_TERM_ID,
  draftTermFlags,
  EMPTY_FILTER,
  ERRORS_PRESET,
  escapeLiteral,
  withDraftTerm,
  isAllSeverities,
  isErrorsPreset,
  severityFacetWith,
  type FilterSpec,
  type FilterTerm,
} from "./filter.ts";
import { clearRegexGuardCache } from "./regex-guard.ts";
import type { LogSeverity } from "./severity.ts";

function term(text: string, overrides: Partial<Omit<FilterTerm, "text">> = {}): FilterTerm {
  return {
    id: overrides.id ?? `t-${text}`,
    text,
    negated: overrides.negated ?? false,
    regex: overrides.regex ?? false,
    caseSensitive: overrides.caseSensitive ?? false,
  };
}

function spec(overrides: Partial<FilterSpec> = {}): FilterSpec {
  return {
    draft: overrides.draft ?? null,
    terms: overrides.terms ?? [],
    severities: overrides.severities ?? ALL_SEVERITIES,
  };
}

function line(text: string, severity: LogSeverity = "info") {
  return { text, severity };
}

test("an empty filter is inactive and admits everything", () => {
  const compiled = compileFilter(EMPTY_FILTER);
  assert.equal(compiled.active, false);
  assert.equal(compiled.test(line("anything at all", "debug")), true);
  assert.deepEqual(compiled.highlight("anything at all"), []);
});

test("every include must match; the draft counts as one", () => {
  const compiled = compileFilter(
    spec({ terms: [term("import")], draft: term("quarantine") }),
  );
  assert.equal(compiled.active, true);
  assert.equal(compiled.test(line("import moved a row to quarantine")), true);
  assert.equal(compiled.test(line("import finished cleanly")), false);
  assert.equal(compiled.test(line("quarantine drained")), false);
});

test("any exclude vetoes, whatever the includes said", () => {
  const compiled = compileFilter(
    spec({ terms: [term("import"), term("poller", { negated: true })] }),
  );
  assert.equal(compiled.test(line("import started")), true);
  assert.equal(compiled.test(line("import started by the poller")), false);
});

test("an exclude on its own narrows the stream", () => {
  const compiled = compileFilter(spec({ terms: [term("noise", { negated: true })] }));
  assert.equal(compiled.active, true);
  assert.equal(compiled.test(line("signal")), true);
  assert.equal(compiled.test(line("noise")), false);
});

test("case sensitivity is decided per term", () => {
  const insensitive = compileFilter(spec({ terms: [term("Quarantine")] }));
  assert.equal(insensitive.test(line("quarantine full")), true);

  const sensitive = compileFilter(
    spec({ terms: [term("Quarantine", { caseSensitive: true })] }),
  );
  assert.equal(sensitive.test(line("quarantine full")), false);
  assert.equal(sensitive.test(line("Quarantine full")), true);
});

test("literal terms are escaped, so punctuation is text and not syntax", () => {
  assert.equal(escapeLiteral("a.b(c)"), "a\\.b\\(c\\)");
  const compiled = compileFilter(spec({ terms: [term("pack.id")] }));
  assert.equal(compiled.test(line("pack.id=42")), true);
  assert.equal(compiled.test(line("packXid=42")), false, "the dot is not a wildcard");
});

test("a regex term is compiled as a pattern", () => {
  const compiled = compileFilter(spec({ terms: [term("run \\d+ of \\d+", { regex: true })] }));
  assert.equal(compiled.test(line("import run 3 of 12")), true);
  assert.equal(compiled.test(line("import run three of twelve")), false);
});

test("severity is judged independently of the terms", () => {
  const compiled = compileFilter(spec({ severities: ERRORS_PRESET }));
  assert.equal(compiled.active, true);
  assert.equal(compiled.test(line("boom", "error")), true);
  assert.equal(compiled.test(line("slow", "warn")), true);
  assert.equal(compiled.test(line("ready", "info")), false);
  assert.equal(compiled.test(line("frame", "unknown")), false);
});

test("severity and terms both have to be satisfied", () => {
  const compiled = compileFilter(
    spec({ terms: [term("provider")], severities: ERRORS_PRESET }),
  );
  assert.equal(compiled.test(line("provider handshake failed", "error")), true);
  assert.equal(compiled.test(line("provider handshake ok", "info")), false);
  assert.equal(compiled.test(line("worker died", "error")), false);
});

test("a term that will not compile is reported, and the rest keeps working", () => {
  clearRegexGuardCache();
  const compiled = compileFilter(
    spec({ terms: [term("import"), term("(unclosed", { id: "bad", regex: true })] }),
  );
  assert.deepEqual(
    compiled.errors.map((error) => error.termId),
    ["bad"],
  );
  assert.equal(compiled.test(line("import started")), true, "the good term still applies");
  assert.equal(compiled.test(line("nothing here")), false);
});

test("a catastrophic draft errors inline instead of blanking the pane", () => {
  clearRegexGuardCache();
  const compiled = compileFilter(
    spec({ terms: [term("import")], draft: term("(a+)+", { id: "draft", regex: true }) }),
  );
  assert.equal(compiled.errors.length, 1);
  assert.equal(compiled.errors[0]?.termId, "draft");
  assert.equal(compiled.test(line("import started")), true);
});

test("an empty term is not a filter", () => {
  const compiled = compileFilter(spec({ draft: term("") }));
  assert.equal(compiled.active, false);
  assert.equal(compiled.errors.length, 0);
});

test("highlighting covers the include terms and ignores the vetoes", () => {
  const compiled = compileFilter(
    spec({ terms: [term("import"), term("run", { negated: true })] }),
  );
  assert.deepEqual(compiled.highlight("import run import"), [
    { start: 0, end: 6 },
    { start: 11, end: 17 },
  ]);
});

test("a pattern that can match nothing does not stall the highlighter", () => {
  const compiled = compileFilter(spec({ terms: [term("x*", { regex: true })] }));
  assert.deepEqual(compiled.highlight("axxb"), [{ start: 1, end: 3 }]);
});

test("matchesText answers on terms alone, for group members", () => {
  const compiled = compileFilter(
    spec({ terms: [term("worker.ts")], severities: ERRORS_PRESET }),
  );
  assert.equal(compiled.matchesText("  at run (/app/worker.ts:14:9)"), true);
  assert.equal(compiled.test(line("  at run (/app/worker.ts:14:9)", "unknown")), false);
});

test("facet helpers describe the presets they build", () => {
  assert.equal(isAllSeverities(ALL_SEVERITIES), true);
  assert.equal(isErrorsPreset(ERRORS_PRESET), true);
  assert.equal(isErrorsPreset(ALL_SEVERITIES), false);
  const withoutDebug = severityFacetWith(ALL_SEVERITIES, "debug", false);
  assert.equal(withoutDebug.debug, false);
  assert.equal(isAllSeverities(withoutDebug), false);
  assert.equal(ALL_SEVERITIES.debug, true, "the source facet is untouched");
});

test("the draft keeps one identity while its text changes underneath it", () => {
  const typed = withDraftTerm(EMPTY_FILTER, "q", draftTermFlags(null));
  const extended = withDraftTerm(typed, "qu", draftTermFlags(typed.draft));
  assert.equal(typed.draft?.id, DRAFT_TERM_ID);
  assert.equal(extended.draft?.id, DRAFT_TERM_ID);
  assert.equal(extended.draft?.text, "qu");
});

test("the draft's flags survive editing its text, and clearing it drops it", () => {
  const patterned = withDraftTerm(EMPTY_FILTER, "run", {
    negated: true,
    regex: true,
    caseSensitive: true,
  });
  const retyped = withDraftTerm(patterned, "runs", draftTermFlags(patterned.draft));
  assert.deepEqual(draftTermFlags(retyped.draft), {
    negated: true,
    regex: true,
    caseSensitive: true,
  });
  assert.equal(withDraftTerm(retyped, "", draftTermFlags(retyped.draft)).draft, null);
  assert.deepEqual(draftTermFlags(null), {
    negated: false,
    regex: false,
    caseSensitive: false,
  });
});

test("terms are described for the operator, and given unique ids", () => {
  assert.equal(
    describeFilterTerm(term("boom", { negated: true, regex: true, caseSensitive: true })),
    'Exclude pattern "boom" (case-sensitive)',
  );
  assert.notEqual(createFilterTerm("a").id, createFilterTerm("a").id);
});

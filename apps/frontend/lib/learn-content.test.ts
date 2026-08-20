import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXPECTED_VALUE_METRIC_KEYS,
  findLearnGuide,
  formatReadingTime,
  getLearnMetricDefinitions,
  LEARN_GUIDE_SLUGS,
  LEARN_GUIDES,
  PACKSCOUT_EV_METHOD,
} from "./learn-content";
import {
  EXPECTED_VALUE_ARTICLE_HREF,
  getGlossaryDefinition,
  METRIC_TRUST_COPY,
} from "./metric-vocabulary";

const INTERNAL_CODE_PATTERN = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;

test("every declared guide slug is published exactly once, in declared order", () => {
  // LEARN_GUIDE_SLUGS is the routing contract: /learn/[slug] is generated from
  // it, so a slug without a guide is a 404 and a guide without a slug is
  // unreachable. Comparing the two lists proves both directions.
  assert.deepEqual(
    LEARN_GUIDES.map((guide) => guide.slug),
    [...LEARN_GUIDE_SLUGS],
  );
});

test("guides carry everything the index and detail pages render", () => {
  for (const guide of LEARN_GUIDES) {
    assert.ok(guide.title.trim().length > 0, `${guide.slug} needs a title`);
    assert.ok(
      guide.description.trim().length > 0,
      `${guide.slug} needs a description`,
    );
    assert.ok(
      Number.isFinite(guide.readingTimeMinutes) &&
        guide.readingTimeMinutes > 0,
      `${guide.slug} needs a positive reading time`,
    );
    assert.ok(
      guide.sections.length > 0,
      `${guide.slug} needs at least one section`,
    );
    assert.ok(
      guide.relatedLink.label.trim().length > 0,
      `${guide.slug} needs a related link label`,
    );
    assert.ok(
      ["/", "/packs"].includes(guide.relatedLink.href),
      `${guide.slug} must link back into the product`,
    );
    for (const section of guide.sections) {
      assert.ok(
        section.heading.trim().length > 0,
        `${guide.slug} has a section without a heading`,
      );
    }
  }
});

test("guide lookup round-trips every slug and rejects unknown ones", () => {
  for (const slug of LEARN_GUIDE_SLUGS) {
    assert.equal(findLearnGuide(slug)?.slug, slug);
  }
  assert.equal(findLearnGuide("not-a-guide"), undefined);
  assert.equal(findLearnGuide(""), undefined);
});

test("reading time is rendered in the reader's units", () => {
  assert.equal(formatReadingTime(5), "5 min read");
  assert.equal(formatReadingTime(1), "1 min read");
});

test("Expected Value education reuses the shared Dashboard vocabulary", () => {
  // The point of this contract is that Learn and the Dashboard cannot describe
  // the same metric differently. Resolving through the glossary proves reuse
  // without restating the wording here, which would just be a second copy to
  // keep in sync.
  const definitions = getLearnMetricDefinitions(EXPECTED_VALUE_METRIC_KEYS);
  assert.equal(definitions.length, EXPECTED_VALUE_METRIC_KEYS.length);

  definitions.forEach((definition, index) => {
    const key = EXPECTED_VALUE_METRIC_KEYS[index];
    assert.equal(definition.key, key);
    assert.deepEqual(definition, getGlossaryDefinition(key));
  });
});

test("the Expected Value guide carries the canonical trust language", () => {
  const guide = findLearnGuide("expected-value");
  assert.ok(guide);

  const text = JSON.stringify(guide);
  for (const explanation of [
    METRIC_TRUST_COPY.longRunExplanation,
    METRIC_TRUST_COPY.sourceExplanation,
    METRIC_TRUST_COPY.confidenceExplanation,
    METRIC_TRUST_COPY.unavailableExplanation,
  ]) {
    assert.ok(
      text.includes(explanation),
      "the guide must quote the shared trust copy verbatim",
    );
  }
});

test("the red flags guide gives readers a checklist and a way back", () => {
  const guide = findLearnGuide("repack-red-flags");
  assert.ok(guide);
  assert.equal(guide.relatedLink.href, "/packs");

  const checklist = guide.sections.flatMap(
    (section) => section.checklist ?? [],
  );
  assert.ok(checklist.length > 0, "the guide needs a checklist");
  for (const item of checklist) {
    assert.ok(item.title.trim().length > 0);
    assert.ok(item.body.trim().length > 0);
  }
});

test("the method summary is complete and links to its explainer", () => {
  assert.ok(PACKSCOUT_EV_METHOD.title.trim().length > 0);
  assert.ok(PACKSCOUT_EV_METHOD.summary.trim().length > 0);
  assert.ok(PACKSCOUT_EV_METHOD.points.length > 0);
  assert.ok(
    PACKSCOUT_EV_METHOD.disclaimer.trim().length > 0,
    "the method must carry its disclaimer",
  );
  assert.equal(PACKSCOUT_EV_METHOD.learnMoreHref, EXPECTED_VALUE_ARTICLE_HREF);

  for (const point of PACKSCOUT_EV_METHOD.points) {
    assert.ok(point.title.trim().length > 0);
    assert.ok(point.body.trim().length > 0);
    assert.doesNotMatch(
      point.body,
      INTERNAL_CODE_PATTERN,
      `${point.title} leaks an internal code`,
    );
  }
});

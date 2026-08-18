import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXPECTED_VALUE_METRIC_KEYS,
  findLearnGuide,
  formatReadingTime,
  getLearnMetricDefinitions,
  LEARN_GUIDES,
  PACKSCOUT_EV_METHOD,
} from "./learn-content";
import { METRIC_TRUST_COPY } from "./metric-vocabulary";

test("keeps exactly three version-controlled guides in the approved order", () => {
  assert.deepEqual(
    LEARN_GUIDES.map(({ slug, title, description }) => ({
      slug,
      title,
      description,
    })),
    [
      {
        slug: "what-is-a-repack",
        title: "What is a repack?",
        description:
          "How randomized collectible packs, chase items, and buyback offers work.",
      },
      {
        slug: "expected-value",
        title: "What is Expected Value (EV)?",
        description:
          "How vendor-reported EV, PackScout EV, and confidence support informed comparisons.",
      },
      {
        slug: "repack-red-flags",
        title: "Repack Red Flags",
        description: "Evidence to check before opening or buying a pack.",
      },
    ],
  );
  assert.ok(LEARN_GUIDES.every(({ readingTimeMinutes }) => readingTimeMinutes > 0));
  assert.equal(formatReadingTime(5), "5 min read");
});

test("uses the shared Dashboard vocabulary for Expected Value education", () => {
  assert.deepEqual(
    getLearnMetricDefinitions(EXPECTED_VALUE_METRIC_KEYS).map(
      ({ key, label, definition }) => ({ key, label, definition }),
    ),
    [
      {
        key: "grossEv",
        label: "Gross EV",
        definition:
          "PackScout’s estimated value of contents before fees and shipping",
      },
      {
        key: "evDollars",
        label: "EV $",
        definition: "PackScout Gross EV minus Repack Price",
      },
      {
        key: "evPercent",
        label: "EV %",
        definition:
          "The percentage PackScout Gross EV is above or below Repack Price",
      },
      {
        key: "buybackPercent",
        label: "Buyback %",
        definition:
          "Vendor-supported buyback coverage relative to Repack Price, reported directly or derived by PackScout from documented terms",
      },
      {
        key: "topChase",
        label: "Top Chase",
        definition:
          "The highest-valued eligible related collectible currently identified",
      },
    ],
  );

  const evGuide = findLearnGuide("expected-value");
  assert.ok(evGuide);
  const evCopy = JSON.stringify(evGuide);
  assert.match(evCopy, /long-run estimate/i);
  assert.ok(evCopy.includes(METRIC_TRUST_COPY.longRunExplanation));
  assert.ok(evCopy.includes(METRIC_TRUST_COPY.sourceExplanation));
  assert.ok(evCopy.includes(METRIC_TRUST_COPY.confidenceExplanation));
  assert.ok(evCopy.includes(METRIC_TRUST_COPY.unavailableExplanation));
  assert.equal(evGuide.relatedLink.href, "/");
});

test("keeps repack and red-flag guidance evidence-based and catalog-linked", () => {
  assert.equal(findLearnGuide("what-is-a-repack")?.relatedLink.href, "/packs");
  const redFlags = findLearnGuide("repack-red-flags");
  assert.ok(redFlags);
  assert.equal(redFlags.relatedLink.href, "/packs");
  assert.deepEqual(
    redFlags.sections.flatMap((section) =>
      section.checklist?.map(({ title }) => title) ?? [],
    ),
    [
      "Missing or incomplete odds",
      "Unclear inventory",
      "Unsupported values",
      "Stale listings",
      "Pressure-driven claims",
    ],
  );
  assert.equal(findLearnGuide("not-a-guide"), undefined);
});

test("documents the PackScout EV method in layman's terms on the learn index", () => {
  assert.equal(PACKSCOUT_EV_METHOD.title, "PackScout method");
  assert.equal(PACKSCOUT_EV_METHOD.points.length, 6);
  assert.match(PACKSCOUT_EV_METHOD.summary, /Heat/i);
  assert.match(
    PACKSCOUT_EV_METHOD.points[1]?.body ?? "",
    /Gross EV/i,
  );
  assert.match(
    PACKSCOUT_EV_METHOD.points[0]?.body ?? "",
    /never blended/i,
  );
  assert.match(
    PACKSCOUT_EV_METHOD.points[3]?.body ?? "",
    /timing signal comparing recent activity/i,
  );
  assert.match(
    PACKSCOUT_EV_METHOD.points[3]?.body ?? "",
    /never replaces PackScout EV/i,
  );
  assert.match(PACKSCOUT_EV_METHOD.disclaimer, /negative-EV/i);
  assert.equal(PACKSCOUT_EV_METHOD.learnMoreHref, "/learn/expected-value");
});

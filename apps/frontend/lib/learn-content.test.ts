import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXPECTED_VALUE_METRIC_KEYS,
  findLearnGuide,
  formatReadingTime,
  getLearnMetricDefinitions,
  LEARN_GUIDES,
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
          "How PackScout estimates long-run value and why one result can differ.",
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
        definition: "PackScout Gross EV minus Pack Price",
      },
      {
        key: "evPercent",
        label: "EV %",
        definition:
          "The percentage PackScout Gross EV is above or below Pack Price",
      },
      {
        key: "buybackPercent",
        label: "Buyback %",
        definition:
          "Provider-supported buyback coverage relative to Pack Price, supplied directly or derived from documented provider terms",
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

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  presentConfidenceLimitations,
  PUBLIC_CONFIDENCE_LIMITATION_COPY,
  type PackScoutConfidenceLimitationCode,
} from "./confidence-limitations";

const everyLimitationCode: readonly PackScoutConfidenceLimitationCode[] = [
  "closed_range_midpoint",
  "platform_published_odds",
  "source_age_over_15_through_30_minutes",
  "source_age_over_30_through_60_minutes",
  "source_age_over_60_minutes",
  "latest_calculation_unavailable",
];

test("maps the complete displayed-confidence limitation vocabulary to copy", () => {
  const copy = presentConfidenceLimitations(everyLimitationCode);

  assert.equal(copy.length, everyLimitationCode.length);
  assert.ok(copy.every((value) => /[.!?]$/.test(value)));
  assert.deepEqual(
    Object.keys(PUBLIC_CONFIDENCE_LIMITATION_COPY).sort(),
    [...everyLimitationCode].sort(),
  );
  for (const code of everyLimitationCode) {
    assert.doesNotMatch(copy.join(" "), new RegExp(code));
  }
});

test("limitation copy describes evidence, never profit or predicted outcomes", () => {
  for (const copy of Object.values(PUBLIC_CONFIDENCE_LIMITATION_COPY)) {
    assert.doesNotMatch(copy, /profit|return|win|positive/i);
  }
  assert.match(
    PUBLIC_CONFIDENCE_LIMITATION_COPY.platform_published_odds,
    /Published odds used/,
  );
  assert.match(
    PUBLIC_CONFIDENCE_LIMITATION_COPY.closed_range_midpoint,
    /Midpoint value ranges/,
  );
});

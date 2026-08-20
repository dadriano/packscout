import assert from "node:assert/strict";
import { test } from "node:test";
import { findLearnGuide, LEARN_GUIDES } from "./learn-routes";

test("Learn exposes the four source-backed stable article destinations", () => {
  assert.deepEqual(
    LEARN_GUIDES.map(({ slug }) => slug),
    [
      "packscout-methodology",
      "what-is-a-repack",
      "expected-value",
      "repack-red-flags",
    ],
  );
  assert.equal(
    findLearnGuide("expected-value")?.title,
    "What Is EV (Expected Value): A Complete Guide, With a Deep Dive Into Repack EV",
  );
  assert.equal(
    findLearnGuide("packscout-methodology")?.title,
    "PackScout Methodology",
  );
  assert.equal(findLearnGuide("unknown"), undefined);
});

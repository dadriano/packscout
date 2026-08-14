import assert from "node:assert/strict";
import { test } from "node:test";
import { findLearnGuide, LEARN_GUIDES } from "./learn-routes";

test("Learn exposes exactly the three approved stable article destinations", () => {
  assert.deepEqual(
    LEARN_GUIDES.map(({ slug }) => slug),
    ["what-is-a-repack", "expected-value", "repack-red-flags"],
  );
  assert.equal(
    findLearnGuide("expected-value")?.title,
    "What is Expected Value (EV)?",
  );
  assert.equal(findLearnGuide("unknown"), undefined);
});

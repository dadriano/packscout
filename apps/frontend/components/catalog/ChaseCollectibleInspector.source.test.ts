import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(
  new URL("./ChaseCollectibleInspector.client.tsx", import.meta.url),
  "utf8",
);

test("chase inspector loads packs through the gated collectible-repacks route", () => {
  assert.match(
    source,
    /fetch\(\s*`\/api\/collectibles\/\$\{encodeURIComponent\(request\.publicCollectibleId\)\}\/repacks`/,
  );
  assert.match(source, /credentials: "same-origin"/);
  assert.match(source, /parseFindRepacksByDesiredCollectibleV3Result/);
  assert.match(source, /dialog\.showModal\(\)/);
  assert.match(source, /Packs that include this chase/);
});

test("changing collectible remounts loading state and cancels the previous request", () => {
  assert.match(source, /<ChaseCollectibleInspector\s+key=\{request\.publicCollectibleId\}/);
  assert.match(source, /useState<InspectorLoadState>\(\{ status: "loading" \}\)/);
  assert.doesNotMatch(source, /setLoad\(\{ status: "loading" \}\)/);
  assert.match(source, /return \(\) => controller\.abort\(\)/);
  assert.match(source, /if \(controller\.signal\.aborted\) return/);
});

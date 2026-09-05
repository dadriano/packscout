import assert from "node:assert/strict";
import { test } from "node:test";
import { createPackCatalogV1Fixture } from "@packscout/contracts/test-fixtures/pack-catalog-v1";
import { assemblePublicProfileSnapshot } from "./public-profile-snapshot-assembler.ts";

test("profile assembly bounds descriptors before getters, proxies, cycles or oversized strings can execute", async () => {
  let invoked = false;
  const accessor = Object.defineProperty({}, "identity", { enumerable: true, get() { invoked = true; throw new Error("private"); } });
  const proxy = new Proxy({}, { ownKeys() { invoked = true; throw new Error("private"); } });
  const cycle: { self?: unknown } = {}; cycle.self = cycle;
  for (const input of [accessor, proxy, cycle]) {
    await assert.rejects(assemblePublicProfileSnapshot(input as never), { code: "SHARED_INPUT_INVALID" });
  }
  await assert.rejects(assemblePublicProfileSnapshot({ displayName: "x".repeat(1_500_001) } as never), { code: "SHARED_LIMIT_EXCEEDED" });
  assert.equal(invoked, false);
});
test("profile assembly rejects nested redirect credentials in the final public payload", async () => {
  const fixture = await createPackCatalogV1Fixture(new Uint8Array(32).fill(7));
  const profile = structuredClone(fixture.provider.profile);
  for (const target of ["?next=https%3A%2F%2Fapi.example%2Fcb%3Faccess_token%3Dprivate-marker",
    "?next=%5C%5Cuser%3Aprivate-marker%40api.example%2Fcb",
    "?next=ht%0Atps%3A%2F%2Fuser%3Aprivate-marker%40api.example%2Fcb",
    "#ht%09tps%3A%2F%2Fuser%3Aprivate-marker%40api.example%2Fcb",
    "?next=%2Fcb%3F%2561ccess_token%3Dprivate-marker",
    "?next=https%253A%252F%252Fexample.com%252Fcb%253Faccess_token%253Dprivate-marker"]) {
    profile.promotions = [{ promotionId: "offer", label: "Offer", copy: "A public offer", url: `https://example.com/${target}` }];
    await assert.rejects(assemblePublicProfileSnapshot(profile), TypeError);
  }
});
test("profile assembly preserves benign relative and multiply encoded redirect URLs", async () => {
  const fixture = await createPackCatalogV1Fixture(new Uint8Array(32).fill(7));
  for (const target of ["?next=%2Fcb%3F%2563ampaign%3Dpack",
    "?next=https%253A%252F%252Fexample.com%252Fcb%253Fcampaign%253Dpack",
    `#${encodeURIComponent("/cb?caption=Fish%26Actor&label=Fish%2BActor&width=100%")}`]) {
    const profile = structuredClone(fixture.provider.profile), url = `https://example.com/${target}`;
    profile.promotions = [{ promotionId: "offer", label: "Offer", copy: "A public offer", url }];
    const result = await assemblePublicProfileSnapshot(profile);
    assert.equal("promotions" in result.profile && result.profile.promotions[0]?.url, url);
  }
});

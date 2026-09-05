import assert from "node:assert/strict";
import { test } from "node:test";
import { packCatalogCanonicalJson } from "@packscout/contracts";
import { createPackCatalogV1Fixture } from "@packscout/contracts/test-fixtures/pack-catalog-v1";
import { assemblePublicProfileSnapshot } from "./public-profile-snapshot-assembler.ts";

test("profile assembly normalizes decomposed public text before canonical hashing", async suite => {
  const fixture = await createPackCatalogV1Fixture(new Uint8Array(32).fill(7));
  for (const existing of [fixture.provider, fixture.collectibles[0]!]) {
    const result = await assemblePublicProfileSnapshot(existing.profile);
    assert.deepEqual(result.profile, existing.profile, "already canonical profile hashes must remain unchanged");
    assert.deepEqual(result.batch, existing.batch);
    assert.deepEqual(result.descriptor, existing.descriptor);
  }
  const provider = (text: string) => ({ ...structuredClone(fixture.provider.profile), displayName: text,
    identity: { ...fixture.provider.profile.identity, sourceIdentity: `profile:${text}` },
    brandAssets: [{ kind: "logo" as const, url: "https://example.com/logo.svg", alt: text }],
    promotions: [{ promotionId: "offer", label: text, copy: `Discover ${text}`, url: `https://example.com/${text}` }],
  });
  const collectible = (text: string) => ({ ...structuredClone(fixture.collectibles[0]!.profile), displayName: text,
    identity: { ...fixture.collectibles[0]!.profile.identity, sourceIdentity: `profile:${text}` },
    category: { ...fixture.collectibles[0]!.profile.category, label: text }, aliases: ["Zebra", `${text} card`],
    imageUrl: `https://example.com/${text}.png`,
  });
  for (const [kind, create] of [["provider", provider], ["collectible", collectible]] as const) {
    await suite.test(kind, async () => {
      const raw = create("Cafe\u0301"), before = structuredClone(raw);
      const result = await assemblePublicProfileSnapshot(raw);
      const canonical = await assemblePublicProfileSnapshot(create("Caf\u00e9"));
      assert.equal(result.profile.displayName, "Caf\u00e9");
      assert.deepEqual(result, canonical, "equivalent text must produce identical profiles, batches, descriptors and hashes");
      assert.equal(packCatalogCanonicalJson(result), packCatalogCanonicalJson(canonical));
      assert.deepEqual(raw, before, "assembly must not mutate captured source text");
    });
  }
  const imageAbsent = await assemblePublicProfileSnapshot({ ...fixture.collectibles[0]!.profile, imageUrl: null });
  assert.ok("imageUrl" in imageAbsent.profile);
  assert.equal(imageAbsent.profile.imageUrl, null);
  const promotions = await assemblePublicProfileSnapshot({ ...fixture.provider.profile, promotions: [
    { promotionId: "first", label: "First", copy: "First offer", url: "https://example.com/Cafe\u0301" },
    { promotionId: "second", label: "Second", copy: "Second offer", url: "https://example.com/Caf\u00e9" },
  ] });
  assert.ok("promotions" in promotions.profile);
  assert.deepEqual(promotions.profile.promotions.map(({ promotionId, url }) => ({ promotionId, url })), [
    { promotionId: "first", url: "https://example.com/Caf\u00e9" }, { promotionId: "second", url: "https://example.com/Caf\u00e9" },
  ], "URL normalization must not collapse distinct promotion identities");
});

test("profile normalization retains raw credential, unknown-field and collision refusals", async () => {
  const fixture = await createPackCatalogV1Fixture(new Uint8Array(32).fill(7));
  for (const text of ["Cafe\u0301 password: private-marker", 'Cafe\u0301 {"\\u0070assword":"private-marker"}']) {
    await assert.rejects(assemblePublicProfileSnapshot({ ...fixture.provider.profile, displayName: text }),
      /PUBLIC_CATALOG_PROTECTED_TEXT|protected field/u);
  }
  await assert.rejects(assemblePublicProfileSnapshot({ ...fixture.provider.profile, displayName: "Cafe\u0301",
    rawProviderPayload: "private-marker" } as never), /protected field/u);
  await assert.rejects(assemblePublicProfileSnapshot({ ...fixture.provider.profile, displayName: "Cafe\u0301",
    unexpected: "public" } as never), { name: "ZodError" });
  await assert.rejects(assemblePublicProfileSnapshot({ ...fixture.collectibles[0]!.profile,
    searchText: "Cafe\u0301 password: private-marker" }), /PUBLIC_CATALOG_PROTECTED_TEXT/u);
  await assert.rejects(assemblePublicProfileSnapshot({ ...fixture.collectibles[0]!.profile,
    displayName: "Authorization:", aliases: ["Bearer abc123"] }), /PUBLIC_CATALOG_PROTECTED_TEXT/u);
  for (const url of ["https://example.com/Cafe\u0301?access_token=private-marker",
    "https://alice:private-marker@example.com/Cafe\u0301", "https://127.1/Cafe\u0301"]) {
    await assert.rejects(assemblePublicProfileSnapshot({ ...fixture.provider.profile,
      promotions: [{ promotionId: "offer", label: "Offer", copy: "Offer", url }] }), TypeError);
    await assert.rejects(assemblePublicProfileSnapshot({ ...fixture.collectibles[0]!.profile, imageUrl: url }), TypeError);
  }
  await assert.rejects(assemblePublicProfileSnapshot({ ...fixture.collectibles[0]!.profile,
    aliases: ["Caf\u00e9", "Cafe\u0301"] }), { name: "ZodError" });
  await assert.rejects(assemblePublicProfileSnapshot({ ...fixture.provider.profile, brandAssets: [
    { kind: "logo", url: "https://example.com/Caf\u00e9.svg", alt: "First" },
    { kind: "logo", url: "https://example.com/Cafe\u0301.svg", alt: "Second" },
  ] }), { name: "ZodError" });
});

test("profile assembly preserves numeric captions but refuses private hosts and path credentials", async () => {
  const fixture = await createPackCatalogV1Fixture(new Uint8Array(32).fill(7));
  const profile = structuredClone(fixture.provider.profile);
  profile.displayName = "[1,000 cards] Premium";
  assert.equal((await assemblePublicProfileSnapshot(profile)).profile.displayName, profile.displayName);
  for (const url of ["https://127.1/packs", "https://[::1]/packs", "https://localhost/packs",
    "https://example.com/access_token/private-marker", "https://example.com/callback/code/private-marker",
    "https:/access_token/private-marker", "https:password/private-marker"]) {
    profile.promotions = [{ promotionId: "offer", label: "Offer", copy: "A public offer", url }];
    await assert.rejects(assemblePublicProfileSnapshot(profile), TypeError);
  }
});

test("profile JSON display text preserves public label values without exposing protected fields", async () => {
  const fixture = await createPackCatalogV1Fixture(new Uint8Array(32).fill(7));
  for (const text of ['{"caption":"Host: Public Speaker"}', '{"caption":"Actor: Keanu Reeves"}',
    '["Host: Public Speaker","Actor: J. K. Simmons"]', '"Host: Public Speaker"',
    '{"caption":"first"} {"caption":"second"}', 'Documentation {"caption":"public"} edition']) {
    const profile = structuredClone(fixture.provider.profile);
    profile.displayName = text;
    const result = await assemblePublicProfileSnapshot(profile);
    assert.equal(result.profile.displayName, text);
  }
  for (const text of ['{"caption":"Host: db.internal:5432"}', '{"\\u0061ccount":"internal-123"}',
    '{"caption":"safe"} {"\\u0068ost":"db.internal"}', 'Documentation {"\\u0070assword":"private-marker"}']) {
    const profile = structuredClone(fixture.provider.profile);
    profile.displayName = text;
    await assert.rejects(assemblePublicProfileSnapshot(profile), TypeError);
  }
});

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
test("profile ordinary display and promotion text rejects embedded HTTP userinfo", async () => {
  const fixture = await createPackCatalogV1Fixture(new Uint8Array(32).fill(7));
  for (const target of ["//alice:correcthorsebattery@example.com", "\\\\alice:correcthorsebattery@example.com",
    "https://alice:correcthorsebattery@example.com", "HTTP://alice@example.com",
    "ｈｔｔｐｓ：／／alice:correcthorsebattery＠example.com", "ht\nt\rps://alice:correcthorsebattery@example.com",
    "ht\ttps:\\\\alice:correcthorsebattery@example.com", "https:/alice:correcthorsebattery@example.com",
    "https:\t/\n/alice:correcthorsebattery@example.com",
    "https://alice:pri\tvate-marker@example.com", "https://ali\nce:private-marker@example.com",
    "https:alice:correcthorsebattery@example.com", "https:////alice:correcthorsebattery@example.com",
    'https://alice:pa"ss@example.com', "https://alice:pa'ss@example.com", "https://alice:pa<ss>word@example.com"]) {
    for (const field of ["displayName", "copy"] as const) {
      const profile = structuredClone(fixture.provider.profile), text = `Visit ${target} for details.`;
      if (field === "displayName") profile.displayName = text;
      else profile.promotions = [{ promotionId: "offer", label: "Offer", copy: text, url: "https://example.com/offer" }];
      await assert.rejects(assemblePublicProfileSnapshot(profile), TypeError);
    }
  }
  for (const target of ["https://example.com", "https://example.com/path/alice@example.com",
    "https://example.com/?contact=alice@example.com", "ht\ttps:\\\\example.com/path/alice@example.com", '"https://example.com"',
    "https://example.com\n Contact support@example.com", "https://example.com\t Contact support@example.com",
    "https://example.com support@example.com"]) {
    const profile = structuredClone(fixture.provider.profile);
    profile.promotions = [{ promotionId: "offer", label: "Offer", copy: `Visit ${target} then email alice@example.com.`, url: "https://example.com/offer" }];
    const result = await assemblePublicProfileSnapshot(profile);
    assert.equal("promotions" in result.profile && result.profile.promotions[0]?.copy, profile.promotions[0]?.copy);
  }
  for (const separator of ["\n", "\t", "\r\n"]) {
    // These earlier prose cases parse as userinfo after WHATWG removes controls; fail closed.
    const profile = structuredClone(fixture.provider.profile);
    profile.promotions = [{ promotionId: "offer", label: "Offer", copy: `Visit https://example.com${separator}support@example.com`, url: "https://example.com/offer" }];
    await assert.rejects(assemblePublicProfileSnapshot(profile), TypeError);
  }
});
test("profile URLs fail closed on malformed nested authorities and preserve benign ports", async () => {
  const fixture = await createPackCatalogV1Fixture(new Uint8Array(32).fill(7));
  for (const [target, valid] of [["https://api.example:invalid/cb?%61ccess_token=private-marker", false],
    ["https://api.example:65536/cb#sig=private-marker", false], ["https://api.example:443/cb?campaign=pack", true]] as const) {
    for (const prefix of ["?next=", "#next=", "#"]) {
      const profile = structuredClone(fixture.provider.profile), url = `https://example.com/${prefix}${encodeURIComponent(encodeURIComponent(target))}`;
      profile.promotions = [{ promotionId: "offer", label: "Offer", copy: "A public offer", url }];
      if (!valid) await assert.rejects(assemblePublicProfileSnapshot(profile), TypeError);
      else {
        const result = await assemblePublicProfileSnapshot(profile);
        assert.equal("promotions" in result.profile && result.profile.promotions[0]?.url, url);
      }
    }
  }
});

test("profile display and promotions cannot publish generic userinfo, embedded parameters or form credentials", async () => {
  const fixture = await createPackCatalogV1Fixture(new Uint8Array(32).fill(7));
  for (const target of ["amqps://alice:private-marker@internal.example/path", "ftp:alice:private-marker@internal.example/path",
    "wss:/alice:private-marker@internal.example/path", "https://example.com/?%73ig=private-marker",
    "https://example.com/#authorization_code=private-marker", "https://example.com/?data=sig%3Dprivate-marker"]) {
    for (const field of ["displayName", "copy"] as const) {
      const profile = structuredClone(fixture.provider.profile), text = `Visit ${target} for details.`;
      if (field === "displayName") profile.displayName = text;
      else profile.promotions = [{ promotionId: "offer", label: "Offer", copy: text, url: "https://example.com/offer" }];
      await assert.rejects(assemblePublicProfileSnapshot(profile), TypeError);
    }
  }
});

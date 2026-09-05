import assert from "node:assert/strict";
import { test } from "node:test";
import { providerPackListingUrl } from "./provider-pack-listing-url.ts";

test("reviewed provider identities resolve directly to their pack pages", () => {
  assert.equal(providerPackListingUrl("phygitals", "5050-pack-bssaa3"),
    "https://www.phygitals.com/repacks/5050-pack-bssaa3");
  assert.equal(providerPackListingUrl("phygitals", "gold--silver-79hnpx"),
    "https://www.phygitals.com/repacks/gold--silver-79hnpx");
  assert.equal(providerPackListingUrl("collector_crypt", "pokemon_1000"),
    "https://gacha.collectorcrypt.com/gacha/pokemon_1000");
  assert.equal(providerPackListingUrl("collector_crypt", "e9wb4_nimbus_80"),
    "https://gacha.collectorcrypt.com/gacha/e9wb4_nimbus_80");
  for (const provider of ["courtyard", "clutchpacks", "unknown", "__proto__"]) {
    assert.equal(providerPackListingUrl(provider, "pokemon_1000"), null);
  }
});

test("pack routes reject paths, queries, encoding and malformed identities", () => {
  for (const provider of ["phygitals", "collector_crypt"]) {
    for (const id of ["", "../evil", "//evil.test", "https://evil.test", "a/b",
      "a?redirect=evil", "a#fragment", "a%2fb", "a\\b", "a\n", " a", "a ",
      "UPPERCASE", "a@evil.test", "-a", "a-", "a".repeat(201)]) {
      assert.equal(providerPackListingUrl(provider, id), null, `${provider}: ${id}`);
    }
  }
  assert.equal(providerPackListingUrl("phygitals", "pokemon_1000"), null);
});

test("legacy numeric Phygitals identities link through their verified slugs or not at all", () => {
  assert.equal(providerPackListingUrl("phygitals", "13"),
    "https://www.phygitals.com/repacks/rookie-pack");
  assert.equal(providerPackListingUrl("phygitals", "41"),
    "https://www.phygitals.com/repacks/one-piece-mythic-pack");
  // A numeric id without a recorded slug would only ever be a 404.
  assert.equal(providerPackListingUrl("phygitals", "999"), null);
  assert.equal(providerPackListingUrl("phygitals", "013"), null);
  // Slug identities are unaffected, and no other provider has legacy ids.
  assert.equal(providerPackListingUrl("phygitals", "1-mythic-ewhv3o"),
    "https://www.phygitals.com/repacks/1-mythic-ewhv3o");
  assert.equal(providerPackListingUrl("collector_crypt", "1000"),
    "https://gacha.collectorcrypt.com/gacha/1000");
});

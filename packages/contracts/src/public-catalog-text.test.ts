import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPublicCatalogText, assertPublicCatalogUrl } from "./public-catalog-text.ts";

test("public catalog text rejects normalized and inline credential fragments", () => {
  for (const value of ["prefix Bearer 12345678901234567890 suffix", "ｂｅａｒｅｒ 12345678901234567890", "api_key=example",
    "postgresql://internal", "redis://internal", "-----BEGIN RSA PRIVATE KEY-----", "password:example"]) {
    assert.throws(() => assertPublicCatalogText(value), TypeError);
  }
  assert.doesNotThrow(() => assertPublicCatalogText("Card bearer collection"));
});
test("public URL policy scans decoded query and fragment keys and values", () => {
  for (const suffix of ["?api%5fkey=example", "#sig=example", "#route?access_token=example", "?q=Bearer+12345678901234567890",
    "#q=postgresql%3A%2F%2Finternal", "?ＸＡｍｚＳｉｇｎａｔｕｒｅ=example"]) {
    assert.throws(() => assertPublicCatalogUrl(`https://example.com/${suffix}`), TypeError);
  }
  assert.throws(() => assertPublicCatalogUrl("https://user:password@example.com"), TypeError);
  assert.doesNotThrow(() => assertPublicCatalogUrl("https://example.com/?campaign=pack#card"));
});
test("nested redirect URLs and protocol-relative fragment targets obey bounded public URL policy", () => {
  for (const target of ["https://example.com/cb?access_token=private-marker", "//example.com/cb#sig=private-marker",
    "https://example.com/cb?next=" + encodeURIComponent("https://example.com/?password=private-marker")]) {
    for (const separator of ["?", "#"]) assert.throws(() => assertPublicCatalogUrl(`https://example.com/${separator}next=${encodeURIComponent(target)}`), TypeError);
  }
  assert.doesNotThrow(() => assertPublicCatalogUrl(`https://example.com/?next=${encodeURIComponent("https://example.com/?campaign=pack")}`));
  let deep = "https://example.com/";
  for (let depth = 0; depth < 8; depth++) deep = `https://example.com/?next=${encodeURIComponent(deep)}`;
  assert.throws(() => assertPublicCatalogUrl(deep), TypeError);
  assert.throws(() => assertPublicCatalogUrl("https://example.com/?%2573ig=private-marker&width=100%"), TypeError);
  assert.doesNotThrow(() => assertPublicCatalogUrl("https://example.com/?caption=Fish%26Actor"));
});
test("WHATWG-normalized nested targets and bare fragments cannot conceal URL userinfo", () => {
  for (const encoded of ["%5C%5Cuser%3Aprivate-marker%40api.example%2Fcb",
    "ht%0Atps%3A%2F%2Fuser%3Aprivate-marker%40api.example%2Fcb",
    "ht%09tps%3A%2F%2Fuser%3Aprivate-marker%40api.example%2Fcb",
    "%00%20%5C%5Cuser%3Aprivate-marker%40api.example%2Fcb%20%00"]) {
    for (const prefix of ["?next=", "#next=", "#"]) {
      assert.throws(() => assertPublicCatalogUrl(`https://example.com/${prefix}${encoded}`), TypeError, `${prefix}${encoded}`);
    }
  }
  for (const encoded of ["%5C%5Capi.example%2Fcb", "ht%0Atps%3A%2F%2Fapi.example%2Fcb", "ht%09tps%3A%2F%2Fapi.example%2Fcb"]) {
    for (const prefix of ["?next=", "#next=", "#"]) {
      assert.doesNotThrow(() => assertPublicCatalogUrl(`https://example.com/${prefix}${encoded}`));
    }
  }
  assert.doesNotThrow(() => assertPublicCatalogUrl("https://example.com/#https://api.example/?caption=Fish%26Actor"));
  assert.doesNotThrow(() => assertPublicCatalogUrl(`https://example.com/#${encodeURIComponent("https://api.example/?caption=Fish%26Actor")}`));
});
test("relative targets and extra component encoding layers cannot conceal protected names", () => {
  for (const encoded of ["%2Fcb%3F%2561ccess_token%3Dprivate-marker",
    "https%253A%252F%252Fexample.com%252Fcb%253Faccess_token%253Dprivate-marker",
    encodeURIComponent("../cb?%2573ig=private-marker&width=100%"),
    encodeURIComponent("cb?%2561ccess_token=private-marker")]) {
    for (const prefix of ["?next=", "#next=", "#"]) {
      assert.throws(() => assertPublicCatalogUrl(`https://example.com/${prefix}${encoded}`), TypeError);
    }
  }
  for (const target of ["/cb?%63ampaign=pack", "https://example.com/cb?campaign=pack",
    "../cb?caption=Fish%26Actor&label=Fish%2BActor&width=100%", "cb?caption=Fish%26Actor"]) {
    for (const encoded of [encodeURIComponent(target), encodeURIComponent(encodeURIComponent(target))]) {
      for (const prefix of ["?next=", "#next=", "#"]) {
        assert.doesNotThrow(() => assertPublicCatalogUrl(`https://example.com/${prefix}${encoded}`));
      }
    }
  }
  assert.doesNotThrow(() => assertPublicCatalogUrl("https://example.com/#caption=Fish%26Actor&label=Fish%2BActor"));
});

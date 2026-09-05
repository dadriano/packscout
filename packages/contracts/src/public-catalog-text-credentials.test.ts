import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPublicCatalogText, assertPublicCatalogUrl } from "./public-catalog-text.ts";

test("public prose rejects credentials in generic URI authorities", () => {
  for (const scheme of ["amqps", "mssql", "ftp", "custom+driver"]) {
    assert.throws(() => assertPublicCatalogText(`Visit ${scheme}://alice:private-marker@internal.example/path`), TypeError);
    assert.throws(() => assertPublicCatalogText(`Visit ${scheme}://ali\nce:private-marker@internal.example/path`), TypeError);
  }
  assert.doesNotThrow(() => assertPublicCatalogText("Contact alice@example.com or read ftp://public.example/manual"));
});

test("WHATWG special URI schemes reject userinfo even without two slashes", () => {
  for (const scheme of ["ftp", "ws", "wss"]) for (const slash of ["", "/", "\\", "//", "\\\\"]) {
    const target = `${scheme}:${slash}alice:private-marker@internal.example/path`;
    assert.equal(new URL(target).username, "alice");
    assert.throws(() => assertPublicCatalogText(`Visit ${target}`), TypeError);
    assert.doesNotThrow(() => assertPublicCatalogText(`Visit ${scheme}:${slash}public.example/path/alice@example.com`));
  }
});

test("embedded public URLs inspect encoded query and fragment credentials", () => {
  for (const suffix of ["?%73ig=private-marker", "#%73ig=private-marker", "?authorization_code=private-marker",
    "?next=" + encodeURIComponent("https://example.com/?%61ccess_token=private-marker")]) {
    assert.throws(() => assertPublicCatalogText(`Visit https://example.com/${suffix} for details.`), TypeError);
  }
  assert.doesNotThrow(() => assertPublicCatalogText('Visit "https://example.com/?campaign=pack" then email alice@example.com.'));
  assert.doesNotThrow(() => assertPublicCatalogText("Visit https://example.com/?caption=Fish%26Actor&contact=alice@example.com"));
});

test("nested form credential keys and OAuth authorization codes remain protected", () => {
  for (const nested of ["sig=private-marker", "sig =private-marker#label", "sig=private-marker?x=y", "%73ig=private-marker", "authorization_code=private-marker",
    "authorization-code=private-marker", "next=" + encodeURIComponent("sig=private-marker")]) {
    for (const prefix of ["?data=", "#data="]) {
      const target = `https://example.com/${prefix}${encodeURIComponent(nested)}`;
      assert.throws(() => assertPublicCatalogUrl(target), TypeError);
      assert.throws(() => assertPublicCatalogText(`Details ${target}`), TypeError);
    }
  }
  for (const nested of ["caption=Fish%26Actor&label=Fish%2BActor", "campaign=pack", "contact=alice@example.com"]) {
    assert.doesNotThrow(() => assertPublicCatalogUrl(`https://example.com/?data=${encodeURIComponent(nested)}`));
  }
});

test("embedded URL traversal shares bounds while long non-URI names remain valid", () => {
  assert.throws(() => assertPublicCatalogText("https://e.co ".repeat(1_001)), TypeError);
  assert.doesNotThrow(() => assertPublicCatalogText("a.".repeat(16_000)));
  let target = "https://example.com/?campaign=pack";
  for (let depth = 0; depth < 8; depth++) target = `https://example.com/?caption=${encodeURIComponent(`Visit ${target}`)}`;
  assert.throws(() => assertPublicCatalogText(target), TypeError);
});

test("JSON URL payloads inspect escaped protected keys and every duplicate-key value", () => {
  for (const payload of ['{"access_token":"private-marker"}', '[{"authorization_code":"private-marker"}]',
    '{"\\u0061ccess_token":"private-marker"}', '{"%2561ccess_token":"private-marker"}',
    '{"caption":{"sig":"private-marker"},"caption":"safe"}',
    JSON.stringify({ next: "https://example.com/?sig=private-marker" }),
    JSON.stringify({ next: "authorization code=private-marker" })]) {
    for (const prefix of ["?data=", "#data=", "#"]) {
      const target = `https://example.com/${prefix}${encodeURIComponent(payload)}`;
      assert.throws(() => assertPublicCatalogUrl(target), TypeError);
      assert.throws(() => assertPublicCatalogText(`Details ${target}`), TypeError);
    }
  }
});

test("structured URL payloads fail closed when malformed or beyond the shared budget", () => {
  for (const payload of ['{"caption":"safe",}', '{"caption":"unterminated}',
    '{"caption":"\\u00GG"}', "[".repeat(8) + "null" + "]".repeat(8),
    JSON.stringify(Array.from({ length: 1_001 }, () => 0))]) {
    assert.throws(() => assertPublicCatalogUrl(`https://example.com/?data=${encodeURIComponent(payload)}`), TypeError);
  }
});

test("benign structured URL payloads preserve JSON captions, separators and scalar types", () => {
  for (const payload of [JSON.stringify({ caption: "Fish & Actor", label: "A+B", rate: "100%" }),
    JSON.stringify([1.5, true, false, null, "public@example.com"]),
    '{"caption":"first","caption":"second"}']) {
    for (const prefix of ["?data=", "#data=", "#"]) {
      const target = `https://example.com/${prefix}${encodeURIComponent(payload)}`;
      assert.doesNotThrow(() => assertPublicCatalogUrl(target));
      assert.doesNotThrow(() => assertPublicCatalogText(`Details ${target}`));
    }
  }
});

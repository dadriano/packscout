import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPublicCatalogText, assertPublicCatalogUrl } from "./public-catalog-text.ts";

test("explicit authorization rejects short credentials across prose and nested values", () => {
  for (const text of ["Authorization: Bearer abc123", "authorization=bearer a", "Details Authorization: BEARER\tZg==",
    'Documentation "authorization"="Bearer a+/._~-="', 'Documentation "Authorization": "Bearer a"',
    "Documentation %61uthorization=Bearer a"]) {
    assert.throws(() => assertPublicCatalogText(text), TypeError);
    assert.throws(() => assertPublicCatalogUrl("https://example.com/?caption=" + encodeURIComponent(text)), TypeError);
    assert.throws(() => assertPublicCatalogUrl("https://example.com/?data=" + encodeURIComponent(JSON.stringify({ caption: text }))), TypeError);
  }
});

test("Bearer words and token-shaped public text do not establish authorization context", () => {
  for (const text of ["Bearer of the Heavens", "Card bearer collection", "bearer scout pack", "Bearer abc123",
    "bearer a", "Details BEARER\tZg==", "===", "Bearer a+/._~-=", "Bearer 12345678901234567890", "ｂｅａｒｅｒ 12345678901234567890"]) {
    assert.doesNotThrow(() => assertPublicCatalogText(text));
    assert.doesNotThrow(() => assertPublicCatalogUrl("https://example.com/?caption=" + encodeURIComponent(text)));
    assert.doesNotThrow(() => assertPublicCatalogUrl("https://example.com/?data=" + encodeURIComponent(JSON.stringify({ caption: text }))));
  }
});

test("protected credential assignments in prose use the existing normalized field policy", () => {
  for (const assignment of ["api_key=sk_live_private_marker", "api.key=private-marker", "api__key=private-marker",
    "api  key=private-marker", '"api_key"="private-marker"', "authorization_code=reusable-code",
    "code_verifier=reusable-verifier", "X-Amz-Signature=private-marker", "sig=private-marker",
    "credentials=private-marker", "%61pi_key=private-marker", '"secret alias"="private-marker"',
    '"api/key"="a"', '"authorization/code"="a"', '"secret/alias"="a"', "'api/key'='a'", '"api·key"="a"']) {
    const text = `Documentation ${assignment}`;
    assert.throws(() => assertPublicCatalogText(text), TypeError);
    assert.throws(() => assertPublicCatalogUrl("https://example.com/?caption=" + encodeURIComponent(text)), TypeError);
    assert.throws(() => assertPublicCatalogUrl("https://example.com/?data=" + encodeURIComponent(JSON.stringify({ caption: text }))), TypeError);
  }
  for (const text of ["Actor: Keanu Reeves", "Host: Public Speaker", "A signature collection", "Promotion code=SUMMER",
    'Documentation "campaign/name"="Summer"', "Documentation caption=Fish%26Actor", "Email contact=support@example.com", "Basic edition"]) {
    assert.doesNotThrow(() => assertPublicCatalogText(text));
    if (!text.includes(":")) assert.doesNotThrow(() => assertPublicCatalogUrl("https://example.com/?caption=" + encodeURIComponent(text)));
  }
  // In ordinary prose these are preceding words, not a quoted/structured key.
  for (const text of ["Secret edition code=SUMMER", "Actor collection code=SUMMER"]) {
    assert.doesNotThrow(() => assertPublicCatalogText(text));
  }
});

test("colon credential assignments preserve ordinary unquoted public labels", () => {
  for (const assignment of ["api_key: a", "api.key: a", "api  key: a", "password: a", "secret: a",
    "access.token: a", "refresh__token: a", "%61pi_key: a", '"api/key": "a"', '"authorization/code": "a"']) {
    const text = `Documentation ${assignment}`;
    assert.throws(() => assertPublicCatalogText(text), TypeError);
    assert.throws(() => assertPublicCatalogUrl("https://example.com/?caption=" + encodeURIComponent(text)), TypeError);
    assert.throws(() => assertPublicCatalogUrl("https://example.com/?data=" + encodeURIComponent(JSON.stringify({ caption: text }))), TypeError);
  }
  for (const text of ["Actor: Keanu Reeves", "Host: Public Speaker", "Bolt: Premium Edition",
    'Documentation "campaign/name": "SUMMER"', "Authorization:"]) {
    assert.doesNotThrow(() => assertPublicCatalogText(text));
  }
});

test("explicit private account and host fields differ from ordinary display labels", () => {
  for (const text of ["Host: db.internal:5432", "Account: internal-123", "Documentation account_id: internal-123",
    "Database URL: postgres://db.internal/catalog", "Port: 5432", '"Host": "Public Speaker"']) {
    assert.throws(() => assertPublicCatalogText(text), TypeError);
    assert.throws(() => assertPublicCatalogUrl("https://example.com/?caption=" + encodeURIComponent(text)), TypeError);
  }
  for (const text of ["Host: Public Speaker", "Actor: Keanu Reeves", "Premium %41ctor: Keanu Reeves", "Bolt: Premium Edition", "Bearer abc123"]) {
    assert.doesNotThrow(() => assertPublicCatalogText(text));
  }
});

test("direct JSON text uses bounded structural inspection before trailing public prose", () => {
  for (const json of ['{"\\u0061ccount":"internal-123"}', '{"\\u0068ost":"db.internal:5432"}',
    '{"\\u0061ccess_token":"private-marker"}', '{"\\u0061\\u0070\\u0069\\u005f\\u006b\\u0065\\u0079":"a"}',
    '{"caption":{"sig":"private-marker"},"caption":"safe"}',
    '{"caption":"safe"} {"\\u0061ccount":"private"}', '"public" [{"\\u0068ost":"db.internal"}]']) {
    assert.throws(() => assertPublicCatalogText(json), TypeError);
    assert.throws(() => assertPublicCatalogText(json + " public alias"), TypeError);
  }
  for (const text of ['{"caption":"public"}', '{"caption":"public"} public alias',
    '["public","caption"]', '"public" public alias', '{"caption":"first"} {"caption":"second"} public alias',
    '"First" ["Second"] public alias', '{"caption":"Host: Public Speaker"}',
    '{"caption":"Actor: Keanu Reeves"}', '["Host: Public Speaker","Actor: J. K. Simmons"]',
    '"Host: Public Speaker"', "[Limited Edition]", "[1/1] Premium"]) {
    assert.doesNotThrow(() => assertPublicCatalogText(text));
  }
});

test("direct JSON retains the existing structural bounds and malformed-document policy", () => {
  for (const text of ['{"caption":"public",}', '[{"caption":"public"}', '{"caption":"\\u00GG"}',
    "[".repeat(7) + "null" + "]".repeat(7)]) assert.throws(() => assertPublicCatalogText(text), TypeError);
});

test("natural leading captions remain public at nested value boundaries", async (context) => {
  for (const caption of ["[1/1] card", "{Limited Edition} card", '"Limited Edition" pack']) {
    for (const text of [caption, `  ${caption}  `]) {
      await context.test(JSON.stringify(text), () => {
        assert.doesNotThrow(() => assertPublicCatalogText(text));
        assert.doesNotThrow(() => assertPublicCatalogText(JSON.stringify({ caption: text })));
        assert.doesNotThrow(() => assertPublicCatalogText("Details " + JSON.stringify({ caption: text })));
        assert.doesNotThrow(() => assertPublicCatalogUrl("https://example.com/?caption=" + encodeURIComponent(text)));
        assert.doesNotThrow(() => assertPublicCatalogUrl("https://example.com/#" + encodeURIComponent(text)));
      });
    }
  }
});

test("nested leading structured text retains strict documents and escaped string inspection", () => {
  for (const text of ['{"caption":"public",}', '[{"caption":"public"}',
    '{"caption":"public"} trailing prose', '"\\u0070assword: a"']) {
    for (const payload of [text, `  ${text}  `]) {
      assert.throws(() => assertPublicCatalogText(JSON.stringify({ caption: payload })), TypeError);
      assert.throws(() => assertPublicCatalogUrl("https://example.com/?caption=" + encodeURIComponent(payload)), TypeError);
      assert.throws(() => assertPublicCatalogUrl("https://example.com/#" + encodeURIComponent(payload)), TypeError);
    }
  }
});

test("natural numeric bracket captions differ from complete JSON arrays", () => {
  for (const caption of ["[1,000 cards]", "[10,000 cards] Premium", "[1,000,000 cards]", "[1, 2 cards]", "Edition [1", "[1"]) {
    assert.doesNotThrow(() => assertPublicCatalogText(caption));
    assert.doesNotThrow(() => assertPublicCatalogText(JSON.stringify({ caption })));
    assert.doesNotThrow(() => assertPublicCatalogUrl("https://example.com/?caption=" + encodeURIComponent(caption)));
    assert.doesNotThrow(() => assertPublicCatalogUrl("https://example.com/#" + encodeURIComponent(caption)));
  }
  for (const text of ["[1,2,3]", '[1,"public",true,null]', '[1,{"caption":"public"}]']) {
    assert.doesNotThrow(() => assertPublicCatalogText(text));
  }
  for (const text of ["[1,]", "[1,2", '[1,{"caption":"public",}]', '[1,{"\\u0070assword":"a"}]',
    '[1,000 cards] {"\\u0070assword":"a"}']) assert.throws(() => assertPublicCatalogText(text), TypeError);
});

test("literal private URL hosts are rejected after canonical address parsing", () => {
  for (const host of ["127.0.0.1", "127.1", "2130706433", "0x7f000001", "0177.0.0.1", "localhost", "LOCALHOST.",
    "api.localhost", "0.0.0.0", "10.1.2.3", "100.64.0.1", "169.254.1.1", "172.16.0.1", "192.168.1.1",
    "[::1]", "[0:0:0:0:0:0:0:1]", "[::]", "[fc00::1]", "[fd12::1]", "[fe80::1]",
    "[::ffff:127.0.0.1]", "[::ffff:a00:1]"]) {
    const target = `https://${host}/packs`;
    assert.throws(() => assertPublicCatalogUrl(target), TypeError, host);
    assert.throws(() => assertPublicCatalogText(`Visit ${target} for details.`), TypeError, host);
    for (const prefix of ["?next=", "#"]) {
      assert.throws(() => assertPublicCatalogUrl("https://example.com/" + prefix + encodeURIComponent(target)), TypeError, host);
    }
  }
  for (const host of ["example.com", "localhost.example.com", "8.8.8.8", "172.15.0.1", "172.32.0.1", "100.128.0.1",
    "[2606:4700:4700::1111]", "[::ffff:8.8.8.8]"]) {
    assert.doesNotThrow(() => assertPublicCatalogUrl(`https://${host}/packs`), host);
  }
  for (const host of ["[2606:4700:4700::1111]", "[::ffff:8.8.8.8]"]) {
    assert.doesNotThrow(() => assertPublicCatalogUrl(`https://${host}`));
    assert.doesNotThrow(() => assertPublicCatalogText(`Visit https://${host} for details.`));
    assert.doesNotThrow(() => assertPublicCatalogText(`Visit (https://${host}).`));
  }
});

test("explicit protected URL path pairs reuse field and OAuth context", () => {
  for (const path of ["/access_token/private-marker", "/%61ccess_token/private-marker", "/%2561ccess_token/private-marker",
    "/access_token%2Fprivate-marker", "/%2561ccess_token%252Fprivate-marker",
    "/access_token/private-marker/../../public", "/%61ccess_token/private-marker/%2e%2e/%2e%2e/public",
    "/api%2Fkey/private-marker", "/sig/private-marker", "/password/private-marker", "/account/internal-123",
    "/callback/code/reusable-code", "/call%62ack/%63ode/reusable-code", "/code/reusable-code?client_id=public-client",
    "/client_id/public-client/code/reusable-code"]) {
    const target = "https://example.com" + path;
    assert.throws(() => assertPublicCatalogUrl(target), TypeError, path);
    assert.throws(() => assertPublicCatalogText(`Visit ${target} for details.`), TypeError, path);
    for (const prefix of ["?next=", "#"]) {
      assert.throws(() => assertPublicCatalogUrl("https://example.com/" + prefix + encodeURIComponent(target)), TypeError, path);
    }
  }
  for (const path of ["/packs/public", "/product/code/SUMMER", "/access_token", "/access_token/",
    "/caption/Fish%26Actor", "/caption/A%2BB", "/caption%2FFish%26Actor", "/callback?next=" + encodeURIComponent("https://shop.example/product/code/SUMMER")]) {
    assert.doesNotThrow(() => assertPublicCatalogUrl("https://example.com" + path), path);
  }
});

test("decoded backslashes and repeated path separators retain protected pair context", () => {
  for (const path of ["/password%5Cprivate-marker", "/%2570assword%255Cprivate-marker", "/access_token//private-marker",
    "/callback%5Ccode%5Cprivate-marker", "/callback%255Ccode%255Cprivate-marker"]) {
    const target = "https://example.com" + path;
    assert.throws(() => assertPublicCatalogUrl(target), TypeError, path);
    assert.throws(() => assertPublicCatalogText(`Visit ${target} for details.`), TypeError, path);
    for (const prefix of ["?next=", "#"]) {
      assert.throws(() => assertPublicCatalogUrl("https://example.com/" + prefix + encodeURIComponent(target)), TypeError, path);
    }
  }
  for (const path of ["/product%5Ccode%5CSUMMER", "/product//code//SUMMER", "/caption%5CFish%26Actor", "/access_token%5C"]) {
    assert.doesNotThrow(() => assertPublicCatalogUrl("https://example.com" + path), path);
  }
});

test("raw slashless HTTP paths retain protected evidence before authority normalization", () => {
  for (const scheme of ["https", "http"]) for (const slash of ["", "/", "\\"]) {
    for (const path of ["access_token/private-marker", "password/private-marker/../../public", "callback/code/private-marker"]) {
      const target = `${scheme}:${slash}${path}`;
      assert.throws(() => assertPublicCatalogUrl(target), TypeError, target);
      assert.throws(() => assertPublicCatalogText(`Visit ${target}`), TypeError, target);
      assert.throws(() => assertPublicCatalogUrl("https://example.com/?next=" + encodeURIComponent(target)), TypeError, target);
    }
    assert.doesNotThrow(() => assertPublicCatalogUrl(`${scheme}:${slash}example.com/product/code/SUMMER`));
  }
  for (const slash of ["//", "///", "////", "\\\\"]) {
    assert.doesNotThrow(() => assertPublicCatalogUrl(`https:${slash}access_token/public`));
    assert.throws(() => assertPublicCatalogUrl(`https:${slash}example.com/password/private-marker`), TypeError);
  }
});

test("explicit HTTP schemes never inherit a relative base that hides private hosts", () => {
  for (const scheme of ["https", "http"]) for (const slash of ["", "/", "\\"]) {
    for (const host of ["127.1", "2130706433", "localhost", "[::1]"]) {
      const target = `${scheme}:${slash}${host}/packs`;
      assert.throws(() => assertPublicCatalogText(`See ${target}`), TypeError, target);
      for (const prefix of ["?next=", "#"]) assert.throws(() => assertPublicCatalogUrl(
        "https://example.com/" + prefix + encodeURIComponent(target)), TypeError, target);
    }
    const target = `${scheme}:${slash}example.com/product/code/SUMMER`;
    assert.doesNotThrow(() => assertPublicCatalogUrl("https://example.com/?next=" + encodeURIComponent(target)));
  }
});

test("embedded URL punctuation preserves query and fragment JSON container endings", () => {
  for (const value of ["[1,2]", '{"caption":"public"}']) {
    for (const prefix of ["?caption=", "#"]) {
      const target = "https://example.com/" + prefix + value;
      assert.doesNotThrow(() => assertPublicCatalogText(`Visit ${target}`), target);
      assert.doesNotThrow(() => assertPublicCatalogText(`Visit "${target}"`), target);
      assert.doesNotThrow(() => assertPublicCatalogUrl(target), target);
    }
  }
  for (const value of ['[{"\\u0070assword":"private-marker"}]', '{"\\u0070assword":"private-marker"}', '"\\u0070assword:private-marker"']) {
    for (const prefix of ["?caption=", "#"]) assert.throws(() => assertPublicCatalogText(
      "Visit https://example.com/" + prefix + value), TypeError, value);
  }
});

test("scheme-relative prose links reject userinfo and inspect their own URL context", () => {
  for (const slash of ["//", "///", "\\\\", "/\\", "\\/"]) {
    for (const authority of ["alice:private-marker@example.com", "alice@example.com", "ali\nce:private-marker@example.com",
      'alice:pa"ss@example.com', '"alice@example.com', "'alice@example.com", "<alice@example.com", "127.1", "[::1]"]) {
      const target = slash + authority + "/public";
      const caption = `Visit ${target} for details.`;
      assert.throws(() => assertPublicCatalogText(caption), TypeError, caption);
      assert.throws(() => assertPublicCatalogText(JSON.stringify({ caption })), TypeError, caption);
      assert.throws(() => assertPublicCatalogUrl("https://example.com/?caption=" + encodeURIComponent(caption)), TypeError, caption);
      assert.throws(() => assertPublicCatalogUrl("https://example.com/#" + encodeURIComponent(caption)), TypeError, caption);
    }
    assert.throws(() => assertPublicCatalogText(`Visit ${slash}example.com/password/private-marker`), TypeError);
    assert.throws(() => assertPublicCatalogText(`Visit ${slash}example.com/?%61ccess_token=private-marker`), TypeError);
    assert.doesNotThrow(() => assertPublicCatalogText(`Visit ${slash}example.com/path/alice@example.com`));
    assert.doesNotThrow(() => assertPublicCatalogText(`Visit ${slash}example.com/product?code=SUMMER`));
    assert.doesNotThrow(() => assertPublicCatalogText(`Visit (${slash}[2606:4700:4700::1111]).`));
  }
  assert.doesNotThrow(() => assertPublicCatalogText("Visit https://example.com/path//alice@example.com or contact alice@example.com."));
  assert.doesNotThrow(() => assertPublicCatalogText("Visit //example.com/?code=SUMMER then //example.com/?client_id=public-client"));
});

test("relative link discovery preserves control boundaries and split-name captions", () => {
  for (const control of ["\t", "\n", "\r"]) {
    for (const target of ["//alice:private-marker@example.com/packs", `/${control}/alice:private-marker@example.com/packs`,
      "//127.1/packs", "//example.com/password/private-marker", '//ali"ce@example.com/packs']) {
      const caption = `See${control}${target}`;
      assert.throws(() => assertPublicCatalogText(caption), TypeError, caption);
      assert.throws(() => assertPublicCatalogText(JSON.stringify({ caption })), TypeError, caption);
      for (const prefix of ["?caption=", "#"]) assert.throws(() => assertPublicCatalogUrl(
        "https://example.com/" + prefix + encodeURIComponent(caption)), TypeError, caption);
      for (const prefix of ["?caption=", "#"]) assert.throws(() => assertPublicCatalogUrl(
        "https://example.com/" + prefix + caption), TypeError, caption);
      for (const prefix of ["?caption=", "#"]) assert.throws(() => assertPublicCatalogText(
        "Visit https://example.com/" + prefix + caption), TypeError, caption);
    }
    assert.doesNotThrow(() => assertPublicCatalogText(`Visit https://example.com/path${control}//alice@example.com`));
    assert.doesNotThrow(() => assertPublicCatalogText(`Visit ftp://example.com/path${control}//alice@example.com`));
    assert.doesNotThrow(() => assertPublicCatalogText(`Visit ht${control}tps:/${control}/[2606:4700:4700::1111].`));
  }
  for (const caption of ["Fire // Ice", "Wear // Tear", "Rating // five stars"]) {
    assert.doesNotThrow(() => assertPublicCatalogText(caption), caption);
    assert.doesNotThrow(() => assertPublicCatalogText(JSON.stringify({ caption })), caption);
  }
  // Direct prose delimiters are not discovered links. Existing nested target
  // parsing remains strict for a value consisting solely of a malformed URL.
  for (const caption of ["//", "///"]) assert.doesNotThrow(() => assertPublicCatalogText(caption), caption);
  assert.throws(() => assertPublicCatalogText('Visit "//example.com/card""//alice@example.com/packs"'), TypeError);
  assert.doesNotThrow(() => assertPublicCatalogText('Visit "//[2606:4700:4700::1111]" or <//example.com>'));
});

test("prose-prefixed structured text inspects protected keys at every bounded value boundary", () => {
  for (const text of ['Documentation {"\\u0070assword":"private-marker"}',
    'Public edition [{"\\u0061ccount":"internal-123"}]',
    'First {"caption":"safe"} then {"\\u0068ost":"db.internal"}',
    'Details {"caption":{"\\u0070assword":"private-marker"},"caption":"public"}']) {
    assert.throws(() => assertPublicCatalogText(text), TypeError);
    assert.throws(() => assertPublicCatalogText(JSON.stringify({ caption: text })), TypeError);
    assert.throws(() => assertPublicCatalogUrl("https://example.com/?caption=" + encodeURIComponent(text)), TypeError);
    assert.throws(() => assertPublicCatalogUrl("https://example.com/#" + encodeURIComponent(text)), TypeError);
  }
  for (const text of ['Documentation {"caption":"public"} edition',
    'Public edition ["Host: Public Speaker", "Actor: Keanu Reeves"]',
    'A {limited edition} and [1/1] card', 'The "Limited Edition" card', 'The "unfinished caption',
    'First {"caption":"public"} then {"caption":"second"}',
    '{"code":"SUMMER"} then {"response_type":"code"}']) assert.doesNotThrow(() => assertPublicCatalogText(text));
});

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
  for (const nested of ["=sig=private-marker", "sig=private-marker", "sig =private-marker#label", "sig=private-marker?x=y", "%73ig=private-marker", "authorization_code=private-marker",
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

test("Basic authorization protects short credentials without rejecting ordinary Basic prose", () => {
  for (const token of ["dXNlcjpwYXNzd29yZA==", "YTpi", "dTo="]) {
    assert.throws(() => assertPublicCatalogText(`Details Basic ${token}`), TypeError);
    assert.throws(() => assertPublicCatalogUrl(`https://example.com/?caption=${encodeURIComponent(`Basic ${token}`)}`), TypeError);
  }
  for (const text of ["Basic edition", "Basic collection", "Basic information available"]) {
    assert.doesNotThrow(() => assertPublicCatalogText(text));
  }
});

test("private database and broker connection schemes remain private without userinfo", () => {
  for (const target of ["amqps://mq.internal:5671/vhost", "mysql://db.internal/catalog",
    "postgresql+psycopg://db.internal/catalog", "mssql://db.internal/catalog", "amqp://queue.example/path@public",
    "sqlite:/private/catalog.db", "sqlite+aiosqlite:/private/catalog.db", "sqlite:private/catalog.db",
    "SQLite::memory:", "sqlite:catalog.db", "mysql:db.internal:3306", "amqps:mq.internal",
    "mysql:alice:private-marker@db.internal", "nats:host=mq.internal", "sqlite:%2Fprivate%2Fcatalog", "sqlite:%3Amemory%3A"]) {
    assert.throws(() => assertPublicCatalogText(`Details ${target}`), TypeError);
    assert.throws(() => assertPublicCatalogUrl("https://example.com/?data=" + encodeURIComponent(target)), TypeError);
  }
  assert.doesNotThrow(() => assertPublicCatalogText("Details ftp://public.example/path@public"));
  assert.doesNotThrow(() => assertPublicCatalogText("MySQL and SQLite are examples."));
});

test("known connection-scheme words remain public prose labels without endpoint syntax", async (context) => {
  for (const title of ["Bolt: Premium Edition", "Pulsar: First Edition", "MySQL: The Guide",
    "Bolt:Premium Edition", "Pulsar:First Edition", "MySQL:The Guide", "SQLite:Reference", "Pulsar:FirstEdition."]) {
    await context.test(title, () => assert.doesNotThrow(() => assertPublicCatalogText(title)));
  }
});

test("optional URL captions and JSON strings preserve known-scheme prose labels", async (context) => {
  for (const container of ["caption", "json"] as const) await context.test(container, () => {
    for (const label of ["Bolt: Premium Edition", "Pulsar: First Edition", "MySQL: The Guide",
      "Bolt:Premium Edition", "Pulsar:First Edition", "MySQL:The Guide", "SQLite:Reference", "Pulsar:FirstEdition."]) {
      const query = container === "caption" ? "caption=" + encodeURIComponent(label)
        : "data=" + encodeURIComponent(JSON.stringify({ caption: label }));
      assert.doesNotThrow(() => assertPublicCatalogUrl(`https://example.com/?${query}`), `${container}: ${label}`);
      assert.doesNotThrow(() => assertPublicCatalogText(`Details https://example.com/?${query}`), `${container}: ${label}`);
      assert.throws(() => assertPublicCatalogUrl(label), TypeError, "required URL fields remain HTTP(S) only");
    }
  });
});

test("optional prose classification retains nearby and nested credential traversal", () => {
  for (const label of ["Bolt: Premium Edition?sig=private-marker", "Bolt: Premium Edition#authorization_code=private-marker",
    "Bolt: Premium Edition?data=" + encodeURIComponent('{"access_token":"private-marker"}'),
    "Bolt: Premium Edition?next=" + encodeURIComponent("sig=private-marker"),
    "Bolt: Premium Edition https://example.com/?access_token=private-marker",
    "Bolt: Premium Edition?code=private-marker&client_id=public-client", "Bolt: Basic YTpi"]) {
    assert.throws(() => assertPublicCatalogUrl("https://example.com/?caption=" + encodeURIComponent(label)), TypeError);
    assert.throws(() => assertPublicCatalogUrl("https://example.com/?data=" + encodeURIComponent(JSON.stringify({ caption: label }))), TypeError);
  }
  for (const payload of [{ caption: "Bolt: Premium Edition", sig: "private-marker" },
    { caption: "Bolt:Premium Edition", nested: { access_token: "private-marker" } }]) {
    assert.throws(() => assertPublicCatalogUrl("https://example.com/?data=" + encodeURIComponent(JSON.stringify(payload))), TypeError);
  }
  assert.throws(() => assertPublicCatalogUrl("https://example.com/?caption=" + encodeURIComponent("custom: Premium Edition")), TypeError);
});

test("repeated scheme tokens stop at connection syntax while repeated prose labels remain valid", () => {
  for (const count of [10, 1_000, 10_000]) {
    assert.throws(() => assertPublicCatalogText("mysql:".repeat(count)), TypeError);
  }
  assert.doesNotThrow(() => assertPublicCatalogText("Bolt:Premium ".repeat(2_000)));
});

test("OAuth callback codes and PKCE verifiers reject while public promotion codes remain valid", () => {
  for (const target of ["https://example.com/callback?code=reusable-code", "https://example.com/call%62ack?%63ode=reusable-code",
    "https://example.com/?client_id=public-client&code=reusable-code", "https://example.com/?code=reusable-code&client_id=public-client",
    "https://example.com/callback#?code=reusable-code", "https://example.com/?code_verifier=reusable-code",
    "https://example.com/callback?data=" + encodeURIComponent(JSON.stringify({ code: "reusable-code" }))]) {
    assert.throws(() => assertPublicCatalogUrl(target), TypeError);
    assert.throws(() => assertPublicCatalogText(`Details ${target}`), TypeError);
  }
  for (const target of ["https://example.com/product?code=SUMMER", "https://example.com/packs?code=123&state=available",
    "https://example.com/?code_challenge=public-challenge",
    "https://example.com/callback?next=" + encodeURIComponent("https://shop.example/product?code=SUMMER")]) {
    assert.doesNotThrow(() => assertPublicCatalogUrl(target));
  }
});

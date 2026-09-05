import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPackAssemblyPublicData } from "./pack-snapshot-assembly-input.ts";
import { PackSnapshotAssemblyError, ProviderPackSnapshotAssembler } from "./provider-pack-snapshot-assembler.ts";
import { assemblyFixture, requestFor } from "./provider-pack-snapshot-assembler.test-support.ts";

const assembler = new ProviderPackSnapshotAssembler();
const refuses = (value: unknown) => assert.throws(() => assertPackAssemblyPublicData(value), PackSnapshotAssemblyError);

test("public text rejects reusable Basic authorization credentials regardless of credential length", async () => {
  for (const literal of ["Basic dXNlcjpwYXNzd29yZA==", "basic dTpw", "BASIC OnA=", "Basic dTo=",
    "Details: Basic\ndXNlcjpwYXNzd29yZA==", "Basic dXNlcjpwYXNzd29yZA"]) {
    refuses({ title: literal });
    refuses({ url: "https://example.com/?caption=" + encodeURIComponent(literal) });
    const { input } = await assemblyFixture(); input.inputs.title = literal;
    await assert.rejects(assembler.assemble(await requestFor(input.inputs)), PackSnapshotAssemblyError);
  }
});

test("explicit authorization context protects credentials regardless of token length or alphabet", async () => {
  for (const title of ["Authorization: Bearer abcdefghijklmno+/pqrs", "Authorization: Bearer dXNlcjpwYXNzd29yZA==",
    "Authorization: Bearer abc123", "authorization: bearer a", "Details Authorization:\tBEARER Zg==",
    "Authorization: Bearer a+/._~-=", "Authorization: a", 'Documentation "Authorization": "Bearer a"']) {
    refuses({ title });
    refuses({ url: "https://example.com/?caption=" + encodeURIComponent(title) });
    const { input } = await assemblyFixture(); input.inputs.title = title;
    await assert.rejects(assembler.assemble(await requestFor(input.inputs)), PackSnapshotAssemblyError);
  }
});

test("Bearer names and opaque-looking prose remain public without credential context", async () => {
  for (const title of ["Bearer of the Heavens", "Bearer of good news", "Card bearer collection", "Bearer abc123", "bearer a",
    "Bearer abcdefghijklmno+/pqrs", "Bearer dXNlcjpwYXNzd29yZA==", "Bearer a+/._~-=", "Details BEARER\tZg==", "==="]) {
    assert.doesNotThrow(() => assertPackAssemblyPublicData({ title }));
    assert.doesNotThrow(() => assertPackAssemblyPublicData({ url: "https://example.com/?caption=" + encodeURIComponent(title) }));
    assert.doesNotThrow(() => assertPackAssemblyPublicData({ url: "https://example.com/?data=" + encodeURIComponent(JSON.stringify({ caption: title })) }));
    const { input } = await assemblyFixture(); input.inputs.title = title;
    assert.equal((await assembler.assemble(await requestFor(input.inputs))).disposition, "created");
  }
});

test("protected credential assignments in public prose use normalized field names", async () => {
  for (const assignment of ["api_key=a", "api_key=sk_live_private_marker", "api.key=private-marker", "api__key=private-marker",
    "api  key=private-marker", '"api_key"="private-marker"', "authorization_code=reusable-code",
    "code_verifier=reusable-verifier", "X-Amz-Signature=private-marker", "sig=private-marker",
    "credentials=private-marker", "%61pi_key=a", "authorization=Bearer a", '"Authorization"="Bearer a"',
    '"secret alias"="a"']) {
    const title = `Documentation ${assignment}`;
    refuses({ title });
    refuses({ url: "https://example.com/?caption=" + encodeURIComponent(title) });
    refuses({ url: "https://example.com/?data=" + encodeURIComponent(JSON.stringify({ caption: title })) });
    const { input } = await assemblyFixture(); input.inputs.title = title;
    await assert.rejects(assembler.assemble(await requestFor(input.inputs)), PackSnapshotAssemblyError);
  }
  for (const value of ["a", "Bearer a", "Bearer abc123"]) {
    refuses({ authorization: value });
    refuses({ url: "https://example.com/?%2541uthorization=" + encodeURIComponent(value) });
  }
});

test("ordinary prose labels and public promotion assignments remain publishable", async () => {
  for (const title of ["Actor: Keanu Reeves", "Host: Public Speaker", "A signature collection",
    "Promotion code=SUMMER", "Secret edition code=SUMMER", "Actor collection code=SUMMER",
    "Documentation caption=Fish%26Actor", "Email contact=support@example.com",
    "Bolt: Premium Edition", "Pulsar:First Edition", "MySQL: The Guide", "Basic edition"]) {
    assert.doesNotThrow(() => assertPackAssemblyPublicData({ title }));
    const { input } = await assemblyFixture(); input.inputs.title = title;
    assert.equal((await assembler.assemble(await requestFor(input.inputs))).disposition, "created");
  }
});

test("quoted assignments inspect the complete normalized name without dropping punctuation or long keys", async () => {
  for (const key of ["api/key", "authorization/code", "secret/alias", "api💫key", "authorization／code", "api\nkey",
    "public/".repeat(40) + "api/key"]) {
    for (const quote of ['"', "'"]) {
      const title = `Documentation ${quote}${key}${quote}=${quote}a${quote}`;
      refuses({ title });
      refuses({ url: "https://example.com/?caption=" + encodeURIComponent(title) });
      refuses({ url: "https://example.com/?data=" + encodeURIComponent(JSON.stringify({ caption: title })) });
      const { input } = await assemblyFixture();
      input.inputs.imageUrl = "https://example.com/?caption=" + encodeURIComponent(title);
      await assert.rejects(assembler.assemble(await requestFor(input.inputs)), PackSnapshotAssemblyError);
    }
  }
});

test("benign quoted assignment names retain public promotion text and shared limits", async () => {
  for (const key of ["campaign/name", "campaign💫name", "campaign\nname", "public/".repeat(40) + "campaign/name"]) {
    for (const quote of ['"', "'"]) {
      const title = `Documentation ${quote}${key}${quote}=${quote}SUMMER${quote}`;
      assert.doesNotThrow(() => assertPackAssemblyPublicData({ title }));
      assert.doesNotThrow(() => assertPackAssemblyPublicData({ url: "https://example.com/?caption=" + encodeURIComponent(title) }));
      assert.doesNotThrow(() => assertPackAssemblyPublicData({ url: "https://example.com/?data=" + encodeURIComponent(JSON.stringify({ caption: title })) }));
      const { input } = await assemblyFixture();
      input.inputs.imageUrl = "https://example.com/?caption=" + encodeURIComponent(title);
      assert.equal((await assembler.assemble(await requestFor(input.inputs))).disposition, "created");
    }
  }
});

test("known database and message-broker URI schemes are private topology without userinfo", async () => {
  for (const uri of ["amqps://mq.internal:5671/vhost", "mysql://db.internal/catalog",
    "postgresql+psycopg://db.internal/catalog", "mysql+pymysql://db.internal/catalog", "mongodb+srv://db.internal/catalog",
    "mssql+pyodbc://db.internal/catalog", "redis+sentinel://cache.internal/0", "nats://mq.internal:4222",
    "kafka://mq.internal:9092", "jdbc:mysql://db.internal/catalog", "am\tqps://mq.internal/vhost",
    "amqps://queue.example/path@public"]) {
    refuses({ title: `Details ${uri}` });
    refuses({ url: "https://example.com/?data=" + encodeURIComponent(JSON.stringify({ caption: uri })) });
    const { input } = await assemblyFixture(); input.inputs.contents[0]!.displayName = `Details ${uri}`;
    await assert.rejects(assembler.assemble(await requestFor(input.inputs)), PackSnapshotAssemblyError);
  }
});

test("known private URI schemes also reject single-slash and opaque connection targets", async () => {
  for (const uri of ["sqlite:/private/catalog.db", "sqlite+aiosqlite:/private/catalog.db", "sqlite:private/catalog.db",
    "SQLite::memory:", "sqlite:catalog.db", "mysql:db.internal:3306", "amqps:mq.internal",
    "mysql:alice:private-marker@db.internal", "nats:host=mq.internal",
    "sqlite:%2Fprivate%2Fcatalog", "sqlite:%3Amemory%3A"]) {
    refuses({ title: `Details ${uri}` });
    refuses({ url: "https://example.com/?data=" + encodeURIComponent(uri) });
    const { input } = await assemblyFixture(); input.inputs.title = uri;
    await assert.rejects(assembler.assemble(await requestFor(input.inputs)), PackSnapshotAssemblyError);
  }
  assert.doesNotThrow(() => assertPackAssemblyPublicData({ title: "A MySQL and SQLite integration guide" }));
});

test("known connection-scheme words remain valid prose titles without endpoint or credential syntax", async (context) => {
  for (const title of ["Bolt: Premium Edition", "Pulsar: First Edition", "MySQL: The Guide",
    "Bolt:Premium Edition", "Pulsar:First Edition", "MySQL:The Guide", "SQLite:Reference", "Pulsar:FirstEdition."]) {
    await context.test(title, async () => {
      assert.doesNotThrow(() => assertPackAssemblyPublicData({ title }));
      assert.doesNotThrow(() => assertPackAssemblyPublicData({ url: "https://example.com/?caption=" + encodeURIComponent(title) }));
      const { input } = await assemblyFixture(); input.inputs.title = title;
      assert.equal((await assembler.assemble(await requestFor(input.inputs))).disposition, "created");
    });
  }
});

test("repeated scheme tokens stop at connection syntax while repeated prose labels remain valid", () => {
  for (const count of [10, 1_000, 10_000]) refuses({ title: "mysql:".repeat(count) });
  assert.doesNotThrow(() => assertPackAssemblyPublicData({ title: "Bolt:Premium ".repeat(2_000) }));
});

test("OAuth authorization codes are private only in authentication route or parameter context", async () => {
  for (const suffix of ["/callback?code=reusable-code", "/auth/callback?%2563ode=reusable-code",
    "/%63allback#code=reusable-code", "/oauth2/return?code=reusable-code", "/signin-oidc?code=reusable-code",
    "/?code=reusable-code&client_id=public-client", "/?redirect_uri=https%3A%2F%2Fexample.com%2Fdone&code=reusable-code",
    "/?code=reusable-code&response_type=code", "/callback?data=" + encodeURIComponent('{"code":"reusable-code"}'),
    "/?data=" + encodeURIComponent("code=reusable-code") + "&client_id=public-client"]) {
    const url = `https://example.com${suffix}`;
    refuses({ url }); refuses({ title: `Details ${url}` });
    refuses({ url: "https://example.com/?next=" + encodeURIComponent(url) });
    const { input } = await assemblyFixture(); input.inputs.actions[0]!.url = url;
    await assert.rejects(assembler.assemble(await requestFor(input.inputs)), PackSnapshotAssemblyError);
  }
});

test("query-only OAuth fragment references retain their enclosing authentication context", () => {
  for (const fragment of ["?code=reusable-code", "?%2563ode=reusable-code"]) {
    refuses({ url: `https://example.com/callback#${fragment}` });
  }
});

test("OAuth context is order-independent across JSON and forms while separate URLs stay independent", () => {
  for (const data of ['{"code":"reusable-code","client_id":"public-client"}',
    '{"client_id":"public-client","code":"reusable-code"}',
    '{"next":{"code":"reusable-code"},"next":"safe","client_id":"public-client"}']) {
    refuses({ url: "https://example.com/?data=" + encodeURIComponent(data) });
  }
  for (const url of ["https://example.com/callback?next=" + encodeURIComponent("https://example.com/coupon?code=SAVE20"),
    "https://example.com/product?code=PACK123&next=" + encodeURIComponent("https://example.com/callback?state=public-state"),
    "https://example.com/?code_challenge=public-challenge&state=public-state"]) {
    assert.doesNotThrow(() => assertPackAssemblyPublicData({ url }));
  }
  for (const key of ["code_verifier", "Code-Verifier", "%2563ode_verifier"]) {
    refuses({ url: `https://example.com/?${key}=reusable-verifier` });
  }
});

test("ordinary product and coupon codes, Basic prose, public URLs and email remain public", async () => {
  for (const title of ["Basic edition", "The Basic collection", "Basic ABCD is the public product label",
    "Visit https://example.com/products?code=PACK123", "Visit https://example.com/coupon?code=SAVE20&state=CA",
    "Visit https://example.com/?data=" + encodeURIComponent('{"code":"SAVE20","caption":"Fish & Actor"}'),
    "Visit ftp://example.com/path@public", "Email support@example.com"]) {
    assert.doesNotThrow(() => assertPackAssemblyPublicData({ title }));
    const { input } = await assemblyFixture(); input.inputs.title = title;
    assert.equal((await assembler.assemble(await requestFor(input.inputs))).disposition, "created");
  }
});

test("public text rejects non-HTTP URI userinfo across generic schemes", async () => {
  for (const uri of ["mysql://alice:secret@db.example/catalog", "amqps://alice:private-marker@queue.example/vhost",
    "ftp://alice:private-marker@example.com/card", "ftp:/alice:private-marker@example.com/card",
    "ftp:alice:private-marker@example.com/card", "ws:alice:private-marker@example.com/card",
    "wss:/alice:private-marker@example.com/card", "custom+secure://alice:private-marker@example.com/card",
    "amqps://ali\nce:pri\tvate-marker@queue.example/vhost"]) {
    refuses({ title: `Visit ${uri}` });
    const { input } = await assemblyFixture(); input.inputs.contents[0]!.displayName = `Visit ${uri}`;
    await assert.rejects(assembler.assemble(await requestFor(input.inputs)), PackSnapshotAssemblyError);
  }
});

test("embedded public URL query and fragment keys receive the same structural guard as URL fields", async () => {
  for (const uri of ["https://example.com/?access_token=private-marker", "https://example.com/#%73ig=private-marker",
    "https://example.com/?%2561ccess_token=private-marker", "ht\ttps://example.com/?access_token=private-marker",
    '"https://example.com""https://example.com/?access_token=private-marker"',
    "https://example.com/path/https://alice:private-marker@example.com",
    "https://example.com/?next=" + encodeURIComponent("https://example.com/?access_token=private-marker")]) {
    const title = `Visit ${uri}`; refuses({ title });
    const { input } = await assemblyFixture(); input.inputs.title = title;
    await assert.rejects(assembler.assemble(await requestFor(input.inputs)), PackSnapshotAssemblyError);
  }
});

test("nested form values inspect decoded names without manufacturing URL parameter separators", async () => {
  for (const form of ["access_token=private-marker", "%73ig=private-marker", "%2573ig=private-marker",
    "access_token=private-marker#label", "access_token=private-marker?x=y",
    "caption=Fish%26Actor&nested=" + encodeURIComponent("%73ig=private-marker")]) {
    for (const prefix of ["?data=", "#data="]) {
      const url = `https://example.com/${prefix}${encodeURIComponent(form)}`; refuses({ url });
      const { input } = await assemblyFixture(); input.inputs.actions[0]!.url = url;
      await assert.rejects(assembler.assemble(await requestFor(input.inputs)), PackSnapshotAssemblyError);
    }
  }
});

test("authorization-code names are protected through casing separators and encoding layers", async () => {
  for (const key of ["authorization_code", "Authorization-Code", "authorizationCode", "%61uthorization_code", "%2561uthorization_code"]) {
    const url = `https://example.com/?${key}=private-marker`; refuses({ url });
    const { input } = await assemblyFixture(); input.inputs.imageUrl = url;
    await assert.rejects(assembler.assemble(await requestFor(input.inputs)), PackSnapshotAssemblyError);
  }
  refuses({ authorization_code: "private-marker" });
});

test("nested form names use the same whitespace normalization as direct URL keys", async () => {
  for (const form of ["sig =private-marker", "authorization code=private-marker", "=sig=private-marker"]) {
    const url = `https://example.com/?data=${encodeURIComponent(form)}`;
    refuses({ url });
    const { input } = await assemblyFixture(); input.inputs.imageUrl = url;
    await assert.rejects(assembler.assemble(await requestFor(input.inputs)), PackSnapshotAssemblyError);
  }
});

test("structured URL payloads reject protected JSON names, including escapes and overwritten duplicate values", async () => {
  for (const payload of ['{"access_token":"private-marker"}', '[{"authorization_code":"private-marker"}]',
    '{"items":[{"nested":{"sig":"private-marker"}}]}', '{"\\u0061ccess_token":"private-marker"}',
    '{"caption":{"access_token":"private-marker"},"caption":"safe"}',
    '{"%2561ccess_token":"private-marker"}', '{"account id":"private-marker"}',
    JSON.stringify('{"access_token":"private-marker"}')]) {
    for (const prefix of ["?data=", "#data=", "#"]) {
      const url = `https://example.com/${prefix}${encodeURIComponent(payload)}`;
      refuses({ url }); refuses({ title: `Visit ${url}` });
      const { input } = await assemblyFixture(); input.inputs.actions[0]!.url = url;
      await assert.rejects(assembler.assemble(await requestFor(input.inputs)), PackSnapshotAssemblyError);
    }
  }
});

test("structured URL payloads recursively inspect JSON strings, forms and URL values", () => {
  for (const payload of [JSON.stringify({ next: 'data={"access_token":"private-marker"}' }),
    JSON.stringify(["https://example.com/?access_token=private-marker"]),
    JSON.stringify({ next: "https://example.com/?data=" + encodeURIComponent('{"sig":"private-marker"}') }),
    'data=' + encodeURIComponent('{"next":"authorization code=private-marker"}'),
    '{"next":"https:\\/\\/example.com\\/?\\u0061ccess_token=private-marker"}']) {
    refuses({ url: `https://example.com/?data=${encodeURIComponent(payload)}` });
  }
});

test("malformed recognized structured URL payloads fail closed", () => {
  for (const payload of ['{"access_token":"private-marker"', '[{"access_token":"private-marker"}',
    '{"caption":"safe",}', '{"caption":"unterminated}', '{"caption":"\\u00GG"}']) {
    refuses({ url: `https://example.com/?data=${encodeURIComponent(payload)}` });
  }
});

test("structured URL payloads share the existing depth budget across serialization layers", () => {
  refuses({ url: "https://example.com/?data=" + encodeURIComponent("[".repeat(17) + "null" + "]".repeat(17)) });
  let payload = "safe";
  for (let index = 0; index < 12; index += 1) payload = JSON.stringify({ nested: payload });
  refuses({ url: `https://example.com/?data=${encodeURIComponent(payload)}` });
});

test("benign structured URL values preserve captions, literal separators and scalar types", async () => {
  for (const payload of [JSON.stringify({ caption: "Fish & Actor", nested: { label: "A+B", rate: "100%" } }),
    JSON.stringify([1.5, true, false, null, "public@example.com", "caption=Fish%26Actor"]),
    JSON.stringify({ next: "https://example.com/card?caption=Fish%26Actor" }),
    JSON.stringify('{"caption":"Fish%26Actor"}'), '{"caption":"first","caption":"second"}']) {
    for (const prefix of ["?data=", "#data=", "#"]) {
      const url = `https://example.com/${prefix}${encodeURIComponent(payload)}`;
      assert.doesNotThrow(() => assertPackAssemblyPublicData({ url }));
      const { input } = await assemblyFixture(); input.inputs.imageUrl = url;
      assert.equal((await assembler.assemble(await requestFor(input.inputs))).disposition, "created");
    }
  }
});

test("the final normalized projection also refuses URI credentials synthesized by search normalization", async () => {
  for (const title of ["Visit ａｍｑｐｓ://alice:private-marker@example.com", "Visit ｈｔｔｐｓ://alice:private-marker@example.com"]) {
    assert.doesNotThrow(() => assertPackAssemblyPublicData({ title })); // NFC display is not the NFKC search projection.
    const { input } = await assemblyFixture(); input.inputs.title = title;
    await assert.rejects(assembler.assemble(await requestFor(input.inputs)), PackSnapshotAssemblyError);
  }
  // Protected assignments are recognizable even before the fullwidth scheme is normalized.
  refuses({ title: "Visit ｈｔｔｐｓ://example.com/?%61uthorization_code=private-marker" });
});

test("benign embedded links, email, URI paths and encoded form values retain their literal structure", async () => {
  for (const title of ["Visit https://example.com and email support@example.com", "Visit https://example.com\nEmail support@example.com",
    'Visit "https://example.com"', "Visit <https://example.com/card?caption=Fish%26Actor>",
    "Visit https://example.com/path@public", "Visit https://example.com/?label=public@example.com",
    "Visit ftp://example.com/path@public", "Email mailto:support@example.com", "Read urn:isbn:123456789"]) {
    assert.doesNotThrow(() => assertPackAssemblyPublicData({ title }));
    const { input } = await assemblyFixture(); input.inputs.title = title;
    assert.equal((await assembler.assemble(await requestFor(input.inputs))).disposition, "created");
  }
  for (const form of ["caption=Fish%26Actor", "label=A%2BB&width=100%25", "caption=Fish%2526Actor"]) {
    const url = `https://example.com/?data=${encodeURIComponent(form)}`;
    assert.doesNotThrow(() => assertPackAssemblyPublicData({ url }));
    const { input } = await assemblyFixture(); input.inputs.imageUrl = url;
    assert.equal((await assembler.assemble(await requestFor(input.inputs))).disposition, "created");
  }
});

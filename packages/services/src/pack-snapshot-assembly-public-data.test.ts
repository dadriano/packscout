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

test("recognized Bearer credentials include the standard plus slash and padding alphabet", async () => {
  for (const title of ["Bearer abcdefghijklmno+/pqrs", "Bearer dXNlcjpwYXNzd29yZA=="]) {
    refuses({ title });
    const { input } = await assemblyFixture(); input.inputs.title = title;
    await assert.rejects(assembler.assemble(await requestFor(input.inputs)), PackSnapshotAssemblyError);
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

test("known private URI schemes also reject single-slash and opaque connection targets", () => {
  for (const uri of ["sqlite:/private/catalog.db", "sqlite+aiosqlite:/private/catalog.db", "sqlite:private/catalog.db"]) {
    refuses({ title: `Details ${uri}` });
    refuses({ url: "https://example.com/?data=" + encodeURIComponent(uri) });
  }
  assert.doesNotThrow(() => assertPackAssemblyPublicData({ title: "A MySQL and SQLite integration guide" }));
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

test("the final normalized projection also refuses URI and query credentials synthesized by search normalization", async () => {
  for (const title of ["Visit ａｍｑｐｓ://alice:private-marker@example.com", "Visit ｈｔｔｐｓ://example.com/?%61uthorization_code=private-marker"]) {
    assert.doesNotThrow(() => assertPackAssemblyPublicData({ title })); // NFC display is not the NFKC search projection.
    const { input } = await assemblyFixture(); input.inputs.title = title;
    await assert.rejects(assembler.assemble(await requestFor(input.inputs)), PackSnapshotAssemblyError);
  }
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

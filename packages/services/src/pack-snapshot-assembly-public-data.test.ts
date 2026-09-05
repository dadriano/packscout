import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPackAssemblyPublicData } from "./pack-snapshot-assembly-input.ts";
import { PackSnapshotAssemblyError, ProviderPackSnapshotAssembler } from "./provider-pack-snapshot-assembler.ts";
import { assemblyFixture, requestFor } from "./provider-pack-snapshot-assembler.test-support.ts";

const assembler = new ProviderPackSnapshotAssembler();
const refuses = (value: unknown) => assert.throws(() => assertPackAssemblyPublicData(value), PackSnapshotAssemblyError);

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
    "Visit amqps://queue.example/path@public", "Email mailto:support@example.com", "Read urn:isbn:123456789"]) {
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

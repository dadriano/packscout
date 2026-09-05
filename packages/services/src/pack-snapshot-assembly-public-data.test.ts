import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPackAssemblyPublicData } from "./pack-snapshot-assembly-input.ts";
import { PackSnapshotAssemblyError, ProviderPackSnapshotAssembler, packSnapshotAssemblyLimits } from "./provider-pack-snapshot-assembler.ts";
import { assemblyFixture, requestFor } from "./provider-pack-snapshot-assembler.test-support.ts";

const assembler = new ProviderPackSnapshotAssembler();
const refuses = (value: unknown) => assert.throws(() => assertPackAssemblyPublicData(value), PackSnapshotAssemblyError);

test("slashless and single-slash URLs retain original protected path evidence", async () => {
  for (const url of ["https:access_token/private-marker", "https:/access_token/private-marker",
    String.raw`https:\access_token\private-marker`, "https:/%61ccess_token/private-marker",
    "https:/%2561ccess_token/private-marker", "https:/access_token%2Fprivate-marker",
    "https:/access_token%5Cprivate-marker", "https:/callback/code/private-marker",
    "https:/access_token/private-marker/../../public"]) {
    refuses({ url });
    refuses({ title: `Visit ${url}` });
    refuses({ url: "https://example.com/?next=" + encodeURIComponent(url) });
    for (const field of ["displayName", "title", "imageUrl", "action"] as const) {
      const { input } = await assemblyFixture();
      if (field === "displayName") input.inputs.contents[0]!.displayName = `Visit ${url}`;
      else if (field === "title") input.inputs.title = `Visit ${url}`;
      else if (field === "imageUrl") input.inputs.imageUrl = url; else input.inputs.actions[0]!.url = url;
      await assert.rejects(assembler.assemble(input), PackSnapshotAssemblyError);
    }
  }
});

test("scheme-relative authorities in public prose share nested URL privacy checks", async () => {
  for (const target of ["//alice:correcthorsebattery@example.com", "///alice:private-marker@example.com",
    String.raw`\\alice:private-marker@example.com`, String.raw`/\alice:private-marker@example.com`,
    String.raw`\/alice:private-marker@example.com`, "//%61lice:private-marker@example.com",
    "//ali\nce:pri\tvate-marker@example.com", "//127.1/card", "//[::1]/card",
    "//example.com/access_token/private-marker", "//example.com/%2561ccess_token%252Fprivate-marker",
    "//example.com/access_token%5Cprivate-marker", "//example.com/?access_token=private-marker",
    "//example.com/#%73ig=private-marker"]) {
    const title = `Visit ${target}`;
    refuses({ title });
    refuses({ title: target });
    refuses({ title: JSON.stringify({ caption: title }) });
    for (const nested of [target, title, JSON.stringify({ caption: title })]) {
      refuses({ url: "https://example.com/?caption=" + encodeURIComponent(nested) });
      refuses({ url: "https://example.com/#" + encodeURIComponent(nested) });
    }
    for (const field of ["displayName", "title", "aliases"] as const) {
      const { input } = await assemblyFixture();
      if (field === "displayName") input.inputs.contents[0]!.displayName = title;
      else if (field === "title") input.inputs.title = title; else input.inputs.aliases = [title];
      await assert.rejects(assembler.assemble(await requestFor(input.inputs)), PackSnapshotAssemblyError);
    }
  }
});

test("raw authority recognition preserves public paths emails and independent URL contexts", async () => {
  for (const url of ["https:example.com/products/card", "https:/example.com/products/card",
    "https://access_token/private-marker", "https:///access_token/private-marker",
    String.raw`https:\\access_token\private-marker`, String.raw`https:/\access_token/private-marker`,
    "https://example.com/path//support@example.com"]) {
    assert.doesNotThrow(() => assertPackAssemblyPublicData({ url }));
    assert.doesNotThrow(() => assertPackAssemblyPublicData({ title: `Visit ${url}` }));
    const { input } = await assemblyFixture(); input.inputs.imageUrl = url;
    assert.equal((await assembler.assemble(await requestFor(input.inputs))).disposition, "created");
  }
  // An explicit nested authority is distinct from an email inside the outer URL path.
  refuses({ url: "https://example.com/?caption=//support@example.com/public" });
  for (const title of ["Visit //example.com/products/card", "Visit //example.com/path//support@example.com",
    "Visit //8.8.8.8/card", "Visit //example.com/path@public", "Visit //[2606:4700:4700::1111] for details.",
    "Visit //example.com/coupon?code=SUMMER then //example.com/callback?state=public-state",
    "Visit https://example.com/callback?state=public-state then //example.com/coupon?code=SUMMER",
    "Email support@example.com", "Bearer of the Heavens"]) {
    assert.doesNotThrow(() => assertPackAssemblyPublicData({ title }));
    assert.doesNotThrow(() => assertPackAssemblyPublicData({ url: "https://example.com/?caption=" + encodeURIComponent(title) }));
    const { input } = await assemblyFixture(); input.inputs.title = title;
    assert.equal((await assembler.assemble(await requestFor(input.inputs))).disposition, "created");
  }
});

test("network references retain control-separated prose boundaries without splitting absolute URL paths", async () => {
  for (const control of ["\t", "\n", "\r"]) {
    for (const title of [`See${control}//alice:private-marker@example.com/card`,
      `See${control}/${control}/alice:private-marker@example.com/card`,
      `See${control}//ali${control}ce:private-marker@example.com/card`]) {
      refuses({ title });
      refuses({ title: JSON.stringify({ caption: title }) });
      refuses({ url: "https://example.com/?caption=" + encodeURIComponent(title) });
      refuses({ url: "https://example.com/#" + encodeURIComponent(title) });
      const { input } = await assemblyFixture(); input.inputs.contents[0]!.displayName = title;
      await assert.rejects(assembler.assemble(await requestFor(input.inputs)), PackSnapshotAssemblyError);
    }
    for (const title of [`Visit https://example.com/path${control}//alice@example.com`,
      `Visit ht${control}tps://example.com/path${control}//alice@example.com`,
      `See${control}//example.com/products/card`, `See${control}//[2606:4700:4700::1111]`]) {
      assert.doesNotThrow(() => assertPackAssemblyPublicData({ title }));
      assert.doesNotThrow(() => assertPackAssemblyPublicData({ url: "https://example.com/?caption=" + encodeURIComponent(title) }));
    }
  }
});

test("public split-card labels are not bare scheme-relative authorities", async () => {
  for (const title of ["Fire // Ice", "Wear // Tear", "Rating // five stars", "Fire /\t/ Ice", "Fire /// Ice"]) {
    assert.doesNotThrow(() => assertPackAssemblyPublicData({ title }));
    assert.doesNotThrow(() => assertPackAssemblyPublicData({ url: "https://example.com/?caption=" + encodeURIComponent(title) }));
    const { input } = await assemblyFixture(); input.inputs.title = title;
    assert.equal((await assembler.assemble(await requestFor(input.inputs))).disposition, "created");
  }
});

test("network authority quotes and angle characters cannot hide username-only credentials", async () => {
  for (const username of ['ali"ce', "ali'ce", "ali<ce", "ali>ce"]) {
    const target = `//${username}@example.com/packs`, title = `Visit ${target}`;
    refuses({ title });
    refuses({ title: JSON.stringify({ caption: title }) });
    refuses({ url: "https://example.com/?caption=" + encodeURIComponent(title) });
    refuses({ url: "https://example.com/#" + encodeURIComponent(title) });
    const { input } = await assemblyFixture(); input.inputs.contents[0]!.displayName = title;
    await assert.rejects(assembler.assemble(await requestFor(input.inputs)), PackSnapshotAssemblyError);
  }
  refuses({ title: 'Visit "https://example.com/card""//alice@example.com/packs"' });
  refuses({ title: 'Visit "//example.com/card""//alice@example.com/packs"' });
  for (const title of ['Visit "https://example.com/card""//example.com/packs"',
    'Visit "//[2606:4700:4700::1111]"', "Visit <//example.com>", "Visit <//[2606:4700:4700::1111]>",
    "Visit https://example.com/path//alice@example.com", "Fire // Ice"]) {
    assert.doesNotThrow(() => assertPackAssemblyPublicData({ title }));
  }
});

test("original URL query and fragment controls retain embedded network evidence", async () => {
  for (const control of ["\t", "\n", "\r"]) {
    for (const target of ["//alice:private-marker@example.com/packs", "//127.1/card",
      "//example.com/access_token/private-marker"]) {
      for (const suffix of [`?caption=See${control}${target}`, `#See${control}${target}`]) {
        const url = "https://example.com/" + suffix;
        refuses({ url });
        refuses({ title: `Visit ${url}` });
        refuses({ url: "https://example.com/?next=" + encodeURIComponent(url) });
        const { input } = await assemblyFixture(); input.inputs.imageUrl = url;
        await assert.rejects(assembler.assemble(await requestFor(input.inputs)), PackSnapshotAssemblyError);
      }
    }
    for (const caption of [`See${control}//example.com/card`, `See https://example.com/path${control}//alice@example.com`,
      `See${control}//example.com/coupon?code=SUMMER`]) {
      assert.doesNotThrow(() => assertPackAssemblyPublicData({ url: "https://example.com/?caption=" + caption }));
      assert.doesNotThrow(() => assertPackAssemblyPublicData({ url: "https://example.com/#caption=" + caption }));
    }
  }
});

test("explicit slashless schemes never resolve private hosts against the public placeholder base", async () => {
  for (const target of ["https:127.1/packs", "https:/127.1/packs", String.raw`https:\127.1\packs`,
    "https:2130706433/packs", "https:/[::1]/packs", "ht\ttps:/127.1/packs"]) {
    const title = `See ${target}`;
    refuses({ title });
    refuses({ title: JSON.stringify({ caption: title }) });
    for (const value of [target, title]) {
      refuses({ url: "https://example.com/?next=" + encodeURIComponent(value) });
      refuses({ url: "https://example.com/#" + encodeURIComponent(value) });
    }
    const { input } = await assemblyFixture(); input.inputs.title = title;
    await assert.rejects(assembler.assemble(await requestFor(input.inputs)), PackSnapshotAssemblyError);
  }
  for (const target of ["https:8.8.8.8/packs", "https:/example.com/packs", "/packs/card", "//example.com/packs"]) {
    assert.doesNotThrow(() => assertPackAssemblyPublicData({ url: "https://example.com/?next=" + encodeURIComponent(target) }));
  }
});

test("embedded public IPv6 authorities retain closing brackets before prose punctuation", async () => {
  for (const target of ["//[2606:4700:4700::1111]", "https://[2606:4700:4700::1111]",
    "ht\ttps://[2606:4700:4700::1111]", String.raw`\\[2606:4700:4700::1111]`]) {
    for (const title of [`See (${target}).`, `See (${target});`, `See [${target}].`]) {
      assert.doesNotThrow(() => assertPackAssemblyPublicData({ title }));
      assert.doesNotThrow(() => assertPackAssemblyPublicData({ title: JSON.stringify({ caption: title }) }));
      assert.doesNotThrow(() => assertPackAssemblyPublicData({ url: "https://example.com/?caption=" + encodeURIComponent(title) }));
      const { input } = await assemblyFixture(); input.inputs.title = title;
      assert.equal((await assembler.assemble(await requestFor(input.inputs))).disposition, "created");
    }
  }
  for (const title of ["See (//[::1]).", 'See (//ali"ce@example.com).']) refuses({ title });
  refuses({ url: "https://[2606:4700:4700::1111])." });
});

test("embedded URL punctuation trimming preserves structured query and fragment closing delimiters", async () => {
  for (const suffix of ['?caption=[1,2]', '#[1,2]', '#caption=[1,2]',
    '?caption={"caption":"public"}', '#{"caption":"public"}', '#caption={"caption":"public"}']) {
    const url = "https://example.com/" + suffix;
    assert.doesNotThrow(() => assertPackAssemblyPublicData({ url }));
    assert.doesNotThrow(() => assertPackAssemblyPublicData({ url: "https://example.com/?next=" + encodeURIComponent(`Visit ${url}`) }));
    for (const title of [`Visit ${url}`, `Visit "${url}"`]) {
      assert.doesNotThrow(() => assertPackAssemblyPublicData({ title }));
      const { input } = await assemblyFixture(); input.inputs.title = title;
      assert.equal((await assembler.assemble(await requestFor(input.inputs))).disposition, "created");
    }
  }
  for (const suffix of ['?caption=[{"\\u0070assword":"private"}]', '#[{"\\u0061ccess_token":"private"}]',
    '#caption={"\\u0061ccount":"private"}', '?caption={"caption":"safe","\\u0070assword":"private","caption":"safe"}']) {
    refuses({ title: `Visit "https://example.com/${suffix}"` });
    refuses({ url: "https://example.com/" + suffix });
  }
});

test("literal private URL hosts reject through canonical IPv4 IPv6 and localhost spellings", async () => {
  for (const host of ["127.0.0.1", "127.1", "2130706433", "0x7f000001", "0177.0.0.1", "0.0.0.0", "10.2.3.4",
    "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1", "localhost", "LOCALHOST.",
    "cards.localhost", "cards.localhost.", "[::]", "[::1]", "[fc00::1]", "[fdff::1]", "[fe80::1]", "[febf::1]",
    "[::ffff:127.0.0.1]", "[::ffff:a00:1]", "[::ffff:c0a8:101]"]) {
    const url = `https://${host}/card`;
    for (const field of ["displayName", "title", "imageUrl", "action"] as const) {
      const { input } = await assemblyFixture();
      if (field === "displayName") input.inputs.contents[0]!.displayName = `Visit ${url}`;
      else if (field === "title") input.inputs.title = `Visit ${url}`;
      else if (field === "imageUrl") input.inputs.imageUrl = url; else input.inputs.actions[0]!.url = url;
      await assert.rejects(assembler.assemble(await requestFor(input.inputs)), PackSnapshotAssemblyError);
    }
    refuses({ url });
    refuses({ url: "https://example.com/?next=" + encodeURIComponent(url) });
  }
});

test("public IP destinations and ordinary host-name prose remain publishable", async () => {
  for (const host of ["8.8.8.8", "172.15.255.255", "172.32.0.1", "192.169.1.1", "100.63.255.255", "100.128.0.1",
    "[2606:4700:4700::1111]", "[::ffff:8.8.8.8]", "example.com", "localhost.example.com"]) {
    const url = `https://${host}/products/card`;
    assert.doesNotThrow(() => assertPackAssemblyPublicData({ url }));
    assert.doesNotThrow(() => assertPackAssemblyPublicData({ title: `Visit https://${host} for details.` }));
    const { input } = await assemblyFixture(); input.inputs.imageUrl = url;
    assert.equal((await assembler.assemble(await requestFor(input.inputs))).disposition, "created");
  }
  assert.doesNotThrow(() => assertPackAssemblyPublicData({ title: "A localhost and 127.0.0.1 networking guide" }));
});

test("explicit protected path pairs reject before URL dot normalization and through encoded separators", async () => {
  for (const path of ["/access_token/private-marker", "/%61ccess_token/private-marker", "/%2561ccess_token/private-marker",
    "/api.key/private", "/authorization_code/private", "/account/internal-123", "/host/db.internal",
    "/callback/code/private", "/code/private?client_id=public-client", "/callback/code/private/../../public",
    "/access_token/private-marker/../../public", "/%61ccess_token/private-marker/%2e%2e/%2e%2e/public",
    "/access_token%2Fprivate", "/%2561ccess_token%252Fprivate", "/access_token%5Cprivate",
    "/callback%5Ccode%5Cprivate", "/access_token//private"]) {
    const url = "https://example.com" + path;
    for (const field of ["displayName", "title", "imageUrl", "action"] as const) {
      const { input } = await assemblyFixture();
      if (field === "displayName") input.inputs.contents[0]!.displayName = `Visit ${url}`;
      else if (field === "title") input.inputs.title = `Visit ${url}`;
      else if (field === "imageUrl") input.inputs.imageUrl = url; else input.inputs.actions[0]!.url = url;
      await assert.rejects(assembler.assemble(await requestFor(input.inputs)), PackSnapshotAssemblyError);
    }
    refuses({ url });
    refuses({ url: "https://example.com/?next=" + encodeURIComponent(url) });
  }
});

test("public product paths keep terminal labels and contextual coupon codes", async () => {
  for (const path of ["/products/pack-123", "/access_token", "/coupon/code/SUMMER", "/products/code/PACK123",
    "/card/Fish%26Actor", "/caption/A%2BB", "/products/part%2Fname", "/products/card?code=SUMMER"]) {
    const url = "https://example.com" + path;
    assert.doesNotThrow(() => assertPackAssemblyPublicData({ url }));
    const { input } = await assemblyFixture(); input.inputs.actions[0]!.url = url;
    assert.equal((await assembler.assemble(await requestFor(input.inputs))).disposition, "created");
  }
  assert.doesNotThrow(() => assertPackAssemblyPublicData({ url: "https://example.com/callback?next=" +
    encodeURIComponent("https://example.com/coupon/code/SUMMER") }));
});

test("decoded JSON prose retains private-host and protected-path checks on its embedded URLs", async () => {
  for (const destination of ["https://127.0.0.1/card", "https://example.com/access_token/private"]) {
    const payload = JSON.stringify({ caption: `Visit ${destination}` }).replace("https", "ht\\u0074ps");
    for (const suffix of ["?data=", "#data=", "#"]) {
      const url = "https://example.com/" + suffix + encodeURIComponent(payload);
      const { input } = await assemblyFixture(); input.inputs.imageUrl = url;
      await assert.rejects(assembler.assemble(await requestFor(input.inputs)), PackSnapshotAssemblyError);
      refuses({ url });
    }
  }
  for (const destination of ["https://8.8.8.8/card", "https://[2606:4700:4700::1111]", "https://example.com/coupon/code/SUMMER"]) {
    const payload = JSON.stringify({ caption: `Visit ${destination}` }).replace("https", "ht\\u0074ps");
    assert.doesNotThrow(() => assertPackAssemblyPublicData({ url: "https://example.com/?data=" + encodeURIComponent(payload) }));
  }
});

test("numeric bracket captions are not inferred to be JSON from the first comma", async () => {
  for (const label of ["Includes [1,000 cards]", "[1,000,000 cards] edition", "Includes [1, 2 cards]", "[1,000] cards", "Edition [1"]) {
    for (const text of [label, JSON.stringify({ caption: label }), "Documentation " + JSON.stringify({ caption: label })]) {
      for (const field of ["displayName", "title", "aliases"] as const) {
        const { input } = await assemblyFixture();
        if (field === "displayName") input.inputs.contents[0]!.displayName = text;
        else if (field === "title") input.inputs.title = text; else input.inputs.aliases = [text];
        assert.equal((await assembler.assemble(await requestFor(input.inputs))).disposition, "created");
      }
      for (const suffix of ["?caption=", "#"]) {
        assert.doesNotThrow(() => assertPackAssemblyPublicData({ url: "https://example.com/" + suffix + encodeURIComponent(text) }));
      }
    }
  }
  for (const text of ['Includes [1,2,"public",true,null]', "Includes [1,2.5,false]", "Includes [1,[2,3]]"]) {
    assert.doesNotThrow(() => assertPackAssemblyPublicData({ title: text }));
  }
  for (const text of ["Includes [1,]", "Includes [1,2", 'Includes [1,{"caption":"public",}]',
    'Includes [1,000 cards] {"\\u0070assword":"private"}']) refuses({ title: text });
});

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

test("explicit credential-name colon assignments reject without classifying ordinary labels", async () => {
  for (const assignment of ["api_key: sk_live_private_marker", "password: hunter2", "api.key: a", "api  key: a",
    "API-KEY:\ta", "%61pi_key: a", "%2561pi_key: a", "secret: a", "access_token: a", "refresh.token: a",
    "authorization: Bearer a", "client_api_key: a", '"api/key": "a"', '"password": "a"',
    '"secret/alias": "a"', "'api💫key': 'a'", '"api\nkey": "a"']) {
    const title = `Documentation ${assignment}`;
    refuses({ title });
    refuses({ url: "https://example.com/?caption=" + encodeURIComponent(title) });
    refuses({ url: "https://example.com/?data=" + encodeURIComponent(JSON.stringify({ caption: title })) });
    const { input } = await assemblyFixture(); input.inputs.title = title;
    await assert.rejects(assembler.assemble(await requestFor(input.inputs)), PackSnapshotAssemblyError);
  }
});

test("ordinary colon labels and quoted promotion fields remain public", async () => {
  assert.doesNotThrow(() => assertPackAssemblyPublicData({ title: "Authorization:" }));
  for (const title of ["Actor: Keanu Reeves", "Host: Public Speaker", "Bolt: Premium Edition", "Pulsar:First Edition",
    "Secret edition code: SUMMER", "Bearer abc123", 'Documentation "campaign/name": "SUMMER"',
    "Documentation 'campaign💫name': 'SUMMER'"]) {
    assert.doesNotThrow(() => assertPackAssemblyPublicData({ title }));
    assert.doesNotThrow(() => assertPackAssemblyPublicData({ url: "https://example.com/?caption=" + encodeURIComponent(title) }));
    const { input } = await assemblyFixture(); input.inputs.title = title;
    assert.equal((await assembler.assemble(await requestFor(input.inputs))).disposition, "created");
  }
  assert.doesNotThrow(() => assertPackAssemblyPublicData({ title: "Actor: Keanu Reeves; Host: Public Speaker; Bolt:Premium ".repeat(1_000) }));
});

test("explicit account fields and connection-shaped host colon values reject in public text", async () => {
  for (const title of ["Host: db.internal:5432", "Account: internal-123", "Host: db.internal", "Host: 127.0.0.1:5432",
    "Host: [::1]:5432", "Documentation host: localhost:5432", 'Host: "db.internal:5432"',
    "h.o.s.t: db.internal:5432", "%68ost: db.internal:5432", "Account ID: internal-123", "account.id: a",
    "raw payload: private-marker", "authorization code: private-marker", "code verifier: private-marker"]) {
    refuses({ title });
    refuses({ aliases: [title] });
    refuses({ url: "https://example.com/?caption=" + encodeURIComponent(title) });
    for (const field of ["title", "aliases"] as const) {
      const { input } = await assemblyFixture();
      if (field === "title") input.inputs.title = title; else input.inputs.aliases = [title];
      await assert.rejects(assembler.assemble(await requestFor(input.inputs)), PackSnapshotAssemblyError);
    }
  }
});

test("direct structured public text inspects escaped duplicate and nested protected JSON fields", async () => {
  for (const title of ['{"\\u0061\\u0063\\u0063\\u0065\\u0073\\u0073\\u005f\\u0074\\u006f\\u006b\\u0065\\u006e":"private-marker"}',
    '{"\\u0061ccess_token":"private-marker"}', '[{"\\u0061ccount":"internal-123"}]',
    '{"caption":"safe","\\u0061ccess_token":"private-marker","caption":"safe"}',
    '{"caption":{"\\u0068ost":"db.internal:5432"},"caption":"safe"}',
    JSON.stringify({ nested: '{"\\u0070assword":"private-marker"}' }),
    JSON.stringify(['data={"\\u0061ccess_token":"private-marker"}']),
    JSON.stringify('{"\\u0061ccess_token":"private-marker"}'),
    '{"\\u0061ccount":"internal-123"} Public Edition', '[{"\\u0068ost":"db.internal"}] Public Edition',
    JSON.stringify('{"\\u0061ccount":"internal-123"}') + " Public Edition",
    '{"caption":"safe"} {"\\u0061ccount":"private"}', '"public" [{"\\u0068ost":"db.internal"}]']) {
    refuses({ title });
    refuses({ aliases: [title] });
    for (const field of ["title", "aliases"] as const) {
      const { input } = await assemblyFixture();
      if (field === "title") input.inputs.title = title; else input.inputs.aliases = [title];
      await assert.rejects(assembler.assemble(await requestFor(input.inputs)), PackSnapshotAssemblyError);
    }
  }
});

test("benign direct JSON and ordinary host actor and connection-scheme labels remain publishable", async () => {
  for (const title of ['{"caption":"Fish & Actor","label":"A+B"}', '[1.5,true,false,null,"public@example.com"]',
    '{"caption":"first","caption":"second"}', JSON.stringify('{"caption":"public"}'),
    '{"caption":"public"} Premium', '"Public Edition" Premium', '[{"caption":"public"}] Premium',
    '{"caption":"first"} {"caption":"second"} Premium', '"First" ["Second"] Premium',
    "[Limited Edition]", "[1/1] Premium", "Actor: Keanu Reeves", "Host: Public Speaker", "Host:Public Speaker",
    "Premium %41ctor: Keanu Reeves", "Bolt: Premium Edition", "Pulsar:First Edition"]) {
    assert.doesNotThrow(() => assertPackAssemblyPublicData({ title }));
    assert.doesNotThrow(() => assertPackAssemblyPublicData({ aliases: [title] }));
    for (const field of ["title", "aliases"] as const) {
      const { input } = await assemblyFixture();
      if (field === "title") input.inputs.title = title; else input.inputs.aliases = [title];
      assert.equal((await assembler.assemble(await requestFor(input.inputs))).disposition, "created");
    }
  }
});

test("direct structured public text shares existing depth limits and malformed JSON rules", () => {
  for (const title of ['{"caption":"public",}', '[{"caption":"public"}', '{"caption":"\\u00GG"}',
    "[".repeat(17) + "null" + "]".repeat(17)]) refuses({ title });
  let nested = "public";
  for (let index = 0; index < 12; index += 1) nested = JSON.stringify({ caption: nested });
  refuses({ title: nested });
});

test("JSON after prose cannot publish escaped protected fields through member names titles or aliases", async () => {
  for (const text of ['Documentation {"\\u0070assword":"hunter2"}', 'Documentation [{"\\u0061ccount":"private"}]',
    'Documentation {"caption":{"\\u0068ost":"db.internal"},"caption":"public"}',
    'Documentation {} then {"\\u0061ccount":"private"} {"caption":"public"}',
    'Documentation ' + JSON.stringify('{"\\u0070assword":"hunter2"}'),
    JSON.stringify({ caption: 'Documentation {"\\u0070assword":"hunter2"}' }),
    'A quote "prefix {"\\u0070assword":"hunter2"}', 'A quote "prefix \\u0020 {"\\u0070assword":"hunter2"}']) {
    for (const field of ["displayName", "title", "aliases"] as const) {
      const { input } = await assemblyFixture();
      if (field === "displayName") input.inputs.contents[0]!.displayName = text;
      else if (field === "title") input.inputs.title = text; else input.inputs.aliases = [text];
      await assert.rejects(assembler.assemble(await requestFor(input.inputs)), PackSnapshotAssemblyError);
    }
    refuses({ displayName: text });
    refuses({ url: "https://example.com/?caption=" + encodeURIComponent(text) });
    refuses({ url: "https://example.com/#" + encodeURIComponent(text) });
  }
});

test("JSON within prose preserves ordinary braces brackets and quoted natural text", async () => {
  for (const text of ['Documentation {"caption":"public"} extra', 'Documentation {} then ["public"] extra',
    "Collectibles {Limited Edition} [1/1]", 'The "Limited Edition" pack', '12" ruler', 'A lone "quoted label',
    'A literal {"Edition"} label', "An unfinished { label", 'Public ["Limited Edition"] label',
    'He said "look at {braces}"', 'Quote "A [1/1] label" ends', 'Quote "C:\\Cards\\Set" ends',
    'The set { "A", "B" }', 'Documentation "caption"="public"', 'Documentation {"caption":"Host: Public Speaker"}',
    'Documentation ' + JSON.stringify('[{"caption":"public"}]'), 'Documentation ' + JSON.stringify('A "public" label')]) {
    assert.doesNotThrow(() => assertPackAssemblyPublicData({ displayName: text }));
    for (const field of ["displayName", "title", "aliases"] as const) {
      const { input } = await assemblyFixture();
      if (field === "displayName") input.inputs.contents[0]!.displayName = text;
      else if (field === "title") input.inputs.title = text; else input.inputs.aliases = [text];
      assert.equal((await assembler.assemble(await requestFor(input.inputs))).disposition, "created");
    }
  }
});

test("natural leading labels remain public inside JSON and URL captions", async (context) => {
  for (const label of ["[1/1] card", "{Limited Edition} card", '"Limited Edition" pack', '"Limited Edition', '"C:\\Cards\\Set"']) {
    await context.test(label, async () => {
      for (const text of [label, JSON.stringify({ caption: label }), "Documentation " + JSON.stringify({ caption: label }),
        JSON.stringify(label)]) {
        for (const field of ["displayName", "title", "aliases"] as const) {
          const { input } = await assemblyFixture();
          if (field === "displayName") input.inputs.contents[0]!.displayName = text;
          else if (field === "title") input.inputs.title = text; else input.inputs.aliases = [text];
          assert.equal((await assembler.assemble(await requestFor(input.inputs))).disposition, "created");
        }
        assert.doesNotThrow(() => assertPackAssemblyPublicData({ displayName: text }));
        for (const suffix of ["?caption=", "#caption=", "#"]) {
          const url = "https://example.com/" + suffix + encodeURIComponent(text);
          assert.doesNotThrow(() => assertPackAssemblyPublicData({ url }));
          const { input } = await assemblyFixture(); input.inputs.imageUrl = url;
          assert.equal((await assembler.assemble(await requestFor(input.inputs))).disposition, "created");
        }
      }
    });
  }
});

test("natural label dispatch does not weaken recognized JSON or escaped standalone strings", () => {
  for (const payload of ['{"caption":"safe",}', '[{"caption":"safe"}', '{"caption":"\\u00GG"}',
    '{"caption":"safe"} extra', '["safe"] extra',
    JSON.stringify('{"\\u0070assword":"private"}'), '"\\u0070assword: private"',
    JSON.stringify('{"\\u0070assword":"private"}') + " edition"]) {
    for (const suffix of ["?caption=", "#caption=", "#"]) {
      refuses({ url: "https://example.com/" + suffix + encodeURIComponent(payload) });
    }
  }
});

test("JSON after prose shares the existing depth node and byte limits", () => {
  for (const json of ['{"caption":"public",}', '[{"caption":"public"}', '{"caption":"\\u00GG"}']) {
    refuses({ displayName: "Documentation " + json });
  }
  refuses({ displayName: "Documentation " + "[".repeat(17) + "null" + "]".repeat(17) });
  refuses({ displayName: "Documentation [" + "0,".repeat(packSnapshotAssemblyLimits.maximumNodes) + "0]" });
  refuses({ displayName: "Documentation " + "[]".repeat(packSnapshotAssemblyLimits.maximumSnapshotBytes / 2) });
});

test("the final search projection inspects JSON assembled across separately safe title and alias text", async () => {
  const { input } = await assemblyFixture();
  input.inputs.title = 'Documentation {"\\u0070ass';
  input.inputs.aliases = ['word":"hunter2"}'];
  const candidate = await requestFor(input.inputs);
  assert.doesNotThrow(() => assertPackAssemblyPublicData(candidate));
  await assert.rejects(assembler.assemble(candidate), PackSnapshotAssemblyError);
});

test("independent prose JSON roots and URLs do not share OAuth context but nested URL payloads retain it", async () => {
  for (const title of ['{"code":"SUMMER"} then {"response_type":"code"}',
    'Documentation {"code":"SUMMER"} then {"response_type":"code"}',
    "https://example.com/coupon?caption=" + encodeURIComponent('Documentation {"code":"SUMMER"}') +
      " https://example.com/callback?caption=" + encodeURIComponent('Documentation {"response_type":"code"}')]) {
    assert.doesNotThrow(() => assertPackAssemblyPublicData({ title }));
    const { input } = await assemblyFixture(); input.inputs.title = title;
    assert.equal((await assembler.assemble(await requestFor(input.inputs))).disposition, "created");
  }
  for (const path of ["/?caption=", "/#caption="]) {
    refuses({ url: "https://example.com" + path + encodeURIComponent('Documentation {"code":"private"} then {"response_type":"code"}') });
  }
  refuses({ url: "https://example.com/callback?caption=" + encodeURIComponent('Documentation {"code":"private"}') });
});

test("an empty authorization label is rejected only after a separate public alias supplies its value", async () => {
  const { input } = await assemblyFixture();
  input.inputs.title = "Authorization:";
  input.inputs.aliases = ["Bearer abc123"];
  const candidate = await requestFor(input.inputs);
  assert.doesNotThrow(() => assertPackAssemblyPublicData(candidate));
  await assert.rejects(assembler.assemble(candidate), PackSnapshotAssemblyError);
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

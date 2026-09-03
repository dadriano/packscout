import assert from "node:assert/strict";
import { test } from "node:test";
import { collectorCryptCardProviderFactsV1 } from
  "./dataforrest-collector-crypt-card-v1.ts";

test("Collector Crypt reads only reviewed asset card labels and safe images", () => {
  const facts = collectorCryptCardProviderFactsV1({
    asset: {
      itemName: "  Reviewed Collector Card  ",
      images: {
        frontImage: "https://images.example.test/front.png",
        backImage: "https://images.example.test/back.png",
      },
      category: "unreviewed-category",
      insuredValue: 2_500,
      id: "native-id-must-not-escape",
      owner: "native-owner-must-not-escape",
    },
    detail: { plain: { itemName: "Detail fallback prohibited" } },
  });

  assert.deepEqual(facts.displayName, {
    state: "present",
    value: "Reviewed Collector Card",
  });
  assert.deepEqual(facts.imageReferences, {
    state: "present",
    value: [
      "https://images.example.test/front.png",
      "https://images.example.test/back.png",
    ],
  });
  assert.deepEqual(facts.category, { state: "absent" });
  assert.deepEqual(facts.estimatedValue, { state: "absent" });
  assert.deepEqual(facts.valueSource, { state: "absent" });
  const serialized = JSON.stringify(facts);
  for (const forbidden of [
    "unreviewed-category",
    "2500",
    "native-id-must-not-escape",
    "native-owner-must-not-escape",
    "Detail fallback prohibited",
  ]) assert.equal(serialized.includes(forbidden), false);
});

test("Collector Crypt preserves front/back order and deduplicates safe image URLs", () => {
  assert.deepEqual(collectorCryptCardProviderFactsV1({
    asset: {
      itemName: "Front only",
      images: { frontImage: "https://images.example.test/front.png" },
    },
  }).imageReferences, {
    state: "present",
    value: ["https://images.example.test/front.png"],
  });
  assert.deepEqual(collectorCryptCardProviderFactsV1({
    asset: {
      itemName: "Duplicate",
      images: {
        frontImage: "https://images.example.test/same.png",
        backImage: "https://images.example.test/same.png",
      },
    },
  }).imageReferences, {
    state: "present",
    value: ["https://images.example.test/same.png"],
  });
});

test("missing or malformed selected assets never fall through to detail labels", () => {
  assert.deepEqual(collectorCryptCardProviderFactsV1({
    detail: { plain: { itemName: "Do not infer" } },
  }).displayName, { state: "absent" });

  for (const asset of [null, [], 7, "asset"]) {
    const facts = collectorCryptCardProviderFactsV1({
      asset,
      detail: { plain: { itemName: "Do not infer" } },
    });
    assert.deepEqual(facts.displayName, { state: "malformed" });
    assert.deepEqual(facts.imageReferences, { state: "malformed" });
  }

  for (const itemName of [42, " ", "x".repeat(10_001)]) {
    assert.deepEqual(collectorCryptCardProviderFactsV1({
      asset: { itemName },
      detail: { plain: { itemName: "Do not infer" } },
    }).displayName, { state: "malformed" });
  }
  for (const itemName of [undefined, null]) {
    assert.deepEqual(collectorCryptCardProviderFactsV1({
      asset: { itemName },
      detail: { plain: { itemName: "Do not infer" } },
    }).displayName, { state: "absent" });
  }
});

test("Collector Crypt images reject unsafe or malformed native values", () => {
  for (const image of [
    "http://images.example.test/card.png",
    "javascript:unsafe",
    "https://user:password@images.example.test/card.png",
    "https://images.example.test/card.png#fragment",
    "x".repeat(2_049),
    " ",
    42,
  ]) {
    const facts = collectorCryptCardProviderFactsV1({
      asset: {
        itemName: "Valid card name",
        images: { frontImage: image },
      },
    });
    assert.deepEqual(facts.displayName, {
      state: "present",
      value: "Valid card name",
    });
    assert.deepEqual(facts.imageReferences, { state: "malformed" });
  }

  for (const images of [[], 42, "images"]) {
    assert.deepEqual(collectorCryptCardProviderFactsV1({
      asset: { itemName: "Valid card name", images },
    }).imageReferences, { state: "malformed" });
  }
  for (const images of [undefined, null, {}]) {
    assert.deepEqual(collectorCryptCardProviderFactsV1({
      asset: { itemName: "Valid card name", images },
    }).imageReferences, { state: "absent" });
  }
});

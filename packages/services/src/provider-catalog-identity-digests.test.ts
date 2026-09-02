import assert from "node:assert/strict";
import { test } from "node:test";
import { providerCatalogIdentityCountMapDigest } from
  "./provider-catalog-identity-digests.ts";

test("catalog count-map digest is deterministic and binds multiplicity", () => {
  const left = new Map([["a".repeat(64), 2], ["b".repeat(64), 1]]);
  const reordered = new Map([["b".repeat(64), 1], ["a".repeat(64), 2]]);
  const changed = new Map([["a".repeat(64), 1], ["b".repeat(64), 1]]);
  assert.equal(
    providerCatalogIdentityCountMapDigest(left),
    providerCatalogIdentityCountMapDigest(reordered),
  );
  assert.notEqual(
    providerCatalogIdentityCountMapDigest(left),
    providerCatalogIdentityCountMapDigest(changed),
  );
  assert.throws(() => providerCatalogIdentityCountMapDigest(
    new Map([["a".repeat(64), 0]]),
  ));
});

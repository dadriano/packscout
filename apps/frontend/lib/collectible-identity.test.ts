import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatCollectibleDescriptor,
  formatCollectibleIdentity,
  type CollectibleIdentityInput,
} from "./collectible-identity";

const collectible: CollectibleIdentityInput = {
  name: "Charizard",
  collectibleType: "card",
  year: 1999,
  brand: "Pokémon",
  setOrSeries: "Base Set",
  cardNumber: "4/102",
  referenceNumber: "Holo Rare",
  grade: "10",
  grader: "PSA",
};

test("uses one disambiguating collectible descriptor everywhere", () => {
  assert.equal(
    formatCollectibleDescriptor(collectible),
    "Card · 1999 · Pokémon · Base Set · Card #4/102 · Reference Holo Rare · PSA 10",
  );
  assert.equal(
    formatCollectibleIdentity(collectible),
    "Charizard · Card · 1999 · Pokémon · Base Set · Card #4/102 · Reference Holo Rare · PSA 10",
  );
});

test("retains a grader when no grade value is available", () => {
  assert.equal(
    formatCollectibleDescriptor({
      ...collectible,
      year: null,
      brand: null,
      setOrSeries: null,
      cardNumber: null,
      referenceNumber: null,
      grade: null,
    }),
    "Card · PSA",
  );
});

test("presents multiword collectible types as readable copy", () => {
  assert.match(
    formatCollectibleDescriptor({
      ...collectible,
      collectibleType: "sealed_product",
    }),
    /^Sealed Product ·/,
  );
});

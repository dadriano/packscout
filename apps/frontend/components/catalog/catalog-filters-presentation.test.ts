import assert from "node:assert/strict";
import { test } from "node:test";
import type { CategoryFacetOption } from "@packscout/contracts";
import {
  PRICE_FILTER_MAX_DOLLARS,
  PRICE_FILTER_MIN_DOLLARS,
  categoryFacetRows,
  clampPriceFilter,
  closerPriceThumb,
  formatFilterPrice,
  nestCategoryFacets,
  roundPriceFilterDollars,
  sliderValueFromPointer,
} from "./catalog-filters-presentation";

function facet(
  key: string,
  label: string,
  parentKey: string | null,
  depth: number,
): CategoryFacetOption {
  return {
    key,
    label,
    parentKey,
    depth,
    repackCount: 1,
    selected: false,
  };
}

test("category facets nest under their parent and keep independent roots", () => {
  const tradingCards = "20000000-0000-5000-8000-000000000001";
  const pokemon = "20000000-0000-5000-8000-000000000002";
  const sports = "20000000-0000-5000-8000-000000000003";
  const basketball = "20000000-0000-5000-8000-000000000004";
  const watches = "20000000-0000-5000-8000-000000000005";
  const tree = nestCategoryFacets([
    facet(basketball, "Basketball", sports, 2),
    facet(pokemon, "Pokemon", tradingCards, 1),
    facet(sports, "Sports", tradingCards, 1),
    facet(tradingCards, "Trading Cards", null, 0),
    facet(watches, "Watches", null, 0),
  ]);

  assert.deepEqual(
    tree.map(({ label, children }) => [
      label,
      children.map((child) => [
        child.label,
        child.children.map((grandchild) => grandchild.label),
      ]),
    ]),
    [
      ["Trading Cards", [["Pokemon", []], ["Sports", ["Basketball"]]]],
      ["Watches", []],
    ],
  );
  assert.deepEqual(
    categoryFacetRows([
      facet(basketball, "Basketball", sports, 2),
      facet(pokemon, "Pokemon", tradingCards, 1),
      facet(sports, "Sports", tradingCards, 1),
      facet(tradingCards, "Trading Cards", null, 0),
      facet(watches, "Watches", null, 0),
    ]).map(({ option, depth }) => [option.label, depth]),
    [
      ["Trading Cards", 0],
      ["Pokemon", 1],
      ["Sports", 1],
      ["Basketball", 2],
      ["Watches", 0],
    ],
  );
});

test("a subcategory whose parent is absent still appears as a root", () => {
  const tree = nestCategoryFacets([
    facet("20000000-0000-5000-8000-000000000004", "NBA", "20000000-0000-5000-8000-000000000003", 3),
  ]);
  assert.equal(tree[0]?.label, "NBA");
  assert.equal(tree[0]?.children.length, 0);
});

test("price slider labels and clamps stay on the $10–$12,000 range", () => {
  assert.equal(PRICE_FILTER_MIN_DOLLARS, 10);
  assert.equal(PRICE_FILTER_MAX_DOLLARS, 12_000);
  assert.equal(formatFilterPrice(10), "$10");
  assert.equal(formatFilterPrice(12_000), "$12,000");
  assert.equal(formatFilterPrice(613.28), "$613");
  assert.equal(roundPriceFilterDollars(613.28), 613);
  assert.equal(roundPriceFilterDollars(613.5), 614);
  assert.equal(roundPriceFilterDollars(3_153.75), 3_154);
  assert.equal(Number.isNaN(roundPriceFilterDollars(Number.NaN)), true);
  assert.equal(clampPriceFilter(5, "min", 100), 10);
  assert.equal(clampPriceFilter(20_000, "max", 50), 12_000);
  assert.equal(clampPriceFilter(613.78, "min", 1_000), 614);
  assert.equal(clampPriceFilter(80, "min", 40), 40);
  assert.equal(clampPriceFilter(20, "max", 40), 40);
});

test("the closer slider thumb is the one under the pointer", () => {
  assert.equal(closerPriceThumb(12, 10, 12_000), "min");
  assert.equal(closerPriceThumb(11_900, 10, 12_000), "max");
  assert.equal(sliderValueFromPointer(0, 0, 100), 10);
  assert.equal(sliderValueFromPointer(100, 0, 100), 12_000);
});

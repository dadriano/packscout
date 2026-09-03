import assert from "node:assert/strict";
import { test } from "node:test";
import type { CategoryFacetOption } from "@packscout/contracts";
import {
  PRICE_FILTER_MAX_DOLLARS,
  PRICE_FILTER_MIN_DOLLARS,
  PRICE_FILTER_SEGMENTS,
  PRICE_FILTER_SLIDER_MAX_INDEX,
  PRICE_FILTER_SLIDER_MIN_INDEX,
  PRICE_FILTER_SLIDER_VALUES,
  categoryFacetRows,
  clampPriceFilter,
  closerPriceThumb,
  focusPriceSliderThumb,
  formatFilterPrice,
  nestCategoryFacets,
  priceSliderIndexForBound,
  priceSliderIndexFromValue,
  priceSliderIndexFromKeyboard,
  priceSliderPercent,
  priceSliderValueFromIndex,
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

test("price slider labels and clamps stay on the $1–$12,000 range", () => {
  assert.equal(PRICE_FILTER_MIN_DOLLARS, 1);
  assert.equal(PRICE_FILTER_MAX_DOLLARS, 12_000);
  assert.equal(formatFilterPrice(1), "$1");
  assert.equal(formatFilterPrice(12_000), "$12,000");
  assert.equal(formatFilterPrice(613.28), "$613");
  assert.equal(roundPriceFilterDollars(613.28), 613);
  assert.equal(roundPriceFilterDollars(613.5), 614);
  assert.equal(roundPriceFilterDollars(3_153.75), 3_154);
  assert.equal(Number.isNaN(roundPriceFilterDollars(Number.NaN)), true);
  assert.equal(clampPriceFilter(-5, "min", 100), 1);
  assert.equal(clampPriceFilter(20_000, "max", 50), 12_000);
  assert.equal(clampPriceFilter(613.78, "min", 1_000), 614);
  assert.equal(clampPriceFilter(80, "min", 40), 40);
  assert.equal(clampPriceFilter(20, "max", 40), 40);
});

test("the shared slider ladder applies every requested segment exactly once", () => {
  assert.deepEqual(PRICE_FILTER_SEGMENTS, [
    { minimum: 1, maximum: 5, step: 1 },
    { minimum: 5, maximum: 100, step: 5 },
    { minimum: 100, maximum: 500, step: 25 },
    { minimum: 500, maximum: 1_000, step: 50 },
    { minimum: 1_000, maximum: 5_000, step: 250 },
    { minimum: 5_000, maximum: 12_000, step: 500 },
  ]);

  const expectedBands = [
    { first: 1, last: 5, step: 1 },
    { first: 10, last: 100, step: 5 },
    { first: 125, last: 500, step: 25 },
    { first: 550, last: 1_000, step: 50 },
    { first: 1_250, last: 5_000, step: 250 },
    { first: 5_500, last: 12_000, step: 500 },
  ] as const;
  const expectedValues = expectedBands.flatMap(({ first, last, step }) => {
    const values: number[] = [];
    for (let value = first; value <= last; value += step) values.push(value);
    return values;
  });

  assert.deepEqual(PRICE_FILTER_SLIDER_VALUES, expectedValues);
  assert.equal(new Set(PRICE_FILTER_SLIDER_VALUES).size, PRICE_FILTER_SLIDER_VALUES.length);
  assert.equal(PRICE_FILTER_SLIDER_VALUES.length, 80);
  assert.equal(PRICE_FILTER_SLIDER_MAX_INDEX, 79);
});

test("both slider handles round-trip every discrete price", () => {
  PRICE_FILTER_SLIDER_VALUES.forEach((value, index) => {
    assert.equal(priceSliderIndexFromValue(value), index, `index for $${value}`);
    assert.equal(priceSliderValueFromIndex(index), value, `value at index ${index}`);
  });
  assert.equal(priceSliderValueFromIndex(-20), 1);
  assert.equal(priceSliderValueFromIndex(200), 12_000);
  assert.equal(priceSliderValueFromIndex(Number.NaN), 1);
  assert.equal(priceSliderIndexFromValue(613), priceSliderIndexFromValue(600));
  assert.equal(priceSliderIndexFromValue(625), priceSliderIndexFromValue(600));
  assert.equal(priceSliderIndexFromValue(626), priceSliderIndexFromValue(650));
});

test("slider keyboard controls step the discrete ladder and honor its ends", () => {
  assert.equal(priceSliderIndexFromKeyboard("ArrowRight", 0), 1);
  assert.equal(priceSliderIndexFromKeyboard("ArrowUp", 4), 5);
  assert.equal(priceSliderIndexFromKeyboard("ArrowLeft", 24), 23);
  assert.equal(priceSliderIndexFromKeyboard("ArrowDown", 79), 78);
  assert.equal(priceSliderIndexFromKeyboard("Home", 52), 0);
  assert.equal(priceSliderIndexFromKeyboard("End", 12), 79);
  assert.equal(priceSliderIndexFromKeyboard("ArrowLeft", 0), 0);
  assert.equal(priceSliderIndexFromKeyboard("ArrowRight", 79), 79);
  assert.equal(priceSliderIndexFromKeyboard("PageUp", 12), null);
});

test("invalid numeric fields recover keyboard sliders from the visible boundary", () => {
  const minimumIndex = priceSliderIndexForBound(Number.NaN, "min");
  const maximumIndex = priceSliderIndexForBound(Number.NaN, "max");
  assert.equal(minimumIndex, PRICE_FILTER_SLIDER_MIN_INDEX);
  assert.equal(maximumIndex, PRICE_FILTER_SLIDER_MAX_INDEX);
  assert.equal(priceSliderIndexFromKeyboard("ArrowRight", minimumIndex), 1);
  assert.equal(
    priceSliderIndexFromKeyboard("ArrowLeft", maximumIndex),
    PRICE_FILTER_SLIDER_MAX_INDEX - 1,
  );
});

test("a finite slider thumb survives an empty peer numeric field", () => {
  assert.equal(clampPriceFilter(500, "min", Number.NaN), 500);
  assert.equal(clampPriceFilter(5_000, "max", Number.NaN), 5_000);
  assert.equal(clampPriceFilter(50_000, "min", Number.NaN), PRICE_FILTER_MAX_DOLLARS);
  assert.equal(clampPriceFilter(-50, "max", Number.NaN), PRICE_FILTER_MIN_DOLLARS);
});

test("track selection focuses only the chosen slider thumb without scrolling", () => {
  const focusCalls: Array<readonly ["min" | "max", FocusOptions | undefined]> = [];
  const minimum = {
    focus: (options?: FocusOptions) => focusCalls.push(["min", options]),
  };
  const maximum = {
    focus: (options?: FocusOptions) => focusCalls.push(["max", options]),
  };

  focusPriceSliderThumb("max", minimum, maximum);
  focusPriceSliderThumb("min", minimum, maximum);
  assert.deepEqual(focusCalls, [
    ["max", { preventScroll: true }],
    ["min", { preventScroll: true }],
  ]);
});

test("pointer mapping gives low prices substantial track space", () => {
  for (const value of [1, 5, 100, 500, 1_000, 5_000, 12_000]) {
    const index = priceSliderIndexFromValue(value);
    assert.equal(
      sliderValueFromPointer((index / PRICE_FILTER_SLIDER_MAX_INDEX) * 100, 0, 100),
      value,
    );
  }
  assert.ok(priceSliderPercent(100) > 29);
  assert.ok(priceSliderPercent(100) < 30);
  assert.ok(priceSliderPercent(1_000) > 62);
  assert.ok(priceSliderPercent(1_000) < 63);
  assert.equal(sliderValueFromPointer(-10, 0, 100), 1);
  assert.equal(sliderValueFromPointer(100, 0, 100), 12_000);
  assert.equal(sliderValueFromPointer(20, 0, 0), 1);
});

test("the closer slider thumb is selected in segmented track space", () => {
  assert.equal(closerPriceThumb(2, 1, 12_000), "min");
  assert.equal(closerPriceThumb(11_500, 1, 12_000), "max");
  assert.equal(closerPriceThumb(100, 1, 500), "max");
});

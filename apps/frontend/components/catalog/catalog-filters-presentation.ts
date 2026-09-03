import {
  PUBLIC_REPACK_PRICE_MAX_MINOR,
  PUBLIC_REPACK_PRICE_MIN_MINOR,
  type CategoryFacetOption,
  type ContextualRepackFacets,
} from "@packscout/contracts";

export const PRICE_FILTER_MIN_DOLLARS = PUBLIC_REPACK_PRICE_MIN_MINOR / 100;
export const PRICE_FILTER_MAX_DOLLARS = PUBLIC_REPACK_PRICE_MAX_MINOR / 100;

export const PRICE_FILTER_SEGMENTS = Object.freeze([
  Object.freeze({ minimum: 1, maximum: 5, step: 1 }),
  Object.freeze({ minimum: 5, maximum: 100, step: 5 }),
  Object.freeze({ minimum: 100, maximum: 500, step: 25 }),
  Object.freeze({ minimum: 500, maximum: 1_000, step: 50 }),
  Object.freeze({ minimum: 1_000, maximum: 5_000, step: 250 }),
  Object.freeze({ minimum: 5_000, maximum: 12_000, step: 500 }),
]);

function buildPriceSliderValues(): readonly number[] {
  const values: number[] = [];
  for (const segment of PRICE_FILTER_SEGMENTS) {
    const start = values.at(-1) === segment.minimum
      ? segment.minimum + segment.step
      : segment.minimum;
    for (let value = start; value <= segment.maximum; value += segment.step) {
      values.push(value);
    }
  }
  return Object.freeze(values);
}

export const PRICE_FILTER_SLIDER_VALUES = buildPriceSliderValues();
export const PRICE_FILTER_SLIDER_MIN_INDEX = 0;
export const PRICE_FILTER_SLIDER_MAX_INDEX = PRICE_FILTER_SLIDER_VALUES.length - 1;

export type NestedCategoryFacet = CategoryFacetOption & {
  readonly children: readonly NestedCategoryFacet[];
};

export type CategoryFacetRow = Readonly<{
  option: CategoryFacetOption;
  depth: number;
}>;

type MutableNestedCategory = CategoryFacetOption & {
  children: MutableNestedCategory[];
};

export function nestCategoryFacets(
  facets: ContextualRepackFacets["categories"],
): NestedCategoryFacet[] {
  const nodes = new Map<string, MutableNestedCategory>(
    facets.map((facet) => [facet.key, { ...facet, children: [] }]),
  );
  const roots: MutableNestedCategory[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentKey === null ? undefined : nodes.get(node.parentKey);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  sortCategoryNodes(roots);
  return roots;
}

export function categoryFacetRows(
  facets: ContextualRepackFacets["categories"],
): CategoryFacetRow[] {
  const rows: CategoryFacetRow[] = [];
  function walk(nodes: readonly NestedCategoryFacet[], depth: number) {
    for (const node of nodes) {
      rows.push({ option: node, depth });
      walk(node.children, depth + 1);
    }
  }
  walk(nestCategoryFacets(facets), 0);
  return rows;
}

export function formatFilterPrice(dollars: number): string {
  if (!Number.isFinite(dollars)) return "";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(roundPriceFilterDollars(dollars));
}

export function roundPriceFilterDollars(value: number): number {
  return Number.isFinite(value) ? Math.round(value) : Number.NaN;
}

export function closerPriceThumb(
  pointerValue: number,
  minimum: number,
  maximum: number,
): "min" | "max" {
  const pointerIndex = priceSliderIndexFromValue(pointerValue);
  const minimumIndex = priceSliderIndexFromValue(minimum);
  const maximumIndex = priceSliderIndexFromValue(maximum);
  return Math.abs(pointerIndex - minimumIndex) <= Math.abs(pointerIndex - maximumIndex)
    ? "min"
    : "max";
}

type FocusablePriceRange = Readonly<{
  focus: (options?: FocusOptions) => void;
}>;

export function focusPriceSliderThumb(
  thumb: "min" | "max",
  minimum: FocusablePriceRange | null,
  maximum: FocusablePriceRange | null,
): void {
  const selectedRange = thumb === "min" ? minimum : maximum;
  selectedRange?.focus({ preventScroll: true });
}

export function priceSliderValueFromIndex(index: number): number {
  if (!Number.isFinite(index)) return PRICE_FILTER_MIN_DOLLARS;
  const boundedIndex = Math.min(
    PRICE_FILTER_SLIDER_MAX_INDEX,
    Math.max(PRICE_FILTER_SLIDER_MIN_INDEX, Math.round(index)),
  );
  return PRICE_FILTER_SLIDER_VALUES[boundedIndex] ?? PRICE_FILTER_MIN_DOLLARS;
}

export function priceSliderIndexFromKeyboard(
  key: string,
  currentIndex: number,
): number | null {
  const boundedIndex = Math.min(
    PRICE_FILTER_SLIDER_MAX_INDEX,
    Math.max(PRICE_FILTER_SLIDER_MIN_INDEX, Math.round(currentIndex)),
  );
  switch (key) {
    case "ArrowLeft":
    case "ArrowDown":
      return Math.max(PRICE_FILTER_SLIDER_MIN_INDEX, boundedIndex - 1);
    case "ArrowRight":
    case "ArrowUp":
      return Math.min(PRICE_FILTER_SLIDER_MAX_INDEX, boundedIndex + 1);
    case "Home":
      return PRICE_FILTER_SLIDER_MIN_INDEX;
    case "End":
      return PRICE_FILTER_SLIDER_MAX_INDEX;
    default:
      return null;
  }
}

export function priceSliderIndexFromValue(value: number): number {
  if (!Number.isFinite(value) || value <= PRICE_FILTER_MIN_DOLLARS) {
    return PRICE_FILTER_SLIDER_MIN_INDEX;
  }
  if (value >= PRICE_FILTER_MAX_DOLLARS) {
    return PRICE_FILTER_SLIDER_MAX_INDEX;
  }

  let low = PRICE_FILTER_SLIDER_MIN_INDEX;
  let high = PRICE_FILTER_SLIDER_MAX_INDEX;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = PRICE_FILTER_SLIDER_VALUES[middle] ?? PRICE_FILTER_MIN_DOLLARS;
    if (candidate === value) return middle;
    if (candidate < value) low = middle + 1;
    else high = middle - 1;
  }

  const lower = PRICE_FILTER_SLIDER_VALUES[high] ?? PRICE_FILTER_MIN_DOLLARS;
  const upper = PRICE_FILTER_SLIDER_VALUES[low] ?? PRICE_FILTER_MAX_DOLLARS;
  return value - lower <= upper - value ? high : low;
}

export function priceSliderIndexForBound(
  value: number,
  bound: "min" | "max",
): number {
  const fallback = bound === "min"
    ? PRICE_FILTER_MIN_DOLLARS
    : PRICE_FILTER_MAX_DOLLARS;
  return priceSliderIndexFromValue(Number.isFinite(value) ? value : fallback);
}

export function priceSliderPercent(value: number): number {
  return (priceSliderIndexFromValue(value) / PRICE_FILTER_SLIDER_MAX_INDEX) * 100;
}

export function sliderValueFromPointer(
  clientX: number,
  trackLeft: number,
  trackWidth: number,
): number {
  if (trackWidth <= 0) return PRICE_FILTER_MIN_DOLLARS;
  const ratio = Math.min(1, Math.max(0, (clientX - trackLeft) / trackWidth));
  return priceSliderValueFromIndex(ratio * PRICE_FILTER_SLIDER_MAX_INDEX);
}

export function clampPriceFilter(value: number, bound: "min" | "max", other: number): number {
  if (!Number.isFinite(value)) return bound === "min" ? PRICE_FILTER_MIN_DOLLARS : PRICE_FILTER_MAX_DOLLARS;
  const rounded = roundPriceFilterDollars(value);
  const clamped = Math.min(
    PRICE_FILTER_MAX_DOLLARS,
    Math.max(PRICE_FILTER_MIN_DOLLARS, rounded),
  );
  return bound === "min" ? Math.min(clamped, other) : Math.max(clamped, other);
}

function sortCategoryNodes(nodes: MutableNestedCategory[]) {
  nodes.sort(
    (left, right) => left.label.localeCompare(right.label) || left.key.localeCompare(right.key),
  );
  for (const node of nodes) sortCategoryNodes(node.children);
}

import {
  PUBLIC_REPACK_PRICE_MAX_MINOR,
  PUBLIC_REPACK_PRICE_MIN_MINOR,
  type CategoryFacetOption,
  type ContextualRepackFacets,
} from "@packscout/contracts";

export const PRICE_FILTER_MIN_DOLLARS = PUBLIC_REPACK_PRICE_MIN_MINOR / 100;
export const PRICE_FILTER_MAX_DOLLARS = PUBLIC_REPACK_PRICE_MAX_MINOR / 100;

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
  const wholeDollars = dollars % 1 === 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: wholeDollars ? 0 : 2,
    maximumFractionDigits: wholeDollars ? 0 : 2,
  }).format(dollars);
}

export function closerPriceThumb(
  pointerValue: number,
  minimum: number,
  maximum: number,
): "min" | "max" {
  return Math.abs(pointerValue - minimum) <= Math.abs(pointerValue - maximum) ? "min" : "max";
}

export function sliderValueFromPointer(
  clientX: number,
  trackLeft: number,
  trackWidth: number,
): number {
  if (trackWidth <= 0) return PRICE_FILTER_MIN_DOLLARS;
  const ratio = Math.min(1, Math.max(0, (clientX - trackLeft) / trackWidth));
  return (
    PRICE_FILTER_MIN_DOLLARS +
    ratio * (PRICE_FILTER_MAX_DOLLARS - PRICE_FILTER_MIN_DOLLARS)
  );
}

export function clampPriceFilter(value: number, bound: "min" | "max", other: number): number {
  if (!Number.isFinite(value)) return bound === "min" ? PRICE_FILTER_MIN_DOLLARS : PRICE_FILTER_MAX_DOLLARS;
  const clamped = Math.min(
    PRICE_FILTER_MAX_DOLLARS,
    Math.max(PRICE_FILTER_MIN_DOLLARS, value),
  );
  return bound === "min" ? Math.min(clamped, other) : Math.max(clamped, other);
}

function sortCategoryNodes(nodes: MutableNestedCategory[]) {
  nodes.sort(
    (left, right) => left.label.localeCompare(right.label) || left.key.localeCompare(right.key),
  );
  for (const node of nodes) sortCategoryNodes(node.children);
}
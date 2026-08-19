import {
  dashboardQueryInputSchema,
  type DashboardQueryInput,
  type ListPublicRepacksInput,
} from "@packscout/contracts";
import { parseCatalogQueryState } from "./catalog-query-state.client";

export type NextSearchParams = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

export type RouteQueryResult<T> =
  | { readonly ok: true; readonly query: T }
  | { readonly ok: false; readonly message: string };

export function toUrlSearchParams(input: NextSearchParams): URLSearchParams {
  const result = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (Array.isArray(value)) {
      for (const item of value) result.append(key, item);
    } else if (typeof value === "string") {
      result.append(key, value);
    }
  }
  return result;
}

export function parseAllRepacksRouteQuery(
  input: NextSearchParams,
): RouteQueryResult<ListPublicRepacksInput> {
  const parsed = parseCatalogQueryState(toUrlSearchParams(input));
  return parsed.ok
    ? { ok: true, query: parsed.query }
    : { ok: false, message: parsed.message };
}

export function parseDashboardRouteQuery(
  input: NextSearchParams,
): RouteQueryResult<DashboardQueryInput> {
  const allowed = new Set([
    "vendor",
    "category",
    "collectibleType",
    "availability",
    "minPrice",
    "maxPrice",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    return { ok: false, message: "This Dashboard link contains unsupported query state." };
  }
  const parsed = parseCatalogQueryState(toUrlSearchParams(input));
  if (!parsed.ok) return parsed;
  const dashboard = dashboardQueryInputSchema.safeParse({
    filters: parsed.query.filters,
    selectedPublicRepackId: null,
  });
  return dashboard.success
    ? { ok: true, query: dashboard.data }
    : { ok: false, message: "This Dashboard link cannot be applied." };
}

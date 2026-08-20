import {
  dashboardQueryInputSchema,
  type DashboardQueryInput,
  type ListPublicRepacksInput,
} from "@packscout/contracts";
import { parseCatalogQueryState } from "./catalog-query-state.client";
import {
  DASHBOARD_PROVIDERS,
  parseDashboardProviderQuery,
  type DashboardProvider,
} from "./provider-banner";

export type NextSearchParams = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

export type RouteQueryResult<T> =
  | { readonly ok: true; readonly query: T }
  | { readonly ok: false; readonly message: string };

export type DashboardRouteQueryResult =
  | Readonly<{
      ok: true;
      provider: DashboardProvider | null;
      query: DashboardQueryInput;
    }>
  | Readonly<{
      ok: false;
      provider: DashboardProvider | null;
      message: string;
    }>;

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
): DashboardRouteQueryResult {
  const parameters = toUrlSearchParams(input);
  const providerResult = parseDashboardProviderQuery(parameters);
  if (!providerResult.ok) {
    return {
      ok: false,
      provider: null,
      message: "This Dashboard link contains an invalid partner banner flag.",
    };
  }
  const provider = providerResult.provider;
  const allowed = new Set([
    "vendor",
    "category",
    "collectibleType",
    "availability",
    "minPrice",
    "maxPrice",
    ...DASHBOARD_PROVIDERS,
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    return {
      ok: false,
      provider,
      message: "This Dashboard link contains unsupported query state.",
    };
  }
  for (const candidate of DASHBOARD_PROVIDERS) parameters.delete(candidate);
  const parsed = parseCatalogQueryState(parameters);
  if (!parsed.ok) return { ...parsed, provider };
  const dashboard = dashboardQueryInputSchema.safeParse({
    filters: parsed.query.filters,
    selectedPublicRepackId: null,
  });
  return dashboard.success
    ? { ok: true, provider, query: dashboard.data }
    : {
        ok: false,
        provider,
        message: "This Dashboard link cannot be applied.",
      };
}

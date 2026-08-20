export const DASHBOARD_PROVIDERS = ["underdog", "collector"] as const;

export type DashboardProvider = (typeof DASHBOARD_PROVIDERS)[number];
export type DashboardHref = "/" | `/?${DashboardProvider}`;

export type ProviderBannerDefinition = Readonly<{
  dashboardHref: `/?${DashboardProvider}`;
  displayName: string;
  destinationHref: `https://${string}`;
  imageSrc: `/partner-banners/${string}.webp`;
  linkLabel: string;
}>;

export type DashboardProviderQueryResult =
  | Readonly<{ ok: true; provider: DashboardProvider | null }>
  | Readonly<{ ok: false }>;

const PROVIDER_BANNERS = {
  underdog: {
    dashboardHref: "/?underdog",
    displayName: "Underdog",
    destinationHref: "https://www.underdogsports.com/",
    imageSrc: "/partner-banners/underdog.webp",
    linkLabel: "Explore Underdog, a verified PackScout partner",
  },
  collector: {
    dashboardHref: "/?collector",
    displayName: "Collector Crypt",
    destinationHref: "https://collectorcrypt.com/",
    imageSrc: "/partner-banners/collector-crypt.webp",
    linkLabel: "Explore Collector Crypt, a verified PackScout partner",
  },
} as const satisfies Record<DashboardProvider, ProviderBannerDefinition>;

export function dashboardHrefFor(
  provider?: DashboardProvider | null,
): DashboardHref {
  return provider ? PROVIDER_BANNERS[provider].dashboardHref : "/";
}

export function providerBannerFor(
  provider: DashboardProvider,
): ProviderBannerDefinition {
  return PROVIDER_BANNERS[provider];
}

export function parseDashboardProviderQuery(
  parameters: URLSearchParams,
): DashboardProviderQueryResult {
  const selected = DASHBOARD_PROVIDERS.filter((provider) =>
    parameters.has(provider),
  );
  if (selected.length === 0) return { ok: true, provider: null };
  if (selected.length !== 1) return { ok: false };

  const provider = selected[0];
  const values = parameters.getAll(provider);
  if (values.length !== 1 || values[0] !== "") {
    return { ok: false };
  }
  return { ok: true, provider };
}

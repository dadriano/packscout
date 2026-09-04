import { formatCollectibleDescriptor } from "./collectible-identity";
import { presentPackAvailability } from "./pack-availability-presentation";
import {
  formatWatchlistRepackEvSummary,
  type WatchlistRepackEv,
} from "./packscout-ev-presentation";

export const WATCHLIST_PATH = "/watchlist" as const;
export const WATCHLIST_CHASE_TAB = "chase-cards" as const;

export type WatchlistTab = "repacks" | "chase-cards";

export type WatchlistAuthStatus =
  | "unavailable"
  | "loading"
  | "signed_out"
  | "signed_in"
  | "error";

export type WatchlistRepackRow = Readonly<{
  publicRepackId: string;
  savedAt: string;
  catalogStatus: "resolved" | "unavailable";
  openable: boolean;
  repack: Readonly<{
    name: string;
    vendorDisplayName: string;
    availability: "available" | "unavailable" | "unknown" | "sold_out";
    estimatedEv: WatchlistRepackEv | null;
  }> | null;
}>;

export type WatchlistCollectibleRow = Readonly<{
  publicCollectibleId: string;
  savedAt: string;
  catalogStatus: "resolved" | "unavailable";
  openable: boolean;
  collectible: Readonly<{
    name: string;
    collectibleType:
      | "card"
      | "watch"
      | "coin"
      | "sealed_product"
      | "memorabilia"
      | "other";
    year: number | null;
    brand: string | null;
    setOrSeries: string | null;
    cardNumber: string | null;
    referenceNumber: string | null;
    grade: string | null;
    grader: string | null;
  }> | null;
}>;

export type OwnerWatchlist = Readonly<{
  savedRepacks: readonly WatchlistRepackRow[];
  savedCollectibles: readonly WatchlistCollectibleRow[];
  savedRepackCount: number;
  savedCollectibleCount: number;
}>;

export type WatchlistFrame =
  | Readonly<{ kind: "sign_in" }>
  | Readonly<{ kind: "checking" }>
  | Readonly<{ kind: "unavailable"; copy: string }>
  | Readonly<{ kind: "error" }>
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; watchlist: OwnerWatchlist }>;

export function parseWatchlistTab(
  value: string | readonly string[] | null | undefined,
): WatchlistTab {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === WATCHLIST_CHASE_TAB ? "chase-cards" : "repacks";
}

export function watchlistHref(tab: WatchlistTab = "repacks"): string {
  return tab === "chase-cards"
    ? `${WATCHLIST_PATH}?tab=${WATCHLIST_CHASE_TAB}`
    : WATCHLIST_PATH;
}

export function watchlistNavVisible(input: Readonly<{
  authStatus: WatchlistAuthStatus;
  accountSavingAvailable: boolean;
}>): boolean {
  return input.authStatus === "signed_in" && input.accountSavingAvailable;
}

export function watchlistTabAccessibleName(
  tab: WatchlistTab,
  count: number,
): string {
  const label = tab === "repacks" ? "Repacks" : "Chase cards";
  return `${label}, ${count}`;
}

export function presentWatchlistUnavailableCopy(
  authStatus: WatchlistAuthStatus,
  accountNotice: string | null,
): string {
  if (accountNotice !== null) return accountNotice;
  if (authStatus === "unavailable") {
    return "Account saving is not configured for this environment.";
  }
  if (authStatus === "error") {
    return "Your session could not be verified. Sign out and try again.";
  }
  return "Watchlist cannot load right now.";
}

export function presentWatchlistFrame(input: Readonly<{
  authStatus: WatchlistAuthStatus;
  accountSavingAvailable: boolean;
  accountNotice: string | null;
  loading: boolean;
  failed: boolean;
  watchlist: OwnerWatchlist | null;
}>): WatchlistFrame {
  if (input.authStatus === "signed_out") return { kind: "sign_in" };
  if (input.authStatus === "loading") return { kind: "checking" };
  if (input.authStatus === "unavailable" || input.authStatus === "error") {
    return {
      kind: "unavailable",
      copy: presentWatchlistUnavailableCopy(
        input.authStatus,
        input.accountNotice,
      ),
    };
  }
  if (!input.accountSavingAvailable) {
    if (input.accountNotice !== null) {
      return {
        kind: "unavailable",
        copy: presentWatchlistUnavailableCopy(
          input.authStatus,
          input.accountNotice,
        ),
      };
    }
    return { kind: "checking" };
  }
  if (input.failed) return { kind: "error" };
  if (input.loading || input.watchlist === null) return { kind: "loading" };
  return { kind: "ready", watchlist: input.watchlist };
}

export const WATCHLIST_SIGN_IN_COPY =
  "Sign in to see the repacks and chase cards you saved." as const;

export const WATCHLIST_LOAD_ERROR_COPY =
  "We couldn't load your Watchlist. Try again." as const;

export const WATCHLIST_EMPTY_REPACKS_COPY =
  "You have not saved a repack yet. Save one from Dashboard or All Repacks." as const;

export const WATCHLIST_EMPTY_CHASE_CARDS_COPY =
  "You have not saved a chase card yet. Save one from All Repacks desired-chase search." as const;

export const WATCHLIST_UNAVAILABLE_LABEL = "No longer in the catalog" as const;

export function presentWatchlistRepackRow(row: WatchlistRepackRow): Readonly<{
  title: string;
  detail: string | null;
  stale: boolean;
}> {
  if (row.catalogStatus === "unavailable" || row.repack === null) {
    return {
      title: row.publicRepackId,
      detail: WATCHLIST_UNAVAILABLE_LABEL,
      stale: true,
    };
  }
  const availability = presentPackAvailability(row.repack.availability).label;
  const ev =
    row.repack.estimatedEv === null
      ? null
      : formatWatchlistRepackEvSummary(row.repack.estimatedEv);
  return {
    title: row.repack.name,
    detail: [row.repack.vendorDisplayName, availability, ev]
      .filter((value): value is string => value !== null && value !== "")
      .join(" · "),
    stale: false,
  };
}

export function presentWatchlistCollectibleRow(
  row: WatchlistCollectibleRow,
): Readonly<{
  title: string;
  detail: string | null;
  stale: boolean;
}> {
  if (row.catalogStatus === "unavailable" || row.collectible === null) {
    return {
      title: row.publicCollectibleId,
      detail: WATCHLIST_UNAVAILABLE_LABEL,
      stale: true,
    };
  }
  const descriptor = formatCollectibleDescriptor(row.collectible);
  return {
    title: row.collectible.name,
    detail: descriptor.length > 0 ? descriptor : null,
    stale: false,
  };
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { usePackScoutAuth } from "@/components/auth/AuthContext.client";
import { useAccountSavingAvailable } from "@/components/auth/SavedItemsContext.client";
import { resolveGlobalDestination } from "@/lib/shell-navigation.client";
import { WATCHLIST_PATH, watchlistNavVisible } from "@/lib/watchlist";

export function PrimaryNavigation() {
  const pathname = usePathname();
  const destination = resolveGlobalDestination(pathname);
  const auth = usePackScoutAuth();
  const accountSavingAvailable = useAccountSavingAvailable();
  const showWatchlist = watchlistNavVisible({
    authStatus: auth.status,
    accountSavingAvailable,
  });

  return (
    <nav className="primary-navigation" aria-label="Primary navigation">
      <Link
        aria-current={destination === "dashboard" ? "page" : undefined}
        className="primary-navigation__link"
        href="/"
      >
        Dashboard
      </Link>
      {showWatchlist ? (
        <Link
          aria-current={destination === "watchlist" ? "page" : undefined}
          className="primary-navigation__link"
          href={WATCHLIST_PATH}
        >
          Watchlist
        </Link>
      ) : null}
      <Link
        aria-current={destination === "learn" ? "page" : undefined}
        className="primary-navigation__link"
        href="/learn"
      >
        Learn
      </Link>
    </nav>
  );
}

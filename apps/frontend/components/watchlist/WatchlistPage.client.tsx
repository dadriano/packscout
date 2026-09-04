"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useAction } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "../../../../convex/_generated/api";
import { usePackScoutAuth } from "@/components/auth/AuthContext.client";
import {
  useAccountNotice,
  useAccountSavingAvailable,
  useAccountSavingFailed,
} from "@/components/auth/SavedItemsContext.client";
import {
  decideIdentityHandoff,
  IDENTITY_HANDOFF_MAX_ATTEMPTS,
  IDENTITY_HANDOFF_TIMEOUT_MS,
  readBrowserIdentityCookie,
  readLastIdentityCookieWrite,
  subscribeToIdentityCookieWrites,
} from "@/lib/identity-cookie";
import {
  presentWatchlistCollectibleRow,
  presentWatchlistFrame,
  presentWatchlistRepackRow,
  watchlistCanLoadOwnerRead,
  watchlistHref,
  watchlistTabAccessibleName,
  type OwnerWatchlist,
  type WatchlistTab,
  WATCHLIST_EMPTY_CHASE_CARDS_COPY,
  WATCHLIST_EMPTY_REPACKS_COPY,
  WATCHLIST_LOAD_ERROR_COPY,
  WATCHLIST_SIGN_IN_COPY,
} from "@/lib/watchlist";
import styles from "./Watchlist.module.css";

const noIdentityCookieWrite = () => null;

export function WatchlistPage({
  tab,
  completeSignInHandoff,
}: Readonly<{
  tab: WatchlistTab;
  completeSignInHandoff: boolean;
}>) {
  const auth = usePackScoutAuth();
  const router = useRouter();
  const accountNotice = useAccountNotice();
  const accountSavingAvailable = useAccountSavingAvailable();
  const accountSavingFailed = useAccountSavingFailed();
  const canLoadOwnerWatchlist = watchlistCanLoadOwnerRead({
    authStatus: auth.status,
    accountNotice,
    accountSavingAvailable,
    accountSavingFailed,
  });

  return (
    <>
      {completeSignInHandoff ? <WatchlistSignInHandoff /> : null}
      {canLoadOwnerWatchlist ? (
        <WatchlistOwnerPage tab={tab} />
      ) : (
        <WatchlistShell chaseCount={0} repackCount={0} tab={tab}>
          <WatchlistAuthFrame
            accountNotice={accountNotice}
            accountSavingAvailable={accountSavingAvailable}
            completeSignInHandoff={completeSignInHandoff}
            onContinue={() => router.refresh()}
            onSignIn={() => auth.login()}
            status={auth.status}
          />
        </WatchlistShell>
      )}
    </>
  );
}

function WatchlistSignInHandoff() {
  const auth = usePackScoutAuth();
  const router = useRouter();
  const lastWrite = useSyncExternalStore(
    subscribeToIdentityCookieWrites,
    readLastIdentityCookieWrite,
    noIdentityCookieWrite,
  );
  const mountedAtMs = useRef(0);
  const armedAtMs = useRef(0);
  const attempted = useRef<readonly string[]>([]);
  const surrendered = useRef(false);
  const armed = auth.status === "signed_in";

  useEffect(() => {
    if (mountedAtMs.current === 0) mountedAtMs.current = Date.now();
  }, []);

  useEffect(() => {
    if (!armed || surrendered.current) return;
    if (armedAtMs.current === 0) armedAtMs.current = Date.now();
    const decision = decideIdentityHandoff({
      cookieToken: readBrowserIdentityCookie(),
      lastWrite,
      mountedAtMs: mountedAtMs.current,
      armedAtMs: armedAtMs.current,
      nowMs: Date.now(),
      timeoutMs: IDENTITY_HANDOFF_TIMEOUT_MS,
      attemptedTokens: attempted.current,
      maxAttempts: IDENTITY_HANDOFF_MAX_ATTEMPTS,
    });
    if (decision.kind === "give_up") {
      surrendered.current = true;
      return;
    }
    if (decision.kind !== "hand_off") return;
    attempted.current = [...attempted.current, decision.token];
    router.refresh();
  }, [armed, lastWrite, router]);

  return null;
}

function WatchlistAuthFrame({
  status,
  accountSavingAvailable,
  accountNotice,
  completeSignInHandoff,
  onSignIn,
  onContinue,
}: Readonly<{
  status: "unavailable" | "loading" | "signed_out" | "signed_in" | "error";
  accountSavingAvailable: boolean;
  accountNotice: string | null;
  completeSignInHandoff: boolean;
  onSignIn: () => void;
  onContinue: () => void;
}>) {
  const frame = presentWatchlistFrame({
    authStatus: status,
    accountSavingAvailable,
    accountNotice,
    loading: false,
    failed: false,
    watchlist: null,
  });
  const continueAfterSignIn =
    completeSignInHandoff && status === "signed_in";

  if (frame.kind === "sign_in") {
    return (
      <div className={styles.actions}>
        <p className={styles.copy}>{WATCHLIST_SIGN_IN_COPY}</p>
        <button className="route-action" onClick={onSignIn} type="button">
          Sign in
        </button>
      </div>
    );
  }

  if (frame.kind === "unavailable") {
    return <p className={styles.copy}>{frame.copy}</p>;
  }

  return (
    <div className={styles.actions}>
      <p className={styles.copy} role="status">
        Loading your Watchlist…
      </p>
      {continueAfterSignIn ? (
        <button className="route-action" onClick={onContinue} type="button">
          Continue
        </button>
      ) : null}
    </div>
  );
}

function WatchlistOwnerPage({ tab }: Readonly<{ tab: WatchlistTab }>) {
  const getOwnerWatchlist = useAction(api.savedItems.getOwnerWatchlist);
  const [watchlist, setWatchlist] = useState<OwnerWatchlist | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const requestId = useRef(0);

  const fetchWatchlist = useCallback(
    (id: number) => {
      void getOwnerWatchlist({})
        .then((payload) => {
          if (requestId.current !== id) return;
          setWatchlist(payload);
          setFailed(false);
          setLoading(false);
        })
        .catch(() => {
          if (requestId.current !== id) return;
          setWatchlist(null);
          setFailed(true);
          setLoading(false);
        });
    },
    [getOwnerWatchlist],
  );

  useEffect(() => {
    const id = requestId.current + 1;
    requestId.current = id;
    fetchWatchlist(id);
    return () => {
      requestId.current += 1;
    };
  }, [fetchWatchlist]);

  function retry() {
    setLoading(true);
    setFailed(false);
    const id = requestId.current + 1;
    requestId.current = id;
    fetchWatchlist(id);
  }

  const frame = presentWatchlistFrame({
    authStatus: "signed_in",
    accountSavingAvailable: true,
    accountNotice: null,
    loading,
    failed,
    watchlist,
  });

  return (
    <WatchlistShell
      chaseCount={watchlist?.savedCollectibleCount ?? 0}
      repackCount={watchlist?.savedRepackCount ?? 0}
      tab={tab}
    >
      {frame.kind === "error" ? (
        <div className={styles.actions}>
          <p className={styles.copy}>{WATCHLIST_LOAD_ERROR_COPY}</p>
          <button className="route-action" onClick={retry} type="button">
            Try again
          </button>
        </div>
      ) : frame.kind === "ready" ? (
        <WatchlistPanel tab={tab} watchlist={frame.watchlist} />
      ) : (
        <p className={styles.copy} role="status">
          Loading your Watchlist…
        </p>
      )}
    </WatchlistShell>
  );
}

function WatchlistShell({
  tab,
  repackCount,
  chaseCount,
  children,
}: Readonly<{
  tab: WatchlistTab;
  repackCount: number;
  chaseCount: number;
  children: ReactNode;
}>) {
  const isRepacks = tab === "repacks";
  return (
    <section className={styles.page} aria-labelledby="watchlist-heading">
      <div className="page-heading-row">
        <div className="dashboard-heading-group">
          <h1
            className="page-heading"
            data-route-heading
            id="watchlist-heading"
            tabIndex={-1}
          >
            Watchlist
          </h1>
          <nav
            aria-label="Watchlist collections"
            className={styles.tabs}
            role="tablist"
          >
            <Link
              aria-controls="watchlist-repacks-panel"
              aria-label={watchlistTabAccessibleName("repacks", repackCount)}
              aria-selected={isRepacks}
              className={styles.tab}
              href={watchlistHref("repacks")}
              id="watchlist-repacks-tab"
              role="tab"
            >
              Repacks
              <span aria-hidden="true" className={styles.pip}>
                {repackCount}
              </span>
            </Link>
            <Link
              aria-controls="watchlist-chase-cards-panel"
              aria-label={watchlistTabAccessibleName("chase-cards", chaseCount)}
              aria-selected={!isRepacks}
              className={styles.tab}
              href={watchlistHref("chase-cards")}
              id="watchlist-chase-cards-tab"
              role="tab"
            >
              Chase cards
              <span aria-hidden="true" className={styles.pip}>
                {chaseCount}
              </span>
            </Link>
          </nav>
        </div>
      </div>
      <div
        aria-labelledby={
          isRepacks ? "watchlist-repacks-tab" : "watchlist-chase-cards-tab"
        }
        id={isRepacks ? "watchlist-repacks-panel" : "watchlist-chase-cards-panel"}
        role="tabpanel"
      >
        {children}
      </div>
    </section>
  );
}

function WatchlistPanel({
  tab,
  watchlist,
}: Readonly<{
  tab: WatchlistTab;
  watchlist: OwnerWatchlist;
}>) {
  const isRepacks = tab === "repacks";
  const count = isRepacks
    ? watchlist.savedRepackCount
    : watchlist.savedCollectibleCount;

  return (
    <>
      {count === 0 ? (
        <div>
          <p className={styles.listStatus}>
            {isRepacks
              ? WATCHLIST_EMPTY_REPACKS_COPY
              : WATCHLIST_EMPTY_CHASE_CARDS_COPY}
          </p>
          <p className={styles.actions}>
            {isRepacks ? (
              <>
                <Link className="route-action" href="/">
                  Go to Dashboard
                </Link>
                <Link className="route-action" href="/packs">
                  Go to All Repacks
                </Link>
              </>
            ) : (
              <Link className="route-action" href="/packs">
                Search chase cards on All Repacks
              </Link>
            )}
          </p>
        </div>
      ) : (
        <ul
          aria-label={isRepacks ? "Saved repacks" : "Saved chase cards"}
          className={styles.list}
        >
          {isRepacks
            ? watchlist.savedRepacks.map((row) => {
                const presented = presentWatchlistRepackRow(row);
                return (
                  <li className={styles.row} key={row.publicRepackId}>
                    <p className={styles.rowTitle}>{presented.title}</p>
                    {presented.stale ? (
                      <p className={styles.stale}>{presented.detail}</p>
                    ) : (
                      <p className={styles.rowDetail}>{presented.detail}</p>
                    )}
                  </li>
                );
              })
            : watchlist.savedCollectibles.map((row) => {
                const presented = presentWatchlistCollectibleRow(row);
                return (
                  <li className={styles.row} key={row.publicCollectibleId}>
                    <p className={styles.rowTitle}>{presented.title}</p>
                    {presented.stale ? (
                      <p className={styles.stale}>{presented.detail}</p>
                    ) : presented.detail ? (
                      <p className={styles.rowDetail}>{presented.detail}</p>
                    ) : null}
                  </li>
                );
              })}
        </ul>
      )}
    </>
  );
}

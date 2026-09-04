import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseWatchlistTab,
  presentWatchlistCollectibleRow,
  presentWatchlistFrame,
  presentWatchlistInspectLabel,
  presentWatchlistRemoveControl,
  presentWatchlistRemoveLabel,
  presentWatchlistRepackRow,
  presentWatchlistUnavailableCopy,
  watchlistCanLoadOwnerRead,
  watchlistHref,
  watchlistNavVisible,
  watchlistTabAccessibleName,
  WATCHLIST_EMPTY_CHASE_CARDS_COPY,
  WATCHLIST_EMPTY_REPACKS_COPY,
  WATCHLIST_PATH,
  WATCHLIST_REMOVING_COPY,
  WATCHLIST_SIGN_IN_COPY,
  WATCHLIST_STALE_INSPECT_COPY,
  WATCHLIST_UNAVAILABLE_LABEL,
} from "./watchlist";

test("Watchlist tabs restore from the URL and keep Repacks as the default", () => {
  assert.equal(parseWatchlistTab(undefined), "repacks");
  assert.equal(parseWatchlistTab(null), "repacks");
  assert.equal(parseWatchlistTab("repacks"), "repacks");
  assert.equal(parseWatchlistTab("chase-cards"), "chase-cards");
  assert.equal(parseWatchlistTab(["chase-cards"]), "chase-cards");
  assert.equal(parseWatchlistTab("other"), "repacks");
  assert.equal(watchlistHref(), WATCHLIST_PATH);
  assert.equal(watchlistHref("repacks"), WATCHLIST_PATH);
  assert.equal(watchlistHref("chase-cards"), `${WATCHLIST_PATH}?tab=chase-cards`);
});

test("Watchlist nav is only for a signed-in account that can save", () => {
  assert.equal(
    watchlistNavVisible({
      authStatus: "signed_in",
      accountSavingAvailable: true,
    }),
    true,
  );
  assert.equal(
    watchlistNavVisible({
      authStatus: "signed_out",
      accountSavingAvailable: false,
    }),
    false,
  );
  assert.equal(
    watchlistNavVisible({
      authStatus: "loading",
      accountSavingAvailable: false,
    }),
    false,
  );
  assert.equal(
    watchlistNavVisible({
      authStatus: "signed_in",
      accountSavingAvailable: false,
    }),
    false,
  );
  assert.equal(
    watchlistNavVisible({
      authStatus: "error",
      accountSavingAvailable: false,
    }),
    false,
  );
});

test("a failed saved-id read still loads the owner Watchlist instead of spinning", () => {
  assert.equal(
    watchlistCanLoadOwnerRead({
      authStatus: "signed_in",
      accountNotice: null,
      accountSavingAvailable: true,
      accountSavingFailed: false,
    }),
    true,
  );
  assert.equal(
    watchlistCanLoadOwnerRead({
      authStatus: "signed_in",
      accountNotice: null,
      accountSavingAvailable: false,
      accountSavingFailed: true,
    }),
    true,
  );
  assert.equal(
    watchlistCanLoadOwnerRead({
      authStatus: "signed_in",
      accountNotice: null,
      accountSavingAvailable: false,
      accountSavingFailed: false,
    }),
    false,
  );
  assert.equal(
    watchlistCanLoadOwnerRead({
      authStatus: "signed_in",
      accountNotice: "Your account is suspended.",
      accountSavingAvailable: false,
      accountSavingFailed: true,
    }),
    false,
  );
  assert.equal(
    watchlistCanLoadOwnerRead({
      authStatus: "signed_out",
      accountNotice: null,
      accountSavingAvailable: false,
      accountSavingFailed: false,
    }),
    false,
  );
});

test("tab accessible names include the pip count", () => {
  assert.equal(watchlistTabAccessibleName("repacks", 0), "Repacks, 0");
  assert.equal(watchlistTabAccessibleName("chase-cards", 3), "Chase cards, 3");
});

test("unavailable Watchlist copy matches save-control standing language", () => {
  assert.equal(
    presentWatchlistUnavailableCopy("unavailable", null),
    "Account saving is not configured for this environment.",
  );
  assert.equal(
    presentWatchlistUnavailableCopy("error", null),
    "Your session could not be verified. Sign out and try again.",
  );
  assert.equal(
    presentWatchlistUnavailableCopy("signed_in", "Your account is suspended."),
    "Your account is suspended.",
  );
  assert.match(WATCHLIST_SIGN_IN_COPY, /sign in/i);
  assert.match(WATCHLIST_EMPTY_REPACKS_COPY, /Dashboard or All Repacks/);
  assert.match(WATCHLIST_EMPTY_CHASE_CARDS_COPY, /desired-chase/);
});

test("Watchlist frames never flash empty copy while signed out, loading, or failed", () => {
  assert.equal(
    presentWatchlistFrame({
      authStatus: "signed_out",
      accountSavingAvailable: false,
      accountNotice: null,
      loading: false,
      failed: false,
      watchlist: null,
    }).kind,
    "sign_in",
  );
  assert.equal(
    presentWatchlistFrame({
      authStatus: "loading",
      accountSavingAvailable: false,
      accountNotice: null,
      loading: false,
      failed: false,
      watchlist: null,
    }).kind,
    "checking",
  );
  assert.equal(
    presentWatchlistFrame({
      authStatus: "signed_in",
      accountSavingAvailable: false,
      accountNotice: null,
      loading: false,
      failed: false,
      watchlist: null,
    }).kind,
    "checking",
  );
  assert.equal(
    presentWatchlistFrame({
      authStatus: "signed_in",
      accountSavingAvailable: false,
      accountNotice: "Your account is suspended.",
      loading: false,
      failed: false,
      watchlist: null,
    }).kind,
    "unavailable",
  );
  assert.equal(
    presentWatchlistFrame({
      authStatus: "signed_in",
      accountSavingAvailable: true,
      accountNotice: null,
      loading: true,
      failed: false,
      watchlist: null,
    }).kind,
    "loading",
  );
  assert.equal(
    presentWatchlistFrame({
      authStatus: "signed_in",
      accountSavingAvailable: true,
      accountNotice: null,
      loading: false,
      failed: true,
      watchlist: null,
    }).kind,
    "error",
  );
  assert.equal(
    presentWatchlistFrame({
      authStatus: "signed_in",
      accountSavingAvailable: true,
      accountNotice: null,
      loading: false,
      failed: false,
      watchlist: {
        savedRepacks: [],
        savedCollectibles: [],
        savedRepackCount: 0,
        savedCollectibleCount: 0,
      },
    }).kind,
    "ready",
  );
});

test("resolved and stale Watchlist rows stay recognizable", () => {
  const resolved = presentWatchlistRepackRow({
    publicRepackId: "pack-1",
    savedAt: "2026-09-04T00:00:00.000Z",
    catalogStatus: "resolved",
    openable: true,
    repack: {
      name: "Prism Break",
      vendorDisplayName: "Clutch",
      availability: "sold_out",
      displayedEv: {
        evDollarsMinorUnits: 1250,
        grossReturnBasisPoints: 11_250,
        confidenceBand: "medium",
      },
      primaryImage: {
        url: "https://assets.vendor.example/repacks/prism.webp",
        alt: "Prism Break",
      },
    },
  });
  assert.equal(resolved.title, "Prism Break");
  assert.match(resolved.detail ?? "", /Clutch/);
  assert.match(resolved.detail ?? "", /Sold out/);
  assert.match(resolved.detail ?? "", /\$12\.50/);
  assert.equal(resolved.stale, false);
  assert.equal(resolved.canInspect, true);
  assert.equal(
    resolved.image?.url,
    "https://assets.vendor.example/repacks/prism.webp",
  );
  assert.equal(
    presentWatchlistInspectLabel(resolved.title, resolved.canInspect),
    "View details for Prism Break",
  );

  const withoutEv = presentWatchlistRepackRow({
    publicRepackId: "pack-2", savedAt: "2026-09-04T00:00:00.000Z",
    catalogStatus: "resolved", openable: true,
    repack: {
      name: "Prism Break",
      vendorDisplayName: "Clutch",
      availability: "sold_out",
      displayedEv: null,
      primaryImage: null,
    },
  });
  assert.equal(withoutEv.detail, "Clutch · Sold out");

  const stale = presentWatchlistRepackRow({
    publicRepackId: "pack-gone",
    savedAt: "2026-09-04T00:00:00.000Z",
    catalogStatus: "unavailable",
    openable: false,
    repack: null,
  });
  assert.equal(stale.title, "pack-gone");
  assert.equal(stale.detail, WATCHLIST_UNAVAILABLE_LABEL);
  assert.equal(stale.stale, true);
  assert.equal(stale.canInspect, false);
  assert.equal(stale.image, null);
  assert.equal(
    presentWatchlistInspectLabel(stale.title, stale.canInspect),
    `pack-gone. ${WATCHLIST_STALE_INSPECT_COPY}`,
  );

  const collectible = presentWatchlistCollectibleRow({
    publicCollectibleId: "card-1",
    savedAt: "2026-09-04T00:00:00.000Z",
    catalogStatus: "resolved",
    openable: true,
    collectible: {
      name: "Charizard ex #199",
      collectibleType: "card",
      year: 2023,
      brand: "Pokemon",
      setOrSeries: "Obsidian Flames",
      cardNumber: "199",
      referenceNumber: null,
      grade: null,
      grader: null,
      primaryImage: {
        url: "https://assets.vendor.example/collectibles/charizard.webp",
        alt: "Charizard ex card",
      },
    },
  });
  assert.equal(collectible.title, "Charizard ex #199");
  assert.match(collectible.detail ?? "", /Pokemon/);
  assert.equal(collectible.stale, false);
  assert.equal(collectible.canInspect, true);
  assert.equal(
    collectible.image?.url,
    "https://assets.vendor.example/collectibles/charizard.webp",
  );
});

test("Watchlist row remove stays immediate and blocks a second click", () => {
  assert.equal(
    presentWatchlistRemoveLabel("Prism Break"),
    "Remove Prism Break from Watchlist",
  );
  const pending = presentWatchlistRemoveControl({
    pending: true,
    loading: false,
    failed: false,
    saved: true,
  });
  assert.equal(pending.disabled, true);
  assert.equal(pending.label, "Removing…");
  assert.equal(pending.statusCopy, WATCHLIST_REMOVING_COPY);

  const idle = presentWatchlistRemoveControl({
    pending: false,
    loading: false,
    failed: false,
    saved: true,
    message: {
      copy: "We couldn't update this repack. Try again.",
      tone: "error",
    },
  });
  assert.equal(idle.disabled, false);
  assert.equal(idle.label, "Remove");
  assert.equal(idle.tone, "error");
  assert.match(idle.statusCopy, /Try again/);

  const failedIds = presentWatchlistRemoveControl({
    pending: false,
    loading: false,
    failed: true,
    saved: true,
  });
  assert.equal(failedIds.disabled, true);
});

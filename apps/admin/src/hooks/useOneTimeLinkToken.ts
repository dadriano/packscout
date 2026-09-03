import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

/** The fragment key a mailed one-time link carries its presented token in. */
export const ONE_TIME_LINK_TOKEN_FRAGMENT_KEY = "token";

/** Parses the presented token out of a location fragment, or "" if absent. */
export function readOneTimeLinkTokenFromFragment(hash: string): string {
  if (!hash.startsWith("#")) return "";
  return (
    new URLSearchParams(hash.slice(1)).get(ONE_TIME_LINK_TOKEN_FRAGMENT_KEY) ??
    ""
  );
}

/**
 * The one-time token a mailed redemption link carries, read from the URL
 * fragment and removed from the address bar in the same breath.
 *
 * The fragment is the one part of a URL browsers never put on the wire. A
 * token in the query string reaches every server access log the request
 * passes through, and — because the admin serves `Referrer-Policy:
 * same-origin` — it also travels in the `Referer` header of every asset and
 * API request this screen makes, which for a reset or invitation link means
 * an operator-account credential in ordinary logs. In the fragment it reaches
 * neither.
 *
 * The value is captured once, on first render, and the history entry is then
 * replaced with the bare path, so a spent link does not linger in session
 * history or in whatever the recipient later copies out of the address bar.
 * It lives only in component state and travels only in a request body — never
 * echoed into the document, stored, or logged.
 */
export function useOneTimeLinkToken(): string {
  const location = useLocation();
  const navigate = useNavigate();
  const [token] = useState(() =>
    readOneTimeLinkTokenFromFragment(location.hash),
  );
  useEffect(() => {
    if (location.hash === "") return;
    navigate(
      { pathname: location.pathname, search: location.search },
      { replace: true },
    );
  }, [location.hash, location.pathname, location.search, navigate]);
  return token;
}

export type ConvexAuthTokenRequest = Readonly<{
  forceRefreshToken: boolean;
}>;

export function convexAuthSessionKey(input: Readonly<{
  ready: boolean;
  authenticated: boolean;
  userId?: string;
}>): string {
  if (!input.ready) return "loading";
  if (!input.authenticated) return "signed-out";
  return `signed-in:${input.userId ?? "identity-pending"}`;
}

export async function fetchPrivyAccessTokenForConvex(
  input: Readonly<{
    ready: boolean;
    authenticated: boolean;
    getAccessToken: () => Promise<string | null>;
  }>,
  request: ConvexAuthTokenRequest,
): Promise<string | null> {
  // Privy does not expose a forced-refresh flag. Calling getAccessToken for every
  // Convex request still performs Privy's own expiry check and refresh behavior.
  void request.forceRefreshToken;
  if (!input.ready || !input.authenticated) return null;
  return input.getAccessToken();
}

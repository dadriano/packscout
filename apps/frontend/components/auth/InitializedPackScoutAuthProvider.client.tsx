"use client";

import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { PrivyProvider, usePrivy } from "@privy-io/react-auth";
import {
  ConvexProviderWithAuth,
  ConvexReactClient,
  useConvexAuth,
} from "convex/react";
import { AuthenticatedSavedItemsProvider } from "./AuthenticatedSavedItemsProvider.client";
import { AuthenticatedSignInRecorder } from "./AuthenticatedSignInRecorder.client";
import {
  clearBrowserIdentityCookie,
  IdentityAccessCookieSync,
} from "./IdentityCookieSync.client";
import {
  PackScoutAuthContext,
  type PackScoutAuthValue,
} from "./AuthContext.client";
import {
  browserAuthSessionHintStorage,
  logoutAndClearReturningSessionHint,
  shouldInvokeLogin,
  syncReturningSessionHint,
} from "./auth-boot";
import { createPrivyClientConfig } from "./auth-config";
import type { InitializedAuthProviderProps } from "./auth-provider-contract";
import {
  convexAuthSessionKey,
  fetchPrivyAccessTokenForConvex,
} from "./convex-auth-adapter";
import { verifiedIdentityFromProviderUser } from "./verified-identity";

// The provider is initialized here, so a session boot request has nothing
// left to do.
const sessionBootAlreadyDone = () => undefined;

function usePrivyAuthForConvex() {
  const { authenticated, getAccessToken, ready, user } = usePrivy();
  const sessionKey = convexAuthSessionKey({
    ready,
    authenticated,
    userId: user?.id,
  });
  const fetchAccessToken = useCallback(
    (request: Readonly<{ forceRefreshToken: boolean }>) => {
      // Capturing the generation resets Convex if Privy swaps identities
      // without passing through a signed-out render.
      void sessionKey;
      return fetchPrivyAccessTokenForConvex(
        { ready, authenticated, getAccessToken },
        request,
      );
    },
    [authenticated, getAccessToken, ready, sessionKey],
  );

  return {
    isLoading: !ready,
    isAuthenticated: ready && authenticated,
    fetchAccessToken,
  };
}

function PackScoutAuthBridge({
  children,
  loginRequested,
  onLoginIntentConsumed,
  requestLogin,
}: Readonly<{
  children: ReactNode;
  loginRequested: boolean;
  onLoginIntentConsumed: () => void;
  requestLogin: () => void;
}>) {
  const {
    authenticated,
    error,
    login: privyLogin,
    logout: privyLogout,
    ready,
    user,
  } = usePrivy();
  const convex = useConvexAuth();
  const loginInvoked = useRef(false);
  // The key that generations Convex auth also bounds sign-in recording to one
  // write per established session.
  const sessionKey = convexAuthSessionKey({
    ready,
    authenticated,
    userId: user?.id,
  });

  useEffect(() => {
    syncReturningSessionHint(
      { ready, authenticated },
      browserAuthSessionHintStorage(),
    );
  }, [authenticated, ready]);

  useEffect(() => {
    if (!loginRequested) {
      loginInvoked.current = false;
      return;
    }
    if (ready && authenticated) {
      onLoginIntentConsumed();
      return;
    }
    if (
      !shouldInvokeLogin({
        requested: loginRequested,
        ready,
        authenticated,
        alreadyInvoked: loginInvoked.current,
      })
    ) {
      return;
    }
    loginInvoked.current = true;
    try {
      privyLogin();
    } catch {
      // A synchronous provider failure must not take down public browsing.
      // Consuming this intent leaves the next click free to retry.
      loginInvoked.current = false;
    } finally {
      onLoginIntentConsumed();
    }
  }, [
    authenticated,
    loginRequested,
    onLoginIntentConsumed,
    privyLogin,
    ready,
  ]);

  const logout = useCallback(async () => {
    await logoutAndClearReturningSessionHint(
      privyLogout,
      browserAuthSessionHintStorage(),
    );
    // The server-readable credential dies with the session, so the very next
    // server-rendered request reads as signed out (closed-beta-access/007).
    clearBrowserIdentityCookie();
  }, [privyLogout]);
  const status: PackScoutAuthValue["status"] = error
    ? "error"
    : !ready
      ? "loading"
      : !authenticated
        ? "signed_out"
        : convex.isLoading || convex.isRefreshing
          ? "loading"
          : convex.isAuthenticated
            ? "signed_in"
            : "error";
  // Only what the provider verified for this session, and only while the
  // session stands. Display data for surfaces like the holding page
  // (closed-beta-access/008); no routing or capability reads it.
  const identity = useMemo(
    () =>
      ready && authenticated ? verifiedIdentityFromProviderUser(user) : null,
    [authenticated, ready, user],
  );
  const value = useMemo<PackScoutAuthValue>(
    () => ({
      status,
      identity,
      login: requestLogin,
      logout,
      requestSessionBoot: sessionBootAlreadyDone,
    }),
    [identity, logout, requestLogin, status],
  );

  return (
    <PackScoutAuthContext.Provider value={value}>
      <AuthenticatedSignInRecorder sessionKey={sessionKey}>
        <AuthenticatedSavedItemsProvider
          key={authenticated ? user?.id : "signed-out"}
        >
          {children}
        </AuthenticatedSavedItemsProvider>
      </AuthenticatedSignInRecorder>
    </PackScoutAuthContext.Provider>
  );
}

export function InitializedPackScoutAuthProvider({
  children,
  configuration,
  loginRequested,
  nonce,
  onLoginIntentConsumed,
  requestLogin,
}: InitializedAuthProviderProps) {
  const [convexClient] = useState(
    () => new ConvexReactClient(configuration.convexUrl),
  );
  const privyConfig = useMemo(() => createPrivyClientConfig(nonce), [nonce]);

  useEffect(
    () => () => {
      void convexClient.close();
    },
    [convexClient],
  );

  return (
    <PrivyProvider appId={configuration.privyAppId} config={privyConfig}>
      <IdentityAccessCookieSync />
      <ConvexProviderWithAuth
        client={convexClient}
        useAuth={usePrivyAuthForConvex}
      >
        <PackScoutAuthBridge
          loginRequested={loginRequested}
          onLoginIntentConsumed={onLoginIntentConsumed}
          requestLogin={requestLogin}
        >
          {children}
        </PackScoutAuthBridge>
      </ConvexProviderWithAuth>
    </PrivyProvider>
  );
}

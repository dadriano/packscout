"use client";

import {
  type ComponentType,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  PackScoutAuthContext,
  type PackScoutAuthValue,
} from "./AuthContext.client";
import {
  browserAuthSessionHintStorage,
  initialAuthBootState,
  readReturningSessionHint,
  reduceAuthBootState,
} from "./auth-boot";
import type {
  ConfiguredAuth,
  InitializedAuthProviderProps,
} from "./auth-provider-contract";
import {
  SavedItemsContext,
  unavailableSavedItemsValue,
} from "./SavedItemsContext.client";

type InitializedProvider = ComponentType<InitializedAuthProviderProps>;

let initializedProviderPromise: Promise<InitializedProvider> | null = null;

function loadInitializedProvider(): Promise<InitializedProvider> {
  initializedProviderPromise ??= import(
    "./InitializedPackScoutAuthProvider.client"
  )
    .then(({ InitializedPackScoutAuthProvider }) =>
      InitializedPackScoutAuthProvider)
    .catch((error: unknown) => {
      initializedProviderPromise = null;
      throw error;
    });
  return initializedProviderPromise;
}

export function ConfiguredPackScoutAuthProvider({
  children,
  configuration,
  nonce,
}: Readonly<{
  children: ReactNode;
  configuration: ConfiguredAuth;
  nonce?: string;
}>) {
  const [boot, dispatch] = useReducer(reduceAuthBootState, initialAuthBootState);
  const [InitializedProvider, setInitializedProvider] =
    useState<InitializedProvider | null>(null);
  const returningHintChecked = useRef(false);

  const startProvider = useCallback((loginIntent: boolean) => {
    dispatch({ type: loginIntent ? "login_intent" : "returning_session" });
    void loadInitializedProvider().then(
      (Provider) => {
        setInitializedProvider(() => Provider);
        dispatch({ type: "provider_loaded" });
      },
      () => dispatch({ type: "provider_failed" }),
    );
  }, []);

  useEffect(() => {
    if (returningHintChecked.current) return;
    returningHintChecked.current = true;
    if (readReturningSessionHint(browserAuthSessionHintStorage())) {
      startProvider(false);
    }
  }, [startProvider]);

  const requestLogin = useCallback(() => startProvider(true), [startProvider]);
  // A boot without login intent: establish an existing session, open nothing.
  // The holding surface calls this because the server already verified a
  // session for the visitor (closed-beta-access/008), so waiting on the
  // returning-session hint alone would leave storage-cleared browsers with a
  // page that never comes alive. Idempotent: the provider loads once.
  const requestSessionBoot = useCallback(
    () => startProvider(false),
    [startProvider],
  );
  const lightAuthValue = useMemo<PackScoutAuthValue>(
    () => ({
      status: boot.phase === "loading" ? "loading" : "signed_out",
      identity: null,
      login: requestLogin,
      logout: async () => undefined,
      requestSessionBoot,
    }),
    [boot.phase, requestLogin, requestSessionBoot],
  );

  if (InitializedProvider !== null) {
    return (
      <InitializedProvider
        configuration={configuration}
        loginRequested={boot.loginRequested}
        nonce={nonce}
        onLoginIntentConsumed={() => dispatch({ type: "login_consumed" })}
        requestLogin={requestLogin}
      >
        {children}
      </InitializedProvider>
    );
  }

  return (
    <PackScoutAuthContext.Provider value={lightAuthValue}>
      <SavedItemsContext.Provider value={unavailableSavedItemsValue}>
        {children}
      </SavedItemsContext.Provider>
    </PackScoutAuthContext.Provider>
  );
}

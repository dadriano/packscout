"use client";

import { createContext, useContext } from "react";
import type { VerifiedSignInIdentity } from "./verified-identity";

export type PackScoutAuthStatus =
  | "unavailable"
  | "loading"
  | "signed_out"
  | "signed_in"
  | "error";

export type PackScoutAuthValue = Readonly<{
  status: PackScoutAuthStatus;
  /**
   * The verified attributes of the established session — the provider-
   * verified email and/or wallet address — or null while no established
   * session exposes them. Display data only; nothing routes on it.
   */
  identity: VerifiedSignInIdentity | null;
  login: () => void;
  logout: () => Promise<void>;
  /**
   * Boot the session provider without expressing login intent: establish an
   * existing session if the browser holds one, and open nothing if it does
   * not. Surfaces that know a session exists — the holding surface renders
   * only after the server verified one (closed-beta-access/008) — call this
   * so the session comes up even when the returning-session hint is missing,
   * without ever popping an uninvited sign-in dialog. A no-op once the
   * provider is initialized and wherever authentication is unavailable.
   */
  requestSessionBoot: () => void;
}>;

const noLogin = () => undefined;
const noLogout = async () => undefined;
const noSessionBoot = () => undefined;

export const unavailableAuthValue: PackScoutAuthValue = Object.freeze({
  status: "unavailable",
  identity: null,
  login: noLogin,
  logout: noLogout,
  requestSessionBoot: noSessionBoot,
});

export const PackScoutAuthContext = createContext<PackScoutAuthValue | null>(
  null,
);

export function usePackScoutAuth(): PackScoutAuthValue {
  const value = useContext(PackScoutAuthContext);
  if (value === null) {
    throw new Error("usePackScoutAuth requires PackScoutAuthProvider");
  }
  return value;
}

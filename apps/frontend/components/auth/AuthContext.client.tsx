"use client";

import { createContext, useContext } from "react";

export type PackScoutAuthStatus =
  | "unavailable"
  | "loading"
  | "signed_out"
  | "signed_in"
  | "error";

export type PackScoutAuthValue = Readonly<{
  status: PackScoutAuthStatus;
  login: () => void;
  logout: () => Promise<void>;
}>;

const noLogin = () => undefined;
const noLogout = async () => undefined;

export const unavailableAuthValue: PackScoutAuthValue = Object.freeze({
  status: "unavailable",
  login: noLogin,
  logout: noLogout,
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

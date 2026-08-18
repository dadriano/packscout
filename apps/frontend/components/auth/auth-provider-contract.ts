import type { ReactNode } from "react";
import type { PublicAuthConfiguration } from "./auth-config";

export type ConfiguredAuth = Extract<
  PublicAuthConfiguration,
  { status: "configured" }
>;

export type InitializedAuthProviderProps = Readonly<{
  children: ReactNode;
  configuration: ConfiguredAuth;
  nonce?: string;
  loginRequested: boolean;
  requestLogin: () => void;
  onLoginIntentConsumed: () => void;
}>;

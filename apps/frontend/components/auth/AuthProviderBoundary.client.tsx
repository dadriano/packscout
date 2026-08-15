"use client";

import type { ReactNode } from "react";
import { ConfiguredPackScoutAuthProvider } from "./ConfiguredPackScoutAuthProvider.client";
import { UnavailablePackScoutAuthProvider } from "./UnavailablePackScoutAuthProvider.client";
import type { PublicAuthConfiguration } from "./auth-config";

export function AuthProviderBoundary({
  children,
  configuration,
  nonce,
}: Readonly<{
  children: ReactNode;
  configuration: PublicAuthConfiguration;
  nonce?: string;
}>) {
  if (configuration.status === "unavailable") {
    return (
      <UnavailablePackScoutAuthProvider>
        {children}
      </UnavailablePackScoutAuthProvider>
    );
  }

  return (
    <ConfiguredPackScoutAuthProvider
      configuration={configuration}
      nonce={nonce}
    >
      {children}
    </ConfiguredPackScoutAuthProvider>
  );
}

import type { PrivyClientConfig } from "@privy-io/react-auth";

export type PublicAuthConfiguration =
  | Readonly<{
      status: "configured";
      privyAppId: string;
      convexUrl: string;
    }>
  | Readonly<{
      status: "unavailable";
    }>;

type PublicAuthEnvironment = Readonly<{
  privyAppId?: string;
  convexUrl?: string;
}>;

function validConvexUrl(value: string | undefined): string | null {
  if (!value || value !== value.trim()) return null;

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    const canonicalInput = value.endsWith("/") ? value.slice(0, -1) : value;
    if (
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.origin !== canonicalInput
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

export function resolvePublicAuthConfiguration(
  environment: PublicAuthEnvironment,
): PublicAuthConfiguration {
  const privyAppId = environment.privyAppId;
  const convexUrl = validConvexUrl(environment.convexUrl);
  if (
    !privyAppId ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(privyAppId) ||
    !convexUrl
  ) {
    return { status: "unavailable" };
  }

  return {
    status: "configured",
    privyAppId,
    convexUrl,
  };
}

export function createPrivyClientConfig(
  scriptNonce?: string,
): PrivyClientConfig {
  return {
    loginMethods: ["email", "google"],
    appearance: {
      accentColor: "#5632f5",
      landingHeader: "Sign in to PackScout",
      loginMessage: "Save repacks and exact chase collectibles across devices.",
      showWalletLoginFirst: false,
    },
    embeddedWallets: {
      ethereum: { createOnLogin: "off" },
      solana: { createOnLogin: "off" },
      showWalletUIs: false,
    },
    externalWallets: {
      disableAllExternalWallets: true,
      walletConnect: { enabled: false },
    },
    ...(scriptNonce ? { scriptNonce } : {}),
  };
}

import type { AuthConfig } from "convex/server";

export function buildPrivyAuthConfig(
  configuredPrivyAppId: string | undefined,
): AuthConfig {
  const privyAppId =
    configuredPrivyAppId === undefined || configuredPrivyAppId === ""
      ? null
      : configuredPrivyAppId;
  if (
    privyAppId !== null &&
    (privyAppId !== privyAppId.trim() ||
      !/^[A-Za-z0-9_-]{8,128}$/.test(privyAppId))
  ) {
    throw new Error(
      "PRIVY_APP_ID must be a bounded 8-128 character public identifier without outer whitespace.",
    );
  }
  return {
    providers:
      privyAppId === null
        ? []
        : [
            {
              type: "customJwt",
              applicationID: privyAppId,
              issuer: "privy.io",
              jwks: `https://auth.privy.io/api/v1/apps/${encodeURIComponent(privyAppId)}/jwks.json`,
              algorithm: "ES256",
            },
          ],
  };
}

// Convex discovers auth environment dependencies from direct property reads
// while bundling auth.config.ts. Keep this statically visible so deployments
// configured with PRIVY_APP_ID publish the provider instead of an empty list.
export default buildPrivyAuthConfig(process.env.PRIVY_APP_ID);

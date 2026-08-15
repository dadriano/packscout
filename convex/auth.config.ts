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
              jwks: `https://api.privy.io/v1/apps/${encodeURIComponent(privyAppId)}/jwks.json`,
              algorithm: "ES256",
            },
          ],
  };
}

function optionalDeploymentEnvironmentValue(name: string): string | undefined {
  // A direct process.env.NAME read makes NAME required during Convex auth
  // bundling. Dynamic presence checking keeps unconfigured deployments valid.
  const deploymentEnvironment = process.env as Readonly<
    Record<string, string | undefined>
  >;
  return Object.prototype.hasOwnProperty.call(deploymentEnvironment, name)
    ? deploymentEnvironment[name]
    : undefined;
}

export default buildPrivyAuthConfig(
  optionalDeploymentEnvironmentValue("PRIVY_APP_ID"),
);

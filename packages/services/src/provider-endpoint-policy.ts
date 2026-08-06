export type ProviderRuntimeEnvironment = "local" | "test" | "production";

export type ProviderEndpointPolicyFailureCode =
  | "endpoint_credentials_forbidden"
  | "endpoint_fragment_forbidden"
  | "endpoint_host_invalid"
  | "endpoint_port_forbidden"
  | "endpoint_protocol_forbidden"
  | "endpoint_url_invalid";

export class ProviderEndpointPolicyError extends Error {
  constructor(readonly code: ProviderEndpointPolicyFailureCode) {
    super("Provider endpoint does not satisfy the endpoint policy.");
    this.name = "ProviderEndpointPolicyError";
  }
}

export interface ValidatedProviderEndpoint {
  readonly endpoint: string;
  readonly endpointHost: string;
  readonly allowedHosts: readonly [string];
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function validateProviderEndpoint(
  value: string,
  environment: ProviderRuntimeEnvironment,
): ValidatedProviderEndpoint {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderEndpointPolicyError("endpoint_url_invalid");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new ProviderEndpointPolicyError("endpoint_credentials_forbidden");
  }
  if (url.hash.length > 0) {
    throw new ProviderEndpointPolicyError("endpoint_fragment_forbidden");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname.length === 0 || /[\s/@?#*]/.test(hostname)) {
    throw new ProviderEndpointPolicyError("endpoint_host_invalid");
  }
  const localHttp =
    environment === "local" &&
    url.protocol === "http:" &&
    isLocalHostname(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !localHttp) {
    throw new ProviderEndpointPolicyError("endpoint_protocol_forbidden");
  }
  if (!localHttp && url.port !== "" && url.port !== "443") {
    throw new ProviderEndpointPolicyError("endpoint_port_forbidden");
  }
  url.hostname = hostname;
  return Object.freeze({
    endpoint: url.toString(),
    endpointHost: hostname,
    allowedHosts: Object.freeze([hostname]) as readonly [string],
  });
}

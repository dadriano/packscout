import { isIP } from "node:net";
import { ProviderDatabaseDestinationPolicy } from "./provider-database-destination-policy.ts";

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export interface DatabaseRuntimePolicyOptions {
  readonly localProviderHosts?: readonly string[];
  readonly localProviderPorts?: readonly number[];
  readonly localCentralHost?: string;
  readonly localCentralPort?: number;
  readonly centralDatabaseName?: string;
}

export interface DatabaseRuntimePolicy {
  readonly mode: "local" | "remote";
  readonly destinationPolicy: ProviderDatabaseDestinationPolicy;
  assertCentralDatabaseUrl(databaseUrl: string): void;
}

function exactHosts(value: string | undefined, variable: string): readonly string[] {
  const hosts = value?.split(",").map((host) =>
    host.trim().toLowerCase().replace(/\.$/u, "")
  ) ?? [];
  const validHost = (host: string): boolean => isIP(host) !== 0 || (
    host.length <= 253 && host.split(".").every((label) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)
    )
  );
  if (hosts.length < 1 || hosts.length > 64
    || new Set(hosts).size !== hosts.length
    || hosts.some((host) => !validHost(host))) {
    throw new TypeError(`${variable} must contain 1 to 64 unique exact database hosts.`);
  }
  return Object.freeze(hosts);
}

function centralUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (!["postgresql:", "postgres:"].includes(url.protocol) || url.hash
      || ["host", "hostaddr", "port", "dbname", "database", "user", "password"]
        .some((name) => url.searchParams.has(name))
      || ["sslmode", "sslaccept"].some((name) => url.searchParams.getAll(name).length > 1)) {
      throw new TypeError();
    }
    return url;
  } catch {
    throw new TypeError("Central database URL is invalid; connection overrides are not allowed.");
  }
}

/** Explicit deployment configuration; never infer cloud access from a database row. */
export function readDatabaseRuntimePolicy(
  environment: RuntimeEnvironment,
  options: DatabaseRuntimePolicyOptions = {},
): DatabaseRuntimePolicy {
  const production = environment.NODE_ENV === "production";
  const mode = environment.PACKSCOUT_DATABASE_MODE ?? (production ? "remote" : "local");
  if ((mode !== "local" && mode !== "remote") || (production && mode === "local")) {
    throw new TypeError("PACKSCOUT_DATABASE_MODE must be local or remote; production requires remote.");
  }
  const centralHosts = environment.PACKSCOUT_CENTRAL_DATABASE_ALLOWED_HOSTS;
  const localCentralHost = options.localCentralHost ?? "127.0.0.1";
  const localCentralPort = options.localCentralPort ?? 55_431;
  const databaseName = options.centralDatabaseName ?? "packscout";
  const destinationPolicy = new ProviderDatabaseDestinationPolicy(mode === "remote"
    ? {
        allowedHosts: exactHosts(environment.PACKSCOUT_PROVIDER_DATABASE_ALLOWED_HOSTS,
          "PACKSCOUT_PROVIDER_DATABASE_ALLOWED_HOSTS"),
        allowedPorts: [5_432],
        allowedSslModes: ["verify-full"],
      }
    : {
        allowedHosts: options.localProviderHosts ?? ["127.0.0.1"],
        allowedPorts: options.localProviderPorts ?? [55_432, 55_433, 55_434, 55_435],
        allowedSslModes: ["disable"],
      });
  return {
    mode,
    destinationPolicy,
    assertCentralDatabaseUrl(databaseUrl) {
      const url = centralUrl(databaseUrl);
      let name: string;
      try { name = decodeURIComponent(url.pathname.slice(1)); }
      catch { throw new TypeError("Central database name is invalid."); }
      if (name !== databaseName) throw new TypeError("Central database name does not match the runtime target.");
      const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
      const port = Number(url.port || 5_432);
      const sslMode = url.searchParams.get("sslmode");
      const sslAccept = url.searchParams.get("sslaccept");
      if (mode === "local") {
        if (host !== localCentralHost || port !== localCentralPort
          || (sslMode !== null && sslMode !== "disable")) {
          throw new TypeError("Local central database must use the configured loopback review target.");
        }
        return;
      }
      const allowed = exactHosts(centralHosts, "PACKSCOUT_CENTRAL_DATABASE_ALLOWED_HOSTS");
      if (!allowed.includes(host) || port !== 5_432 || !url.username || !url.password) {
        throw new TypeError("Remote central database destination is not allowed.");
      }
      const verified = (sslMode === "verify-full" && (sslAccept === null || sslAccept === "strict"))
        || (sslMode === "require" && sslAccept === "strict");
      if (!verified) throw new TypeError("Remote central database TLS must verify the server certificate.");
    },
  };
}

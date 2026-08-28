import { isLoopbackHostname } from "./loopback.ts";

/**
 * The panel's server-side facts about *which* database the applications point
 * at, and whether that database is provably on this machine.
 *
 * Two rules govern everything here:
 *
 *  1. **Credentials never leave this module.** The resolved connection string is
 *     available only through `readDatabaseConnectionSecret`, which the probe and
 *     the row-browser child use to fill an environment variable. Nothing derived
 *     from it — identity, display URL, explanations — carries user info or a
 *     password, so no response, client state, log line, or child argument list
 *     can leak one.
 *  2. **Locality fails closed.** `locality` is `local` only when the whole
 *     configuration parsed cleanly *and* the host is provably the loopback
 *     interface. Absent configuration, an unparseable value, a host override the
 *     panel cannot resolve, an unknown scheme, a missing database name, or any
 *     routable host all classify as `non_local`.
 *
 * admin-tools/015 re-checks these same facts at execution time; it calls
 * `resolveDatabaseTarget` / `requireLocalDatabaseTarget` rather than trusting
 * anything a client sends.
 */

/** The one variable every PackScout application reads for the relational store. */
export const DATABASE_URL_VARIABLE = "PACKSCOUT_DATABASE_URL";

/** libpq's default, used when a URL omits the port. */
export const DEFAULT_POSTGRES_PORT = 5432;

const SUPPORTED_SCHEMES = new Set(["postgres:", "postgresql:"]);

export type DatabaseLocality = "local" | "non_local";

export type DatabaseLocalityReason =
  | "loopback_host"
  | "routable_host"
  | "unreadable_configuration";

export type DatabaseTargetProblem =
  | "missing_configuration"
  | "unparseable_configuration"
  | "unsupported_scheme"
  | "missing_host"
  | "ambiguous_host_override"
  | "missing_database_name";

export interface DatabaseTargetIdentity {
  /** Hostname only — never user info. */
  readonly host: string;
  readonly port: number;
  readonly database: string;
  /** A credential-free rendering safe to show, log, and store client-side. */
  readonly displayUrl: string;
}

export interface DatabaseTargetFacts {
  readonly variableName: string;
  readonly configured: boolean;
  readonly identity: DatabaseTargetIdentity | null;
  readonly locality: DatabaseLocality;
  readonly localityReason: DatabaseLocalityReason;
  readonly problem: DatabaseTargetProblem | null;
  /** One sentence an operator can act on. Never contains credentials. */
  readonly explanation: string;
}

const PROBLEM_EXPLANATIONS: Record<DatabaseTargetProblem, string> = {
  missing_configuration: `No database is configured: ${DATABASE_URL_VARIABLE} is not set for this panel, so there is nothing to inspect.`,
  unparseable_configuration: `${DATABASE_URL_VARIABLE} is set but is not a connection URL the panel can read, so its target cannot be identified or proven local.`,
  unsupported_scheme: `${DATABASE_URL_VARIABLE} does not name a PostgreSQL connection, so the panel will not treat it as PackScout's relational store.`,
  missing_host: `${DATABASE_URL_VARIABLE} names no host, so the panel cannot prove the target is this machine.`,
  ambiguous_host_override: `${DATABASE_URL_VARIABLE} overrides its host through a query parameter; the panel will not guess which host wins, so the target counts as non-local.`,
  missing_database_name: `${DATABASE_URL_VARIABLE} names no database, so the panel cannot identify the target well enough to prove it is local.`,
};

const LOCAL_EXPLANATION =
  "The configured database is on this machine (loopback), so local-only operations are available.";
const REMOTE_EXPLANATION =
  "The configured database is not provably on this machine, so every local-only capability stays disabled.";

function facts(
  problem: DatabaseTargetProblem,
  configured: boolean,
): DatabaseTargetFacts {
  return {
    variableName: DATABASE_URL_VARIABLE,
    configured,
    identity: null,
    locality: "non_local",
    localityReason: "unreadable_configuration",
    problem,
    explanation: PROBLEM_EXPLANATIONS[problem],
  };
}

/**
 * The raw connection string, for the two callers that legitimately need it: the
 * status probe and the supervised row-browser child. Both pass it through an
 * environment variable, never through an argument list.
 */
export function readDatabaseConnectionSecret(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const value = env[DATABASE_URL_VARIABLE];
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length === 0 ? undefined : trimmed;
}

function identityOf(url: URL, database: string): DatabaseTargetIdentity {
  const host = url.hostname;
  const port = url.port === "" ? DEFAULT_POSTGRES_PORT : Number(url.port);
  return {
    host,
    port,
    database,
    displayUrl: `postgresql://${host}:${port}/${database}`,
  };
}

/**
 * Resolve the panel's database target from the environment. Pure: the caller
 * supplies the environment, so every classification case is directly testable.
 */
export function resolveDatabaseTarget(
  env: Readonly<Record<string, string | undefined>>,
): DatabaseTargetFacts {
  const value = readDatabaseConnectionSecret(env);
  if (value === undefined) return facts("missing_configuration", false);

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return facts("unparseable_configuration", true);
  }

  if (!SUPPORTED_SCHEMES.has(url.protocol)) {
    return facts("unsupported_scheme", true);
  }
  if (url.hostname === "") return facts("missing_host", true);
  // libpq lets a query parameter replace the authority host (a Unix socket
  // directory, for example). The panel refuses to pick a winner rather than
  // classifying the wrong host as local.
  if (url.searchParams.has("host")) {
    return facts("ambiguous_host_override", true);
  }

  const database = decodeURIComponent(url.pathname.replace(/^\//u, ""));
  if (database === "") return facts("missing_database_name", true);

  const local = isLoopbackHostname(url.hostname);
  return {
    variableName: DATABASE_URL_VARIABLE,
    configured: true,
    identity: identityOf(url, database),
    locality: local ? "local" : "non_local",
    localityReason: local ? "loopback_host" : "routable_host",
    problem: null,
    explanation: local ? LOCAL_EXPLANATION : REMOTE_EXPLANATION,
  };
}

export interface LocalTargetRefusal {
  readonly ok: false;
  readonly status: 409;
  readonly code: "ops_panel_database_not_local";
  readonly message: string;
  readonly target: DatabaseTargetFacts;
}

export type LocalTargetDecision =
  | { readonly ok: true; readonly target: DatabaseTargetFacts }
  | LocalTargetRefusal;

/**
 * The server-side gate every risky capability shares. admin-tools/015 calls this
 * immediately before executing an operation, so a client that believes the
 * target is local cannot make it so.
 */
export function requireLocalDatabaseTarget(
  env: Readonly<Record<string, string | undefined>>,
): LocalTargetDecision {
  const target = resolveDatabaseTarget(env);
  if (target.locality === "local") return { ok: true, target };
  return {
    ok: false,
    status: 409,
    code: "ops_panel_database_not_local",
    message: target.explanation,
    target,
  };
}

import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The environment check the local database workflows enforce for themselves.
 *
 * Engineering rules require an environment-specific script to prove its own
 * scope rather than trusting whoever invoked it, so both `db:seed:local` and
 * `db:reset:local` refuse to touch anything they cannot show is a database on
 * this machine. The classification fails closed: absent configuration, an
 * unreadable URL, a host the script would have to guess at, and any routable
 * host are all "not local".
 *
 * This mirrors the operations panel's own classifier deliberately. The panel
 * cannot be imported here — it is an application, not a shared package — and a
 * script that relied on the panel for its safety would stop being safe the
 * moment someone ran it from a terminal.
 */

export const DATABASE_URL_VARIABLE = "PACKSCOUT_DATABASE_URL";

const SUPPORTED_SCHEMES = new Set(["postgres:", "postgresql:"]);
const LOOPBACK_HOSTNAMES = new Set(["localhost", "::1", "0:0:0:0:0:0:0:1"]);
const IPV4_LOOPBACK_PATTERN = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isLoopbackHostname(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  const normalized = value.trim().toLowerCase();
  const unbracketed =
    normalized.startsWith("[") && normalized.endsWith("]")
      ? normalized.slice(1, -1)
      : normalized;
  if (LOOPBACK_HOSTNAMES.has(unbracketed)) return true;
  const ipv4 = IPV4_LOOPBACK_PATTERN.exec(unbracketed);
  if (!ipv4) return false;
  return ipv4
    .slice(1)
    .every((octet) => octet.length <= 3 && Number(octet) >= 0 && Number(octet) <= 255);
}

/**
 * Classify the configured target. Pure: the caller supplies the environment, so
 * every refusal case is directly testable.
 */
export function classifyLocalDatabaseTarget(env) {
  const raw = env[DATABASE_URL_VARIABLE];
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value.length === 0) {
    return {
      local: false,
      database: null,
      reason: `${DATABASE_URL_VARIABLE} is not set, so there is no local database to work on.`,
    };
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    return {
      local: false,
      database: null,
      reason: `${DATABASE_URL_VARIABLE} is not a connection URL this script can read, so it cannot prove the target is local.`,
    };
  }

  if (!SUPPORTED_SCHEMES.has(url.protocol)) {
    return {
      local: false,
      database: null,
      reason: `${DATABASE_URL_VARIABLE} does not name a PostgreSQL connection.`,
    };
  }
  if (url.searchParams.has("host")) {
    return {
      local: false,
      database: null,
      reason: `${DATABASE_URL_VARIABLE} overrides its host through a query parameter; this script will not guess which host wins.`,
    };
  }

  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (database === "") {
    return {
      local: false,
      database: null,
      reason: `${DATABASE_URL_VARIABLE} names no database.`,
    };
  }
  if (!isLoopbackHostname(url.hostname)) {
    return {
      local: false,
      database,
      reason: `${DATABASE_URL_VARIABLE} points at "${url.hostname}", which is not this machine. Local-only workflows refuse to run against it.`,
    };
  }

  return { local: true, database, reason: null };
}

/** Exit rather than continue when the target is not provably this machine's. */
export function requireLocalDatabaseTarget(env, workflow) {
  const classification = classifyLocalDatabaseTarget(env);
  if (classification.local) return classification;
  console.error(`${workflow} refused to run: ${classification.reason}`);
  process.exit(1);
}

export function repositoryRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function prismaExecutable() {
  return path.join(repositoryRoot(), "node_modules", ".bin", "prisma");
}

export function prismaSchemaPath() {
  return path.join(
    repositoryRoot(),
    "packages",
    "database",
    "prisma",
    "schema.prisma",
  );
}

import path from "node:path";

/**
 * The per-service log-file convention every locally run PackScout process joins.
 *
 * One directory holds one append-only file per service, named `<service>.log`.
 * The supervised launchd workflow already writes these files; the plain dev
 * workflow reaches the same convention through the local run wrapper.
 *
 * This module is framework-free on purpose: it is the only definition of the
 * convention, and every consumer (panel server, local scripts) derives from it.
 */

export const LOG_FILE_EXTENSION = ".log";

/**
 * Service names are derived from untrusted file names, so they are validated
 * against a deliberately narrow character set before they reach any consumer.
 */
const SERVICE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;

export const SERVICE_NAME_RULE =
  "lowercase letters, digits, and inner hyphens; 1-64 characters";

/** Services the repository supervises locally today. */
export const LOCAL_SERVICE_NAMES = [
  "frontend",
  "admin",
  "worker",
  "ops-panel",
] as const;

export type LocalServiceName = (typeof LOCAL_SERVICE_NAMES)[number];

export interface EnvironmentDescriptor {
  env: Readonly<Record<string, string | undefined>>;
  platform: string;
  homeDirectory: string;
}

export function isSafeServiceName(value: unknown): value is string {
  return typeof value === "string" && SERVICE_NAME_PATTERN.test(value);
}

/**
 * Derive a service name from a log file name, or reject the file. Anything that
 * is not exactly `<safe-name>.log` is not part of the convention and is ignored
 * rather than guessed at.
 */
export function serviceNameFromLogFileName(fileName: unknown): string | null {
  if (typeof fileName !== "string") return null;
  if (!fileName.endsWith(LOG_FILE_EXTENSION)) return null;
  if (fileName.includes("/") || fileName.includes("\\")) return null;
  const candidate = fileName.slice(0, -LOG_FILE_EXTENSION.length);
  return isSafeServiceName(candidate) ? candidate : null;
}

export function logFileNameForService(service: string): string {
  if (!isSafeServiceName(service)) {
    throw new Error(
      `A PackScout service name must use ${SERVICE_NAME_RULE}: ${JSON.stringify(service)}`,
    );
  }
  return `${service}${LOG_FILE_EXTENSION}`;
}

function xdgDirectory(
  { env, homeDirectory }: EnvironmentDescriptor,
  variableName: string,
  fallbackSegments: readonly string[],
): string {
  const configured = env[variableName]?.trim();
  if (configured) return path.resolve(configured);
  return path.join(homeDirectory, ...fallbackSegments);
}

/**
 * Resolve the single directory that holds per-service log files.
 *
 * `PACKSCOUT_LOG_DIR` overrides the platform default so a developer can point
 * the wrapper and the panel at the same directory in any environment.
 */
export function resolveServiceLogDirectory(
  descriptor: EnvironmentDescriptor,
): string {
  const configured = descriptor.env.PACKSCOUT_LOG_DIR?.trim();
  if (configured) return path.resolve(configured);
  if (descriptor.platform === "darwin") {
    return path.join(descriptor.homeDirectory, "Library", "Logs", "PackScout");
  }
  return path.join(
    xdgDirectory(descriptor, "XDG_STATE_HOME", [".local", "state"]),
    "packscout",
    "logs",
  );
}

/**
 * Resolve the directory holding the panel's own persisted state, which today is
 * the audit trail. It is deliberately separate from the log directory so panel
 * state is never mistaken for a service log source.
 */
export function resolvePanelStateDirectory(
  descriptor: EnvironmentDescriptor,
): string {
  const configured = descriptor.env.PACKSCOUT_OPS_PANEL_STATE_DIR?.trim();
  if (configured) return path.resolve(configured);
  if (descriptor.platform === "darwin") {
    return path.join(
      descriptor.homeDirectory,
      "Library",
      "Application Support",
      "PackScout",
      "ops-panel",
    );
  }
  return path.join(
    xdgDirectory(descriptor, "XDG_STATE_HOME", [".local", "state"]),
    "packscout",
    "ops-panel",
  );
}

export function serviceLogFilePath(
  descriptor: EnvironmentDescriptor,
  service: string,
): string {
  return path.join(
    resolveServiceLogDirectory(descriptor),
    logFileNameForService(service),
  );
}

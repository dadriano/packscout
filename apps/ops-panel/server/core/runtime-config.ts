import { isLoopbackHostname } from "./loopback.ts";

/**
 * Startup configuration for the panel. Pure so the reserved-range rule, the
 * loopback-only bind, and the friendly port-in-use message are all testable.
 */

/** ARCHITECTURE.md reserves 5100-5199 for local PackScout services. */
export const RESERVED_PORT_RANGE = Object.freeze({ minimum: 5100, maximum: 5199 });
export const OPS_PANEL_DEFAULT_PORT = 5110;
export const OPS_PANEL_DEFAULT_HMR_PORT = 5111;

/** Discovery polls on a bounded interval: never busier, never unresponsive. */
export const POLL_INTERVAL_MS = Object.freeze({
  minimum: 250,
  maximum: 10_000,
  fallback: 1_000,
});

/**
 * Tailing ticks faster than discovery: a developer watching output notices a
 * second of latency, while a directory listing every second is plenty.
 */
export const TAIL_INTERVAL_MS = Object.freeze({
  minimum: 50,
  maximum: 2_000,
  fallback: 200,
});

export interface OpsPanelRuntimeConfiguration {
  host: string;
  port: number;
  hmrPort: number;
  pollIntervalMs: number;
  tailIntervalMs: number;
}

export function readReservedPort(
  value: string | undefined,
  fallback: number,
  variableName: string,
): number {
  const candidate = value === undefined || value.trim() === "" ? fallback : Number(value);
  if (
    !Number.isInteger(candidate) ||
    candidate < RESERVED_PORT_RANGE.minimum ||
    candidate > RESERVED_PORT_RANGE.maximum
  ) {
    throw new Error(
      `${variableName} must be an integer between ${RESERVED_PORT_RANGE.minimum} and ${RESERVED_PORT_RANGE.maximum}, the range PackScout reserves for local services.`,
    );
  }
  return candidate;
}

/**
 * The panel binds loopback only. A non-loopback value is a configuration error,
 * not an option: remote use is an SSH tunnel that lands on this same bind.
 */
export function readLoopbackBindHost(
  value: string | undefined,
  variableName: string,
): string {
  const candidate = value === undefined || value.trim() === "" ? "127.0.0.1" : value.trim();
  if (!isLoopbackHostname(candidate)) {
    throw new Error(
      `${variableName} must be a loopback address (127.0.0.1, ::1, or localhost). The operations panel never binds a routable interface.`,
    );
  }
  return candidate;
}

function readBoundedIntervalMs(
  value: string | undefined,
  variableName: string,
  bounds: { minimum: number; maximum: number; fallback: number },
): number {
  if (value === undefined || value.trim() === "") return bounds.fallback;
  const candidate = Number(value);
  if (
    !Number.isInteger(candidate) ||
    candidate < bounds.minimum ||
    candidate > bounds.maximum
  ) {
    throw new Error(
      `${variableName} must be an integer between ${bounds.minimum} and ${bounds.maximum} milliseconds.`,
    );
  }
  return candidate;
}

export function readPollIntervalMs(
  value: string | undefined,
  variableName: string,
): number {
  return readBoundedIntervalMs(value, variableName, POLL_INTERVAL_MS);
}

export function readTailIntervalMs(
  value: string | undefined,
  variableName: string,
): number {
  return readBoundedIntervalMs(value, variableName, TAIL_INTERVAL_MS);
}

export function readOpsPanelConfiguration(
  env: Readonly<Record<string, string | undefined>>,
): OpsPanelRuntimeConfiguration {
  const port = readReservedPort(
    env.PACKSCOUT_OPS_PANEL_PORT,
    OPS_PANEL_DEFAULT_PORT,
    "PACKSCOUT_OPS_PANEL_PORT",
  );
  return {
    host: readLoopbackBindHost(
      env.PACKSCOUT_OPS_PANEL_HOST,
      "PACKSCOUT_OPS_PANEL_HOST",
    ),
    port,
    hmrPort: readReservedPort(
      env.PACKSCOUT_OPS_PANEL_HMR_PORT,
      port === RESERVED_PORT_RANGE.maximum
        ? OPS_PANEL_DEFAULT_HMR_PORT
        : port + 1,
      "PACKSCOUT_OPS_PANEL_HMR_PORT",
    ),
    pollIntervalMs: readPollIntervalMs(
      env.PACKSCOUT_OPS_PANEL_POLL_MS,
      "PACKSCOUT_OPS_PANEL_POLL_MS",
    ),
    tailIntervalMs: readTailIntervalMs(
      env.PACKSCOUT_OPS_PANEL_TAIL_MS,
      "PACKSCOUT_OPS_PANEL_TAIL_MS",
    ),
  };
}

export function panelOrigin(host: string, port: number): string {
  const hostname = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${hostname}:${port}`;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

/**
 * Turn a startup failure into something a developer can act on. A taken port is
 * the common case and gets a specific message rather than a stack trace.
 */
export function describeStartupFailure(
  error: unknown,
  { host, port }: { host: string; port: number },
): string {
  const code = errorCode(error);
  if (code === "EADDRINUSE") {
    return [
      `The PackScout operations panel cannot start: ${panelOrigin(host, port)} is already in use.`,
      "Stop whatever is listening there, or choose another port in PackScout's reserved range with",
      `PACKSCOUT_OPS_PANEL_PORT=<${RESERVED_PORT_RANGE.minimum}-${RESERVED_PORT_RANGE.maximum}> npm run dev:ops-panel`,
    ].join(" ");
  }
  if (code === "EACCES") {
    return `The PackScout operations panel cannot bind ${panelOrigin(host, port)}: permission denied.`;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return `The PackScout operations panel failed to start: ${detail}`;
}

/**
 * Loopback predicates for the panel's structural access model.
 *
 * `localhost` is accepted because RFC 6761 reserves it for the loopback
 * interface and browsers resolve it locally, so it cannot be rebound by a
 * hostile DNS answer. Every other name is rejected, which is what defeats DNS
 * rebinding: an attacker domain pointed at 127.0.0.1 still sends its own name
 * in `Host` and its own scheme/host in `Origin`.
 */

const LOOPBACK_HOSTNAMES = new Set(["localhost", "::1", "0:0:0:0:0:0:0:1"]);
const IPV4_LOOPBACK_PATTERN = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u;

export function isLoopbackHostname(value: unknown): boolean {
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

/** Strip the port from a `Host` header value, honouring bracketed IPv6. */
export function hostnameFromHostHeader(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith("[")) {
    const closing = trimmed.indexOf("]");
    if (closing === -1) return null;
    return trimmed.slice(0, closing + 1);
  }
  const colon = trimmed.indexOf(":");
  return colon === -1 ? trimmed : trimmed.slice(0, colon);
}

/**
 * A request whose `Host` header names the loopback interface. Requests without
 * a `Host` header fail closed.
 */
export function isLoopbackHostHeader(value: unknown): boolean {
  return isLoopbackHostname(hostnameFromHostHeader(value));
}

/**
 * A browser `Origin` that belongs to the loopback interface. The opaque origin
 * `null` and any non-http(s) scheme fail closed.
 */
export function isLoopbackOrigin(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === "null") return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return isLoopbackHostname(parsed.hostname);
}

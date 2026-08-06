const MIN_PORT = 1;
const MAX_PORT = 65_535;

export function readPort(
  value: string | undefined,
  fallback: number,
  variableName: string,
): number {
  const candidate = value === undefined ? fallback : Number(value);

  if (
    !Number.isInteger(candidate) ||
    candidate < MIN_PORT ||
    candidate > MAX_PORT
  ) {
    throw new Error(
      `${variableName} must be an integer between ${MIN_PORT} and ${MAX_PORT}.`,
    );
  }

  return candidate;
}

export function readRequiredSecret(
  value: string | undefined,
  variableName: string,
  minimumBytes = 1,
): string {
  if (!value || Buffer.byteLength(value, "utf8") < minimumBytes) {
    throw new Error(
      `${variableName} must contain at least ${minimumBytes} bytes.`,
    );
  }
  return value;
}

export function readPositiveDuration(
  value: string | undefined,
  fallbackMs: number,
  variableName: string,
): number {
  const candidate = value === undefined ? fallbackMs : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    throw new Error(`${variableName} must be a positive integer in milliseconds.`);
  }
  return candidate;
}

export function readAllowedOrigins(
  value: string | undefined,
  fallback: readonly string[],
  variableName: string,
): string[] {
  const candidates = value?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? [
    ...fallback,
  ];
  if (candidates.length === 0) {
    throw new Error(`${variableName} must contain at least one origin.`);
  }
  try {
    return [...new Set(candidates.map((candidate) => new URL(candidate).origin))];
  } catch {
    throw new Error(`${variableName} must contain valid comma-separated origins.`);
  }
}

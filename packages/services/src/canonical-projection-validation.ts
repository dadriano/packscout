import type { AdapterMoney } from "./provider-adapter.ts";

export type CanonicalProjectionValidationCode =
  | "INVALID_IDENTITY"
  | "INVALID_MONEY"
  | "INVALID_TEXT"
  | "INVALID_TIMESTAMP";

export class CanonicalProjectionValidationError extends Error {
  constructor(
    readonly code: CanonicalProjectionValidationCode,
    readonly fieldPath: string,
  ) {
    super("Provider candidate failed canonical validation.");
    this.name = "CanonicalProjectionValidationError";
  }
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}

export function normalizeCanonicalIdentity(
  value: string,
  fieldPath: string,
  maximumLength = 512,
): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maximumLength ||
    hasControlCharacters(normalized)
  ) {
    throw new CanonicalProjectionValidationError("INVALID_IDENTITY", fieldPath);
  }
  return normalized;
}

export function normalizeOptionalText(
  value: string | null | undefined,
  fieldPath: string,
  maximumLength = 2_000,
): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim();
  if (normalized.length === 0) return null;
  if (normalized.length > maximumLength || hasControlCharacters(normalized)) {
    throw new CanonicalProjectionValidationError("INVALID_TEXT", fieldPath);
  }
  return normalized;
}

const instantPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function normalizeCanonicalTimestamp(
  value: string,
  fieldPath: string,
): Date {
  if (!instantPattern.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new CanonicalProjectionValidationError("INVALID_TIMESTAMP", fieldPath);
  }
  return new Date(value);
}

export interface CanonicalMoney {
  readonly amountMinor: number;
  readonly currency: string;
}

export function normalizeCanonicalMoney(
  value: AdapterMoney | null | undefined,
  fieldPath: string,
): CanonicalMoney | null {
  if (value === null || value === undefined) return null;
  const currency = normalizeCanonicalIdentity(
    value.currency,
    `${fieldPath}.currency`,
    128,
  );
  const isTokenAddress = /^0x[0-9a-fA-F]{40}$/.test(currency);
  const normalizedCurrency = isTokenAddress ? currency : currency.toUpperCase();
  if (
    (!isTokenAddress && !/^[A-Z0-9]{2,12}$/.test(normalizedCurrency)) ||
    !Number.isFinite(value.amount) ||
    value.amount < 0 ||
    Math.abs(value.amount * 100) > Number.MAX_SAFE_INTEGER
  ) {
    throw new CanonicalProjectionValidationError(
      "INVALID_MONEY",
      `${fieldPath}.amount`,
    );
  }
  const amountMinor = Math.floor(value.amount * 100 + 0.5);
  if (!Number.isSafeInteger(amountMinor)) {
    throw new CanonicalProjectionValidationError(
      "INVALID_MONEY",
      `${fieldPath}.amount`,
    );
  }
  return { amountMinor, currency: normalizedCurrency };
}

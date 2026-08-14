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
  readonly minorUnitExponent: number;
}

function decimalAmountToMinorUnits(
  amount: number,
  minorUnitExponent: number,
): number | null {
  if (!Number.isFinite(amount) || amount < 0) return null;
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(amount.toString());
  if (!match) return null;
  const fractionalDigits = match[2] ?? "";
  const scientificExponent = Number(match[3] ?? "0");
  if (!Number.isSafeInteger(scientificExponent)) return null;

  const digits = BigInt(`${match[1]}${fractionalDigits}`);
  const scale = scientificExponent - fractionalDigits.length + minorUnitExponent;
  let rounded: bigint;
  if (scale >= 0) {
    rounded = digits * 10n ** BigInt(scale);
  } else {
    const divisor = 10n ** BigInt(-scale);
    const quotient = digits / divisor;
    const remainder = digits % divisor;
    rounded = quotient + (remainder * 2n >= divisor ? 1n : 0n);
  }
  return rounded <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(rounded) : null;
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
  const normalizedCurrency = currency.toUpperCase();
  const minorUnitExponent = normalizedCurrency === "USDC"
    ? 6
    : normalizedCurrency === "USD"
      ? 2
      : null;
  if (
    minorUnitExponent === null ||
    !Number.isFinite(value.amount) ||
    value.amount < 0
  ) {
    throw new CanonicalProjectionValidationError(
      "INVALID_MONEY",
      `${fieldPath}.amount`,
    );
  }
  const amountMinor = decimalAmountToMinorUnits(value.amount, minorUnitExponent);
  if (amountMinor === null) {
    throw new CanonicalProjectionValidationError(
      "INVALID_MONEY",
      `${fieldPath}.amount`,
    );
  }
  return { amountMinor, currency: normalizedCurrency, minorUnitExponent };
}

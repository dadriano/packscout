import { Prisma as ProviderPrisma } from "../prisma/generated/provider/index.js";
import {
  normalizeJsonObject, normalizeMoneyDecimal, normalizeRateDecimal,
  ProviderCanonicalInputError, ProviderCanonicalWriteConflictError,
  requireCurrency, requireDate, requireNonEmptyText, type CanonicalJsonObject,
} from "./provider-canonical-contract.ts";

export function nullableText(value: string | null, field: string): string | null {
  return value === null ? null : requireNonEmptyText(value, field);
}

export function nullableMoney(value: string | null, field: string): string | null {
  return value === null ? null : normalizeMoneyDecimal(value, field);
}

export function nullableRate(value: string | null, field: string): string | null {
  return value === null ? null : normalizeRateDecimal(value, field);
}

export function nullableCurrency(value: string | null, field: string): string | null {
  return value === null ? null : requireCurrency(value, field);
}

export function nullableDate(value: Date | null, field: string): Date | null {
  return value === null ? null : requireDate(value, field);
}

export function nullableJson(
  value: CanonicalJsonObject | null,
  field: string,
): ProviderPrisma.InputJsonObject | typeof ProviderPrisma.DbNull {
  return value === null
    ? ProviderPrisma.DbNull
    : toPrismaJson(normalizeJsonObject(value, field));
}

export function toPrismaJson(value: CanonicalJsonObject): ProviderPrisma.InputJsonObject {
  return value as unknown as ProviderPrisma.InputJsonObject;
}

export function requireNonnegativeBigInt(value: bigint | null, field: string): bigint | null {
  if (value !== null && (typeof value !== "bigint" || value < 0n)) {
    throw new ProviderCanonicalInputError(`${field} must be a non-negative bigint or null.`);
  }
  return value;
}

export function requirePositiveBigInt(value: bigint, field: string): bigint {
  if (typeof value !== "bigint" || value <= 0n) {
    throw new ProviderCanonicalInputError(`${field} must be a positive bigint.`);
  }
  return value;
}

export function requireNonnegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ProviderCanonicalInputError(`${field} must be a non-negative safe integer.`);
  }
  return value;
}

export function requireNullableYear(value: number | null): number | null {
  if (value !== null && (!Number.isInteger(value) || value < 1_000 || value > 9_999)) {
    throw new ProviderCanonicalInputError("year must be a four-digit integer or null.");
  }
  return value;
}

export function assertExpectedVersion(expected: bigint | undefined, actual: bigint | null): void {
  if (expected === undefined) return;
  if (actual === null ? expected !== 0n : expected !== actual) {
    throw new ProviderCanonicalWriteConflictError();
  }
}

function comparable(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value === ProviderPrisma.DbNull) return null;
  if (value instanceof Date) return ["date", value.toISOString()];
  if (typeof value === "bigint") return ["bigint", value.toString()];
  if (ProviderPrisma.Decimal.isDecimal(value)) {
    return normalizeMoneyDecimal(value.toFixed());
  }
  if (Array.isArray(value)) return value.map(comparable);
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object).sort().map((key) => [key, comparable(object[key])]),
    );
  }
  return value;
}

export function hasSameMaterialFields(
  row: object,
  next: Readonly<Record<string, unknown>>,
): boolean {
  const current = row as unknown as Record<string, unknown>;
  return Object.entries(next).every(([key, value]) => (
    JSON.stringify(comparable(current[key])) === JSON.stringify(comparable(value))
  ));
}


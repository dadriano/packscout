const maximumObservedBasisPoints = 10_000_000;

export function boundedRoundedRatio(
  numerator: bigint,
  denominator: bigint,
): number | null {
  if (numerator < 0n || denominator <= 0n) return null;
  const rounded = (numerator * 2n + denominator) / (denominator * 2n);
  return rounded <= BigInt(maximumObservedBasisPoints)
    ? Number(rounded)
    : null;
}

export function finiteDecimalRatio(value: number): Readonly<{
  numerator: bigint;
  denominator: bigint;
}> | null {
  if (!Number.isFinite(value) || value < 0) return null;
  const [coefficient, exponentText] = value.toString().toLowerCase().split("e");
  if (!coefficient) return null;
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  if (!Number.isSafeInteger(exponent)) return null;
  const [whole, fraction = ""] = coefficient.split(".");
  if (!whole || !/^\d+$/.test(whole) || !/^\d*$/.test(fraction)) return null;
  let numerator = BigInt(`${whole}${fraction}`);
  const scale = fraction.length - exponent;
  if (scale < 0) {
    numerator *= 10n ** BigInt(-scale);
    return { numerator, denominator: 1n };
  }
  return { numerator, denominator: 10n ** BigInt(scale) };
}

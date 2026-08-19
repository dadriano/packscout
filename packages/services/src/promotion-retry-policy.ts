export function promotionRetryDelay(input: Readonly<{
  currentRetryCount: number;
  initialRetryMilliseconds: number;
  maximumRetryMilliseconds: number;
  retryAfterMilliseconds: number | null;
  randomFraction: number;
}>): number {
  const exponent = Math.min(20, Math.max(0, input.currentRetryCount));
  const ceiling = Math.min(
    input.maximumRetryMilliseconds,
    input.initialRetryMilliseconds * (2 ** exponent),
  );
  const fraction = Number.isFinite(input.randomFraction)
    ? Math.min(1, Math.max(0, input.randomFraction))
    : 0.5;
  const jittered = Math.round((ceiling / 2) + (ceiling / 2) * fraction);
  return Math.min(
    input.maximumRetryMilliseconds,
    Math.max(jittered, input.retryAfterMilliseconds ?? 0),
  );
}

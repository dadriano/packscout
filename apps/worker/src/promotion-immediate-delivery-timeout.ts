const MAXIMUM_IMMEDIATE_DELIVERY_TIMEOUT_MILLISECONDS = 1_000;

export function promotionImmediateDeliveryTimeout(
  value: number | undefined,
): number {
  const timeout = value ?? MAXIMUM_IMMEDIATE_DELIVERY_TIMEOUT_MILLISECONDS;
  if (
    !Number.isInteger(timeout)
    || timeout < 1
    || timeout > MAXIMUM_IMMEDIATE_DELIVERY_TIMEOUT_MILLISECONDS
  ) {
    throw new RangeError("Promotion immediate delivery timeout is invalid.");
  }
  return timeout;
}

/** Bounds an optional latency hint; durable polling remains authoritative. */
export async function waitForPromotionImmediateDelivery<T>(
  operation: () => Promise<T>,
  timeoutMilliseconds: number,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Promotion immediate delivery timed out.")),
          timeoutMilliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

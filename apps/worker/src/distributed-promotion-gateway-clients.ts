import type { PinnedProviderReleaseInputs } from "@packscout/database";
import { readProviderPromotionBootstrapStream } from
  "./distributed-promotion-bootstrap-stream.ts";
import {
  DistributedPromotionGatewayAbortedError,
  DistributedPromotionGatewayError,
  DistributedPromotionGatewayResponseError,
} from "./distributed-promotion-gateway-errors.ts";

export {
  DistributedPromotionGatewayAbortedError,
  DistributedPromotionGatewayError,
  DistributedPromotionGatewayResponseError,
} from "./distributed-promotion-gateway-errors.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface DistributedPromotionGatewayOptions {
  readonly baseUrl: string;
  readonly bearerToken: Uint8Array;
  readonly timeoutMilliseconds: number;
  readonly fetch?: typeof fetch;
}

function rejectWhenAborted(signal: AbortSignal): Readonly<{
  promise: Promise<never>;
  dispose(): void;
}> {
  let aborted!: () => void;
  const promise = new Promise<never>((_resolve, reject) => {
    aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
  return Object.freeze({
    promise,
    dispose() { signal.removeEventListener("abort", aborted); },
  });
}

async function requestGateway<T>(
  options: DistributedPromotionGatewayOptions,
  path: string,
  body: unknown,
  consume: (response: Response, signal: AbortSignal) => Promise<T>,
  callerSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const deadline = performance.now() + options.timeoutMilliseconds;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => controller.abort(), options.timeoutMilliseconds);
  const requireActiveRequest = () => {
    if (!controller.signal.aborted && performance.now() >= deadline) {
      controller.abort();
    }
    controller.signal.throwIfAborted();
  };
  try {
    requireActiveRequest();
    const response = await (options.fetch ?? fetch)(
      new URL(path, options.baseUrl),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${Buffer.from(options.bearerToken)
            .toString("base64")}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: "error",
      },
    );
    if (!response.ok) {
      if (response.status >= 500) throw new DistributedPromotionGatewayError();
      throw new DistributedPromotionGatewayResponseError();
    }
    requireActiveRequest();
    const abortBoundary = rejectWhenAborted(controller.signal);
    try {
      const result = await Promise.race([
        consume(response, controller.signal),
        abortBoundary.promise,
      ]);
      requireActiveRequest();
      return result;
    } finally {
      abortBoundary.dispose();
    }
  } catch (error) {
    if (callerSignal?.aborted) {
      throw new DistributedPromotionGatewayAbortedError();
    }
    if (
      error instanceof DistributedPromotionGatewayError ||
      error instanceof DistributedPromotionGatewayResponseError ||
      error instanceof DistributedPromotionGatewayAbortedError
    ) throw error;
    throw new DistributedPromotionGatewayError();
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

export class ProviderPromotionBootstrapGatewayClient {
  constructor(private readonly options: DistributedPromotionGatewayOptions) {
    if (
      !Number.isSafeInteger(options.timeoutMilliseconds) ||
      options.timeoutMilliseconds < 100 ||
      options.timeoutMilliseconds > 30_000
    ) throw new TypeError("Provider promotion bootstrap timeout is invalid.");
  }

  async load(
    providerId: string,
    signal?: AbortSignal,
  ): Promise<PinnedProviderReleaseInputs> {
    if (!UUID_PATTERN.test(providerId)) {
      throw new TypeError("Provider promotion bootstrap scope is invalid.");
    }
    return requestGateway(
      this.options,
      "/api/internal/promotion-jobs/provider-bootstrap",
      {
        providerId: providerId.toLowerCase(),
        requestBudgetMilliseconds: this.options.timeoutMilliseconds,
      },
      (response, requestSignal) => readProviderPromotionBootstrapStream(
        response,
        providerId,
        requestSignal,
      ),
      signal,
    );
  }
}

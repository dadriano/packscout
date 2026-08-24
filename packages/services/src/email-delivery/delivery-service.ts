import {
  EMAIL_PROVIDER_MESSAGE_ID_MAX_LENGTH,
  emailMessageKindSchema,
  renderedEmailMessageSchema,
  type EmailDeliveryResult,
  type EmailDeliveryStatus,
  type RenderedEmailMessage,
} from "@packscout/contracts";
import type {
  EmailAdapterSendResult,
  EmailDeliveryAdapter,
} from "./adapter.ts";
import type { EmailDeliveryAdapterRegistry } from "./registry.ts";
import type { ProviderClock } from "../provider-configuration-service.ts";
import {
  normalizeEmailDeliveryErrorCode,
  sanitizeEmailProviderErrorText,
  withEmailTransportDeadline,
} from "./transport.ts";

/**
 * The message delivery boundary. Consumers never name a provider: they hand
 * this service a rendered message, and configuration decides whether it is
 * sent through the resolved adapter, rendered to the local console, or
 * skipped. Readiness answers, before anything is persisted, whether a
 * delivery-critical message could actually be delivered right now.
 */

export const EMAIL_DELIVERY_MODE_VARIABLE = "PACKSCOUT_EMAIL_DELIVERY_MODE";
export const EMAIL_REQUIRE_DELIVERY_VARIABLE =
  "PACKSCOUT_EMAIL_REQUIRE_DELIVERY";

export type EmailDeliveryMode =
  | { readonly kind: "auto" }
  | { readonly kind: "disabled" }
  | { readonly kind: "console" }
  | { readonly kind: "adapter"; readonly name: string };

export type EmailDeliveryReadiness =
  | { readonly ready: true }
  | {
      readonly ready: false;
      readonly reason:
        | "delivery_disabled"
        | "console_mode"
        | "missing_configuration";
    };

export interface EmailDeliveryResolution {
  readonly mode: EmailDeliveryMode;
  /** The adapter a send would use: the default in auto, the named one, else null. */
  readonly adapter: EmailDeliveryAdapter | null;
  readonly productionLike: boolean;
  readonly readiness: EmailDeliveryReadiness;
}

/**
 * Resolves the delivery mode from server-side configuration. Unrecognized
 * values resolve to automatic rather than failing, so a typo can never take
 * message delivery down with it.
 */
export function resolveEmailDeliveryMode(
  registry: EmailDeliveryAdapterRegistry,
  env: NodeJS.ProcessEnv = process.env,
): EmailDeliveryMode {
  const raw = env[EMAIL_DELIVERY_MODE_VARIABLE]?.trim().toLowerCase();
  if (raw === "disabled") return { kind: "disabled" };
  if (raw === "console") return { kind: "console" };
  if (raw !== undefined && raw !== "" && raw !== "auto" && registry.has(raw)) {
    return { kind: "adapter", name: raw };
  }
  return { kind: "auto" };
}

/**
 * Production-like contexts fail closed on delivery problems. The repository
 * marks production runtimes with NODE_ENV; the explicit variable lets a
 * preproduction environment opt into the same strictness.
 */
export function isProductionLikeEmailEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    env.NODE_ENV === "production" ||
    env[EMAIL_REQUIRE_DELIVERY_VARIABLE] === "1"
  );
}

function adapterIsConfigured(
  adapter: EmailDeliveryAdapter,
  env: NodeJS.ProcessEnv,
): boolean {
  try {
    return adapter.isConfigured(env) === true;
  } catch {
    return false;
  }
}

/** The current mode, the adapter a send would use, and the readiness answer. */
export function resolveEmailDelivery(
  registry: EmailDeliveryAdapterRegistry,
  env: NodeJS.ProcessEnv = process.env,
): EmailDeliveryResolution {
  const mode = resolveEmailDeliveryMode(registry, env);
  const productionLike = isProductionLikeEmailEnvironment(env);
  const adapter =
    mode.kind === "adapter"
      ? registry.resolve(mode.name)
      : mode.kind === "auto"
        ? registry.defaultAdapter()
        : null;
  return { mode, adapter, productionLike, readiness: readiness() };

  function readiness(): EmailDeliveryReadiness {
    switch (mode.kind) {
      case "disabled":
        return productionLike
          ? { ready: false, reason: "delivery_disabled" }
          : { ready: true };
      case "console":
        return productionLike
          ? { ready: false, reason: "console_mode" }
          : { ready: true };
      case "adapter":
        return adapter !== null && adapterIsConfigured(adapter, env)
          ? { ready: true }
          : { ready: false, reason: "missing_configuration" };
      case "auto":
        if (adapter !== null && adapterIsConfigured(adapter, env)) {
          return { ready: true };
        }
        return productionLike
          ? { ready: false, reason: "missing_configuration" }
          : { ready: true };
    }
  }
}

/**
 * Whether a delivery-critical message can actually be delivered under the
 * current configuration. Local automatic and console modes stay available for
 * development; production-like environments and explicitly named adapters
 * fail closed instead of quietly accepting an undeliverable operation.
 */
export function resolveEmailDeliveryReadiness(
  registry: EmailDeliveryAdapterRegistry,
  env: NodeJS.ProcessEnv = process.env,
): EmailDeliveryReadiness {
  return resolveEmailDelivery(registry, env).readiness;
}

export interface EmailDeliveryConsoleRenderer {
  render(message: RenderedEmailMessage): void;
}

/**
 * The one sanctioned place a message body may be shown: local console mode.
 * It never runs in production-like environments.
 */
const defaultConsoleRenderer: EmailDeliveryConsoleRenderer = {
  render(message) {
    console.info("[email-delivery:console]", {
      kind: message.kind,
      toEmail: message.toEmail,
      subject: message.subject,
      textBody: message.textBody,
    });
  },
};

/** Bounded, content-free record of one delivery outcome. */
export interface EmailDeliveryLogEntry {
  readonly event: "email_delivery";
  readonly level: "info" | "error";
  readonly status: EmailDeliveryStatus;
  readonly code: string;
  readonly mode: EmailDeliveryMode["kind"];
  readonly provider: string | null;
  readonly messageKind: string;
  readonly occurredAt: string;
}

export interface EmailDeliveryObservability {
  log(entry: EmailDeliveryLogEntry): void;
}

const noopObservability: EmailDeliveryObservability = {
  log() {},
};

export interface EmailDeliveryServiceOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  /** Bound on each provider send, in milliseconds; 100..30_000, default 10_000. */
  readonly sendTimeoutMs?: number;
  readonly consoleRenderer?: EmailDeliveryConsoleRenderer;
  readonly observability?: EmailDeliveryObservability;
  readonly clock?: ProviderClock;
}

const DEFAULT_SEND_TIMEOUT_MS = 10_000;
/** Grace beyond the transport deadline before the boundary gives up itself. */
const ADAPTER_SETTLE_GRACE_MS = 100;
const unresponsiveAdapter = Symbol("unresponsive-adapter");

async function settleWithinBound<T>(
  promise: Promise<T>,
  boundMilliseconds: number,
): Promise<T | typeof unresponsiveAdapter> {
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<typeof unresponsiveAdapter>((resolve) => {
    timer = setTimeout(() => resolve(unresponsiveAdapter), boundMilliseconds);
  });
  try {
    return await Promise.race([promise, bound]);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeProviderMessageId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length >= 1 &&
    trimmed.length <= EMAIL_PROVIDER_MESSAGE_ID_MAX_LENGTH
    ? trimmed
    : null;
}

export class EmailDeliveryService {
  readonly #env: NodeJS.ProcessEnv;
  readonly #fetchImpl: typeof fetch;
  readonly #sendTimeoutMs: number;
  readonly #consoleRenderer: EmailDeliveryConsoleRenderer;
  readonly #observability: EmailDeliveryObservability;
  readonly #clock: ProviderClock;

  constructor(
    private readonly registry: EmailDeliveryAdapterRegistry,
    options: EmailDeliveryServiceOptions = {},
  ) {
    const timeout = options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 30_000) {
      throw new RangeError("Email delivery send timeout is out of bounds.");
    }
    this.#env = options.env ?? process.env;
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#sendTimeoutMs = timeout;
    this.#consoleRenderer = options.consoleRenderer ?? defaultConsoleRenderer;
    this.#observability = options.observability ?? noopObservability;
    this.#clock = options.clock ?? { now: () => new Date() };
  }

  resolve(): EmailDeliveryResolution {
    return resolveEmailDelivery(this.registry, this.#env);
  }

  readiness(): EmailDeliveryReadiness {
    return this.resolve().readiness;
  }

  /** Sends one rendered message. Resolves to a result and never rejects. */
  async send(message: RenderedEmailMessage): Promise<EmailDeliveryResult> {
    const resolution = this.resolve();
    const parsed = renderedEmailMessageSchema.safeParse(message);
    if (!parsed.success) {
      return this.record(resolution, this.safeKind(message), {
        status: "failed",
        provider: null,
        errorCode: "EMAIL_MESSAGE_INVALID",
        message: "The rendered message does not match the delivery contract.",
        retryable: false,
      });
    }
    const kind = parsed.data.kind;
    const { mode, adapter, productionLike } = resolution;
    if (mode.kind === "disabled") {
      return this.record(resolution, kind, {
        status: "skipped",
        reason: "delivery_disabled",
      });
    }
    if (mode.kind === "console") {
      if (!productionLike) {
        try {
          this.#consoleRenderer.render(parsed.data);
        } catch {
          // A broken local renderer must not change the delivery outcome.
        }
      }
      return this.record(resolution, kind, {
        status: "skipped",
        reason: "console_mode",
      });
    }
    if (adapter === null) {
      return this.record(
        resolution,
        kind,
        productionLike
          ? {
              status: "failed",
              provider: null,
              errorCode: "EMAIL_DELIVERY_UNCONFIGURED",
              message: "No email delivery adapter is registered.",
              retryable: false,
            }
          : { status: "skipped", reason: "missing_configuration" },
      );
    }
    if (!adapterIsConfigured(adapter, this.#env)) {
      return this.record(
        resolution,
        kind,
        productionLike || mode.kind === "adapter"
          ? {
              status: "failed",
              provider: adapter.name,
              errorCode: normalizeEmailDeliveryErrorCode(
                adapter.missingConfiguration.errorCode,
                "EMAIL_DELIVERY_UNCONFIGURED",
              ),
              message: sanitizeEmailProviderErrorText(
                adapter.missingConfiguration.message,
              ),
              retryable: false,
            }
          : { status: "skipped", reason: "missing_configuration" },
      );
    }
    return this.record(
      resolution,
      kind,
      await this.dispatch(adapter, parsed.data),
    );
  }

  private async dispatch(
    adapter: EmailDeliveryAdapter,
    message: RenderedEmailMessage,
  ): Promise<EmailDeliveryResult> {
    let adapterResult: EmailAdapterSendResult | typeof unresponsiveAdapter;
    try {
      adapterResult = await settleWithinBound(
        adapter.send(message, {
          env: this.#env,
          fetchImpl: withEmailTransportDeadline(
            this.#fetchImpl,
            this.#sendTimeoutMs,
          ),
        }),
        this.#sendTimeoutMs + ADAPTER_SETTLE_GRACE_MS,
      );
    } catch (error) {
      return {
        status: "failed",
        provider: adapter.name,
        errorCode: "EMAIL_PROVIDER_SEND_FAILED",
        message: sanitizeEmailProviderErrorText(
          error instanceof Error ? error.message : String(error),
        ),
        retryable: true,
      };
    }
    if (adapterResult === unresponsiveAdapter) {
      return {
        status: "failed",
        provider: adapter.name,
        errorCode: "EMAIL_DELIVERY_TIMEOUT",
        message: "The delivery adapter gave no answer within the send bound.",
        retryable: true,
      };
    }
    if (adapterResult?.status === "sent") {
      return {
        status: "sent",
        provider: adapter.name,
        providerMessageId: normalizeProviderMessageId(
          adapterResult.providerMessageId,
        ),
      };
    }
    if (adapterResult?.status === "failed") {
      return {
        status: "failed",
        provider: adapter.name,
        errorCode: normalizeEmailDeliveryErrorCode(
          adapterResult.errorCode,
          "EMAIL_PROVIDER_FAILED",
        ),
        message: sanitizeEmailProviderErrorText(adapterResult.message),
        retryable: adapterResult.retryable === true,
      };
    }
    return {
      status: "failed",
      provider: adapter.name,
      errorCode: "EMAIL_PROVIDER_RESULT_INVALID",
      message: "The delivery adapter returned an unrecognized result shape.",
      retryable: false,
    };
  }

  private safeKind(message: RenderedEmailMessage): string {
    return emailMessageKindSchema.safeParse(message?.kind).success
      ? message.kind
      : "unknown";
  }

  private record(
    resolution: EmailDeliveryResolution,
    messageKind: string,
    result: EmailDeliveryResult,
  ): EmailDeliveryResult {
    try {
      this.#observability.log({
        event: "email_delivery",
        level: result.status === "failed" ? "error" : "info",
        status: result.status,
        code:
          result.status === "sent"
            ? "EMAIL_DELIVERY_SENT"
            : result.status === "skipped"
              ? `EMAIL_DELIVERY_SKIPPED_${result.reason.toUpperCase()}`
              : result.errorCode,
        mode: resolution.mode.kind,
        provider:
          result.status === "sent"
            ? result.provider
            : result.status === "failed"
              ? result.provider
              : (resolution.adapter?.name ?? null),
        messageKind,
        occurredAt: this.#clock.now().toISOString(),
      });
    } catch {
      // Delivery outcomes must not depend on observability availability.
    }
    return result;
  }
}

import type { RenderedEmailMessage } from "@packscout/contracts";

/**
 * The provider adapter contract behind the message delivery boundary. Product
 * code never sees an adapter: it hands the boundary a rendered message, and
 * the boundary resolves one of these by mode and registration. Every adapter
 * must pass the published contract suite in `adapter-contract-suite.ts`.
 */

/** The environment and injectable transport an adapter sends through. */
export interface EmailAdapterSendContext {
  readonly env: NodeJS.ProcessEnv;
  /**
   * The only transport an adapter may use to reach its provider. The boundary
   * injects a deadline-bounded implementation, so every send is bounded in
   * time; tests inject fakes so adapter behavior needs no network.
   */
  readonly fetchImpl: typeof fetch;
}

/** What an unconfigured adapter is missing, in stable, secret-free words. */
export interface EmailAdapterMissingConfiguration {
  /** Stable code matching the delivery error-code alphabet. */
  readonly errorCode: string;
  /** Names the missing variables. Never includes a value or a secret. */
  readonly message: string;
}

export type EmailAdapterSendResult =
  | {
      readonly status: "sent";
      /** The provider's message identifier when it supplied one. */
      readonly providerMessageId: string | null;
    }
  | {
      readonly status: "failed";
      /** Stable code matching the delivery error-code alphabet. */
      readonly errorCode: string;
      /** Sanitized, length-bounded detail. Never raw provider text. */
      readonly message: string;
      /**
       * Transport, network, timeout, rate-limit, and provider server errors
       * are retryable; rejected recipients, malformed messages, and missing
       * configuration are not.
       */
      readonly retryable: boolean;
    };

export interface EmailDeliveryAdapter {
  /** Stable registered name matching the provider-name alphabet. */
  readonly name: string;
  readonly missingConfiguration: EmailAdapterMissingConfiguration;
  /** Whether this adapter can send with the given environment. Never throws. */
  isConfigured(env: NodeJS.ProcessEnv): boolean;
  /**
   * Sends one rendered message. Resolves to a structured result and never
   * rejects: provider errors become classified `failed` results.
   */
  send(
    message: RenderedEmailMessage,
    context: EmailAdapterSendContext,
  ): Promise<EmailAdapterSendResult>;
}

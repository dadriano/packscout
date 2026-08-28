import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMAIL_DELIVERY_ERROR_MESSAGE_MAX_LENGTH,
  emailDeliveryErrorCodeSchema,
  emailProviderNameSchema,
  renderedEmailMessageSchema,
  type RenderedEmailMessage,
} from "@packscout/contracts";
import type {
  EmailAdapterSendResult,
  EmailDeliveryAdapter,
} from "./adapter.ts";
import { withEmailTransportDeadline } from "./transport.ts";

/**
 * The published contract every delivery adapter must satisfy. An adapter's
 * test file calls {@link runEmailDeliveryAdapterContractSuite} with fake
 * transports speaking its provider's wire shapes; the suite then enforces the
 * full behavior matrix, so an adapter that violates any behavior fails the
 * build. {@link emailDeliveryAdapterContractChecks} exposes the same checks
 * individually for proving that a non-conforming adapter is rejected.
 */

export interface EmailAdapterContractScenario {
  /** A fake transport producing this scenario's provider response. */
  readonly fetchImpl: typeof fetch;
}

export interface EmailAdapterContractSentScenario
  extends EmailAdapterContractScenario {
  /** When given, the adapter must surface exactly this identifier. */
  readonly expectedProviderMessageId?: string | null;
}

export interface EmailAdapterContractLeakScenario
  extends EmailAdapterContractScenario {
  /** Secrets the scenario's provider response embeds in its error text. */
  readonly leakedSecrets: readonly string[];
}

export interface EmailDeliveryAdapterContractOptions {
  readonly adapter: EmailDeliveryAdapter;
  readonly environments: {
    /** An environment in which the adapter must report configured. */
    readonly configured: NodeJS.ProcessEnv;
    /** An environment in which the adapter must report unconfigured. */
    readonly unconfigured: NodeJS.ProcessEnv;
  };
  readonly scenarios: {
    readonly sent: EmailAdapterContractSentScenario;
    readonly rejectedRecipient: EmailAdapterContractScenario;
    readonly malformedMessage: EmailAdapterContractScenario;
    readonly rateLimited: EmailAdapterContractScenario;
    readonly serverError: EmailAdapterContractScenario;
    readonly leakingProviderError: EmailAdapterContractLeakScenario;
  };
  /** Optional fixture override; must satisfy the rendered-message contract. */
  readonly message?: RenderedEmailMessage;
}

export interface EmailDeliveryAdapterContractCheck {
  readonly name: string;
  run(): Promise<void>;
}

export const emailAdapterContractFixtureMessage: RenderedEmailMessage = {
  kind: "contract_fixture",
  toEmail: "contract-fixture-recipient@example.test",
  subject: "Adapter contract fixture",
  textBody: "Adapter contract fixture body.",
  htmlBody: "<p>Adapter contract fixture body.</p>",
};

const CONTRACT_TRANSPORT_DEADLINE_MS = 50;
const CONTRACT_SETTLE_WATCHDOG_MS = 1_000;

function networkErrorFetch(): typeof fetch {
  return () => Promise.reject(new TypeError("fetch failed: network unreachable"));
}

function hangingFetch(): typeof fetch {
  return () => new Promise<Response>(() => {});
}

async function settleOrFail(
  promise: Promise<EmailAdapterSendResult>,
  label: string,
): Promise<EmailAdapterSendResult> {
  let timer: NodeJS.Timeout | undefined;
  const watchdog = new Promise<"watchdog">((resolve) => {
    timer = setTimeout(() => resolve("watchdog"), CONTRACT_SETTLE_WATCHDOG_MS);
  });
  let outcome: EmailAdapterSendResult | "watchdog";
  try {
    outcome = await Promise.race([promise, watchdog]);
  } catch (error) {
    assert.fail(
      `send rejected during "${label}" instead of resolving to a failed result: ${String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (outcome === "watchdog") {
    assert.fail(`send did not settle within the contract bound in "${label}"`);
  }
  return outcome;
}

function assertFailedShape(
  result: EmailAdapterSendResult,
  message: RenderedEmailMessage,
  label: string,
): asserts result is Extract<EmailAdapterSendResult, { status: "failed" }> {
  assert.equal(result.status, "failed", `"${label}" must report failed`);
  assert.equal(
    emailDeliveryErrorCodeSchema.safeParse(result.errorCode).success,
    true,
    `"${label}" must carry a stable error code, got ${JSON.stringify(
      result.errorCode,
    )}`,
  );
  assert.equal(typeof result.message, "string", `"${label}" message text`);
  assert.ok(
    result.message.length >= 1 &&
      result.message.length <= EMAIL_DELIVERY_ERROR_MESSAGE_MAX_LENGTH,
    `"${label}" message text must be bounded`,
  );
  assert.ok(
    !result.message.includes(message.toEmail),
    `"${label}" message text must not contain the recipient address`,
  );
  assert.equal(
    typeof result.retryable,
    "boolean",
    `"${label}" must classify retryability`,
  );
}

export function emailDeliveryAdapterContractChecks(
  options: EmailDeliveryAdapterContractOptions,
): readonly EmailDeliveryAdapterContractCheck[] {
  const { adapter, environments, scenarios } = options;
  const message = options.message ?? emailAdapterContractFixtureMessage;
  const send = (fetchImpl: typeof fetch, env: NodeJS.ProcessEnv) =>
    adapter.send(message, { env, fetchImpl });
  const classification = (
    label: string,
    scenario: EmailAdapterContractScenario,
    retryable: boolean,
  ): EmailDeliveryAdapterContractCheck => ({
    name: label,
    run: async () => {
      const result = await settleOrFail(
        send(scenario.fetchImpl, environments.configured),
        label,
      );
      assertFailedShape(result, message, label);
      assert.equal(
        result.retryable,
        retryable,
        `"${label}" must be ${retryable ? "retryable" : "non-retryable"}`,
      );
    },
  });

  return [
    {
      name: "identity: name and missing-configuration description are stable and bounded",
      run: async () => {
        assert.equal(
          emailProviderNameSchema.safeParse(adapter.name).success,
          true,
          "adapter name must match the provider-name alphabet",
        );
        assert.equal(
          emailDeliveryErrorCodeSchema.safeParse(
            adapter.missingConfiguration?.errorCode,
          ).success,
          true,
          "missing-configuration error code must be stable",
        );
        assert.equal(
          typeof adapter.missingConfiguration?.message,
          "string",
          "missing-configuration description must exist",
        );
        assert.ok(
          adapter.missingConfiguration.message.trim().length >= 1 &&
            adapter.missingConfiguration.message.length <=
              EMAIL_DELIVERY_ERROR_MESSAGE_MAX_LENGTH,
          "missing-configuration description must be bounded",
        );
        assert.equal(
          renderedEmailMessageSchema.safeParse(message).success,
          true,
          "the contract fixture message must satisfy the rendered-message contract",
        );
      },
    },
    {
      name: "configuration: reports configured and unconfigured environments without throwing",
      run: async () => {
        assert.equal(adapter.isConfigured(environments.configured), true);
        assert.equal(adapter.isConfigured(environments.unconfigured), false);
        assert.equal(typeof adapter.isConfigured({}), "boolean");
      },
    },
    {
      name: "success: a delivered send reports sent with the provider message identifier",
      run: async () => {
        const label = "success";
        const result = await settleOrFail(
          send(scenarios.sent.fetchImpl, environments.configured),
          label,
        );
        assert.equal(result.status, "sent", "a delivered send must report sent");
        assert.ok(result.status === "sent");
        if (scenarios.sent.expectedProviderMessageId !== undefined) {
          assert.equal(
            result.providerMessageId,
            scenarios.sent.expectedProviderMessageId,
          );
        }
        if (result.providerMessageId !== null) {
          assert.equal(typeof result.providerMessageId, "string");
          assert.ok(
            result.providerMessageId.length >= 1 &&
              result.providerMessageId.length <= 256,
            "provider message identifiers must be bounded",
          );
        }
      },
    },
    classification(
      "classification: a rejected recipient is a non-retryable failure",
      scenarios.rejectedRecipient,
      false,
    ),
    classification(
      "classification: a malformed message rejection is a non-retryable failure",
      scenarios.malformedMessage,
      false,
    ),
    classification(
      "classification: provider rate limiting is a retryable failure",
      scenarios.rateLimited,
      true,
    ),
    classification(
      "classification: a provider server error is a retryable failure",
      scenarios.serverError,
      true,
    ),
    classification(
      "classification: a network transport failure is a retryable failure",
      { fetchImpl: networkErrorFetch() },
      true,
    ),
    {
      name: "classification: sending while unconfigured fails closed without retry",
      run: async () => {
        const label = "unconfigured send";
        const result = await settleOrFail(
          send(scenarios.sent.fetchImpl, environments.unconfigured),
          label,
        );
        assertFailedShape(result, message, label);
        assert.equal(result.retryable, false);
        assert.equal(result.errorCode, adapter.missingConfiguration.errorCode);
      },
    },
    {
      name: "sanitation: provider error text is sanitized and length-bounded",
      run: async () => {
        const label = "leaking provider error";
        const result = await settleOrFail(
          send(
            scenarios.leakingProviderError.fetchImpl,
            environments.configured,
          ),
          label,
        );
        assertFailedShape(result, message, label);
        for (const secret of scenarios.leakingProviderError.leakedSecrets) {
          assert.ok(
            !result.message.includes(secret),
            `provider error text must not leak ${JSON.stringify(secret.slice(0, 8))}...`,
          );
        }
      },
    },
    {
      name: "timeout: an unresponsive transport yields a bounded retryable failure",
      run: async () => {
        const label = "unresponsive transport";
        const result = await settleOrFail(
          send(
            withEmailTransportDeadline(
              hangingFetch(),
              CONTRACT_TRANSPORT_DEADLINE_MS,
            ),
            environments.configured,
          ),
          label,
        );
        assertFailedShape(result, message, label);
        assert.equal(
          result.retryable,
          true,
          "a transport timeout must be retryable",
        );
      },
    },
    {
      name: "safety: send resolves to a structured result in every scenario",
      run: async () => {
        const labelled: readonly (readonly [string, typeof fetch])[] = [
          ["sent", scenarios.sent.fetchImpl],
          ["rejected recipient", scenarios.rejectedRecipient.fetchImpl],
          ["malformed message", scenarios.malformedMessage.fetchImpl],
          ["rate limited", scenarios.rateLimited.fetchImpl],
          ["server error", scenarios.serverError.fetchImpl],
          ["leaking error", scenarios.leakingProviderError.fetchImpl],
          ["network error", networkErrorFetch()],
          [
            "bounded hang",
            withEmailTransportDeadline(
              hangingFetch(),
              CONTRACT_TRANSPORT_DEADLINE_MS,
            ),
          ],
        ];
        for (const [label, fetchImpl] of labelled) {
          const result = await settleOrFail(
            send(fetchImpl, environments.configured),
            label,
          );
          assert.ok(
            result?.status === "sent" || result?.status === "failed",
            `"${label}" must resolve to a sent or failed result`,
          );
        }
      },
    },
  ];
}

/**
 * Registers the full contract matrix as tests for one adapter. This is the
 * entry point an adapter's test file calls; a violated behavior fails the
 * adapter's build.
 */
export function runEmailDeliveryAdapterContractSuite(
  options: EmailDeliveryAdapterContractOptions,
): void {
  const adapterName = emailProviderNameSchema.safeParse(options.adapter?.name)
    .success
    ? options.adapter.name
    : "unnamed-adapter";
  for (const check of emailDeliveryAdapterContractChecks(options)) {
    test(`email delivery adapter contract (${adapterName}): ${check.name}`, check.run);
  }
}

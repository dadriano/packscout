import type { RenderedEmailMessage } from "@packscout/contracts";
import type {
  EmailAdapterSendContext,
  EmailAdapterSendResult,
  EmailDeliveryAdapter,
} from "./adapter.ts";
import type { EmailDeliveryAdapterContractOptions } from "./adapter-contract-suite.test-support.ts";
import {
  isRetryableEmailTransportStatus,
  sanitizeEmailProviderErrorText,
} from "./transport.ts";

/**
 * A fully conforming stub adapter speaking an invented wire protocol, plus
 * deliberately broken variants. The stub proves the adapter contract suite
 * passes a correct adapter; the broken variants prove the suite rejects each
 * contract violation. Nothing here reaches a network.
 */

export const STUB_EMAIL_TOKEN_VARIABLE = "EMAIL_STUB_API_TOKEN";
export const stubEmailAdapterName = "email-stub";
export const stubEmailApiToken =
  "stub-secret-token-0123456789abcdef0123456789";
const stubLeakHexBlob = "0xdeadbeefdeadbeefdeadbeef";

export function stubConfiguredEnv(): NodeJS.ProcessEnv {
  return { [STUB_EMAIL_TOKEN_VARIABLE]: stubEmailApiToken };
}

export function stubUnconfiguredEnv(): NodeJS.ProcessEnv {
  return {};
}

function stubIsConfigured(env: NodeJS.ProcessEnv): boolean {
  const token = env[STUB_EMAIL_TOKEN_VARIABLE];
  return typeof token === "string" && token.length > 0;
}

const stubMissingConfiguration = {
  errorCode: "EMAIL_STUB_UNCONFIGURED",
  message: `Set ${STUB_EMAIL_TOKEN_VARIABLE} to enable the stub email adapter.`,
} as const;

function failed(
  errorCode: string,
  errorText: string,
  retryable: boolean,
): EmailAdapterSendResult {
  return {
    status: "failed",
    errorCode,
    message: sanitizeEmailProviderErrorText(errorText),
    retryable,
  };
}

async function stubSend(
  message: RenderedEmailMessage,
  context: EmailAdapterSendContext,
): Promise<EmailAdapterSendResult> {
  if (!stubIsConfigured(context.env)) {
    return {
      status: "failed",
      errorCode: stubMissingConfiguration.errorCode,
      message: stubMissingConfiguration.message,
      retryable: false,
    };
  }
  let response: Response;
  let text: string;
  try {
    response = await context.fetchImpl("https://email-stub.invalid/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${context.env[STUB_EMAIL_TOKEN_VARIABLE]}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: message.kind,
        to: message.toEmail,
        subject: message.subject,
        textBody: message.textBody,
        htmlBody: message.htmlBody,
      }),
    });
    text = await response.text();
  } catch (error) {
    return failed(
      "STUB_TRANSPORT_FAILED",
      error instanceof Error ? error.message : String(error),
      true,
    );
  }
  if (response.ok) {
    let messageId: unknown;
    try {
      messageId = (JSON.parse(text) as { messageId?: unknown }).messageId;
    } catch {
      messageId = undefined;
    }
    return {
      status: "sent",
      providerMessageId:
        typeof messageId === "string" &&
        messageId.length >= 1 &&
        messageId.length <= 256
          ? messageId
          : null,
    };
  }
  let code: unknown;
  let errorText = text;
  try {
    const body = JSON.parse(text) as { code?: unknown; error?: unknown };
    code = body.code;
    if (typeof body.error === "string") errorText = body.error;
  } catch {
    // A non-JSON provider error stays raw text for the sanitizer.
  }
  if (response.status === 400 && code === "recipient_rejected") {
    return failed("STUB_RECIPIENT_REJECTED", errorText, false);
  }
  if (response.status === 400 && code === "malformed_message") {
    return failed("STUB_MALFORMED_MESSAGE", errorText, false);
  }
  if (response.status === 429) {
    return failed("STUB_RATE_LIMITED", errorText, true);
  }
  if (response.status >= 500) {
    return failed("STUB_SERVER_ERROR", errorText, true);
  }
  return failed(
    "STUB_PROVIDER_FAILED",
    errorText,
    isRetryableEmailTransportStatus(response.status),
  );
}

export function createStubEmailDeliveryAdapter(
  name: string = stubEmailAdapterName,
): EmailDeliveryAdapter {
  return {
    name,
    missingConfiguration: stubMissingConfiguration,
    isConfigured: stubIsConfigured,
    send: stubSend,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Fake transports producing each contract scenario in the stub's wire shape. */
export function stubAdapterContractScenarios(): EmailDeliveryAdapterContractOptions["scenarios"] {
  return {
    sent: {
      fetchImpl: async () => jsonResponse(200, { messageId: "stub-message-0001" }),
      expectedProviderMessageId: "stub-message-0001",
    },
    rejectedRecipient: {
      fetchImpl: async () =>
        jsonResponse(400, {
          code: "recipient_rejected",
          error: "The recipient was refused.",
        }),
    },
    malformedMessage: {
      fetchImpl: async () =>
        jsonResponse(400, {
          code: "malformed_message",
          error: "The message payload is malformed.",
        }),
    },
    rateLimited: {
      fetchImpl: async () => jsonResponse(429, { error: "Too many sends." }),
    },
    serverError: {
      fetchImpl: async () => jsonResponse(503, { error: "Upstream unavailable." }),
    },
    leakingProviderError: {
      fetchImpl: async (_input, init) => {
        let to = "unknown-recipient";
        try {
          const body = JSON.parse(String(init?.body)) as { to?: unknown };
          if (typeof body.to === "string") to = body.to;
        } catch {
          // Keep the placeholder recipient.
        }
        return jsonResponse(502, {
          error: `upstream refused ${to} authorization: Bearer ${stubEmailApiToken} trace=${stubLeakHexBlob} ${"x".repeat(400)}`,
        });
      },
      leakedSecrets: [stubEmailApiToken, stubLeakHexBlob],
    },
  };
}

export type StubEmailAdapterDefect =
  | "throws_on_send"
  | "misclassifies_rejected_recipient"
  | "leaks_provider_error_text"
  | "reports_configured_when_missing"
  | "hangs_without_transport"
  | "invents_success_shape";

/** One conforming stub with exactly one contract violation applied. */
export function createBrokenStubEmailDeliveryAdapter(
  defect: StubEmailAdapterDefect,
): EmailDeliveryAdapter {
  const conforming = createStubEmailDeliveryAdapter();
  switch (defect) {
    case "throws_on_send":
      return {
        ...conforming,
        send: async () => {
          throw new Error("stub adapter exploded");
        },
      };
    case "misclassifies_rejected_recipient":
      return {
        ...conforming,
        send: async (message, context) => {
          const result = await conforming.send(message, context);
          return result.status === "failed" &&
            result.errorCode === "STUB_RECIPIENT_REJECTED"
            ? { ...result, retryable: true }
            : result;
        },
      };
    case "leaks_provider_error_text":
      return {
        ...conforming,
        send: async (message, context) => {
          const result = await conforming.send(message, context);
          if (result.status !== "failed") return result;
          return {
            ...result,
            message: `upstream refused ${message.toEmail} authorization: Bearer ${stubEmailApiToken} trace=${stubLeakHexBlob}`,
          };
        },
      };
    case "reports_configured_when_missing":
      return {
        ...conforming,
        isConfigured: () => true,
        send: async (message, context) =>
          conforming.send(message, {
            ...context,
            env: { ...context.env, ...stubConfiguredEnv() },
          }),
      };
    case "hangs_without_transport":
      return {
        ...conforming,
        send: () => new Promise<EmailAdapterSendResult>(() => {}),
      };
    case "invents_success_shape":
      return {
        ...conforming,
        send: async () => ({
          status: "sent",
          providerMessageId: 42 as unknown as string,
        }),
      };
  }
}

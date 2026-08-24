import assert from "node:assert/strict";
import { test } from "node:test";
import type { RenderedEmailMessage } from "@packscout/contracts";
import {
  runEmailDeliveryAdapterContractSuite,
  type EmailDeliveryAdapterContractOptions,
} from "./adapter-contract-suite.test-support.ts";
import {
  EMAIL_DELIVERY_MODE_VARIABLE,
  EmailDeliveryService,
  resolveEmailDelivery,
} from "./delivery-service.ts";
import {
  createPostmarkEmailDeliveryAdapter,
  missingPostmarkConfiguration,
  POSTMARK_DEFAULT_MESSAGE_STREAM,
  POSTMARK_EMAIL_ADAPTER_NAME,
  POSTMARK_EMAIL_API_URL,
  POSTMARK_FROM_EMAIL_VARIABLE,
  POSTMARK_MESSAGE_STREAM_VARIABLE,
  POSTMARK_PROVIDER_ERROR_CODE_PREFIX,
  POSTMARK_REPLY_TO_EMAIL_VARIABLE,
  POSTMARK_RESPONSE_INVALID_ERROR_CODE,
  POSTMARK_SERVER_TOKEN_VARIABLE,
  POSTMARK_TRANSPORT_ERROR_CODE,
  POSTMARK_UNCONFIGURED_ERROR_CODE,
  resolvePostmarkMessageStream,
} from "./postmark-adapter.ts";
import { EmailDeliveryAdapterRegistry } from "./registry.ts";
import { withEmailTransportDeadline } from "./transport.ts";

/**
 * The Postmark wire contract these tests pin as the shape being coded
 * against — a future provider change must surface here as a test change:
 *
 *     POST https://api.postmarkapp.com/email
 *     Accept: application/json
 *     Content-Type: application/json
 *     X-Postmark-Server-Token: <server token>
 *     { "From", "To", "Subject", "TextBody", "HtmlBody", "MessageStream",
 *       "ReplyTo"? }
 *
 * Success: an OK status with `{ "MessageID", "ErrorCode": 0, "Message" }`.
 * Failure: a numeric `ErrorCode` and `Message` — over an HTTP error status,
 * or embedded in a success-shaped response, which is still a failure.
 * Postmark body codes seen here: 300 invalid email request (malformed), 406
 * inactive recipient (rejected). Retryable statuses are 408, 429, and 5xx.
 *
 * Every transport below is a fake speaking these shapes; nothing reaches a
 * network, and only the injected transport is ever used.
 */

const postmarkServerToken =
  "postmark-test-server-token-0123456789abcdef0123456789";
const postmarkFromEmail = "delivery@packscout.test";
const postmarkReplyToEmail = "support@packscout.test";
const sentMessageId = "b7f34d64-8a11-4e22-9c33-5f4455661234";
const leakedHexBlob = "0xfeedfacefeedfacefeedface";

const fixtureMessage: RenderedEmailMessage = {
  kind: "closed_beta_decision",
  toEmail: "beta-user@example.test",
  subject: "Your PackScout beta access decision",
  textBody: "Your access request was approved. Sign in to get started.",
  htmlBody: "<p>Your access request was approved.</p>",
};

function configuredEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    [POSTMARK_SERVER_TOKEN_VARIABLE]: postmarkServerToken,
    [POSTMARK_FROM_EMAIL_VARIABLE]: postmarkFromEmail,
    ...overrides,
  };
}

function postmarkJsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function respondWith(status: number, body: unknown): typeof fetch {
  return async () => postmarkJsonResponse(status, body);
}

function postmarkSuccessBody(messageId: unknown): Record<string, unknown> {
  return {
    To: fixtureMessage.toEmail,
    SubmittedAt: "2026-08-22T12:00:00.0000000Z",
    MessageID: messageId,
    ErrorCode: 0,
    Message: "OK",
  };
}

function recipientFromRequest(init: RequestInit | undefined): string {
  try {
    const body = JSON.parse(String(init?.body)) as { To?: unknown };
    if (typeof body.To === "string") return body.To;
  } catch {
    // Keep the placeholder recipient.
  }
  return "unknown-recipient";
}

function neverCalledFetch(): typeof fetch {
  return () => {
    throw new Error("the transport must not be used on this path");
  };
}

function hangingFetch(): typeof fetch {
  return () => new Promise<Response>(() => {});
}

async function sendWith(
  fetchImpl: typeof fetch,
  env: NodeJS.ProcessEnv = configuredEnv(),
  message: RenderedEmailMessage = fixtureMessage,
) {
  return createPostmarkEmailDeliveryAdapter().send(message, { env, fetchImpl });
}

/** Fake transports producing each contract scenario in Postmark's wire shape. */
function postmarkContractScenarios(): EmailDeliveryAdapterContractOptions["scenarios"] {
  return {
    sent: {
      fetchImpl: respondWith(200, postmarkSuccessBody(sentMessageId)),
      expectedProviderMessageId: sentMessageId,
    },
    rejectedRecipient: {
      fetchImpl: async (_input, init) =>
        postmarkJsonResponse(422, {
          ErrorCode: 406,
          Message: `You tried to send to a recipient that has been marked as inactive: ${recipientFromRequest(init)}.`,
        }),
    },
    malformedMessage: {
      fetchImpl: respondWith(422, {
        ErrorCode: 300,
        Message: "Invalid email request: zero recipients specified.",
      }),
    },
    rateLimited: {
      fetchImpl: respondWith(429, {
        ErrorCode: 429,
        Message: "Rate limit exceeded.",
      }),
    },
    serverError: {
      fetchImpl: async () =>
        new Response("Service Unavailable", { status: 503 }),
    },
    leakingProviderError: {
      fetchImpl: async (_input, init) =>
        postmarkJsonResponse(500, {
          Message: `internal failure delivering to ${recipientFromRequest(init)} X-Postmark-Server-Token: ${postmarkServerToken} trace=${leakedHexBlob} ${"padding words repeated here ".repeat(20)}`,
        }),
      leakedSecrets: [postmarkServerToken, leakedHexBlob],
    },
  };
}

// The acceptance bar from messaging/001: the published adapter contract
// suite runs in full against the Postmark adapter over fake transports
// speaking the wire shapes above.
runEmailDeliveryAdapterContractSuite({
  adapter: createPostmarkEmailDeliveryAdapter(),
  environments: {
    configured: configuredEnv(),
    unconfigured: {},
  },
  scenarios: postmarkContractScenarios(),
});

test("postmark wire contract: the request is the coded POST shape with token header, stream, and reply-to", async () => {
  const captured: { input?: unknown; init?: RequestInit } = {};
  const fetchImpl: typeof fetch = async (input, init) => {
    captured.input = input;
    captured.init = init;
    return postmarkJsonResponse(200, postmarkSuccessBody(sentMessageId));
  };
  const result = await sendWith(
    fetchImpl,
    configuredEnv({ [POSTMARK_REPLY_TO_EMAIL_VARIABLE]: postmarkReplyToEmail }),
  );
  assert.equal(String(captured.input), "https://api.postmarkapp.com/email");
  assert.equal(POSTMARK_EMAIL_API_URL, "https://api.postmarkapp.com/email");
  assert.equal(captured.init?.method, "POST");
  assert.deepEqual(captured.init?.headers, {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Postmark-Server-Token": postmarkServerToken,
  });
  assert.deepEqual(JSON.parse(String(captured.init?.body)), {
    From: postmarkFromEmail,
    To: fixtureMessage.toEmail,
    Subject: fixtureMessage.subject,
    TextBody: fixtureMessage.textBody,
    HtmlBody: fixtureMessage.htmlBody,
    MessageStream: POSTMARK_DEFAULT_MESSAGE_STREAM,
    ReplyTo: postmarkReplyToEmail,
  });
  assert.deepEqual(result, {
    status: "sent",
    providerMessageId: sentMessageId,
    messageStream: POSTMARK_DEFAULT_MESSAGE_STREAM,
  });
});

test("postmark wire contract: reply-to is omitted from the request body when unset", async () => {
  let requestBody: Record<string, unknown> = {};
  const fetchImpl: typeof fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return postmarkJsonResponse(200, postmarkSuccessBody(sentMessageId));
  };
  await sendWith(fetchImpl);
  assert.equal("ReplyTo" in requestBody, false);
  assert.deepEqual(Object.keys(requestBody).sort(), [
    "From",
    "HtmlBody",
    "MessageStream",
    "Subject",
    "TextBody",
    "To",
  ]);
});

test("postmark stream: defaults to the transactional outbound stream and follows the configured override", async () => {
  assert.equal(POSTMARK_DEFAULT_MESSAGE_STREAM, "outbound");
  assert.equal(
    resolvePostmarkMessageStream(configuredEnv()),
    POSTMARK_DEFAULT_MESSAGE_STREAM,
  );
  assert.equal(
    resolvePostmarkMessageStream(
      configuredEnv({ [POSTMARK_MESSAGE_STREAM_VARIABLE]: "   " }),
    ),
    POSTMARK_DEFAULT_MESSAGE_STREAM,
  );
  let streamedBody: Record<string, unknown> = {};
  const fetchImpl: typeof fetch = async (_input, init) => {
    streamedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return postmarkJsonResponse(200, postmarkSuccessBody(sentMessageId));
  };
  const result = await sendWith(
    fetchImpl,
    configuredEnv({
      [POSTMARK_MESSAGE_STREAM_VARIABLE]: "closed-beta-transactional",
    }),
  );
  assert.equal(streamedBody.MessageStream, "closed-beta-transactional");
  assert.deepEqual(result, {
    status: "sent",
    providerMessageId: sentMessageId,
    messageStream: "closed-beta-transactional",
  });
});

test("postmark configuration: ready only with token and sending address, naming what is absent without values", () => {
  const adapter = createPostmarkEmailDeliveryAdapter();
  assert.equal(adapter.isConfigured(configuredEnv()), true);
  assert.deepEqual(missingPostmarkConfiguration(configuredEnv()), []);
  const withoutFrom: NodeJS.ProcessEnv = {
    [POSTMARK_SERVER_TOKEN_VARIABLE]: postmarkServerToken,
  };
  assert.equal(adapter.isConfigured(withoutFrom), false);
  assert.deepEqual(missingPostmarkConfiguration(withoutFrom), [
    POSTMARK_FROM_EMAIL_VARIABLE,
  ]);
  const withoutToken: NodeJS.ProcessEnv = {
    [POSTMARK_FROM_EMAIL_VARIABLE]: postmarkFromEmail,
  };
  assert.equal(adapter.isConfigured(withoutToken), false);
  assert.deepEqual(missingPostmarkConfiguration(withoutToken), [
    POSTMARK_SERVER_TOKEN_VARIABLE,
  ]);
  assert.equal(adapter.isConfigured({}), false);
  assert.deepEqual(missingPostmarkConfiguration({}), [
    POSTMARK_SERVER_TOKEN_VARIABLE,
    POSTMARK_FROM_EMAIL_VARIABLE,
  ]);
  const blankValues: NodeJS.ProcessEnv = {
    [POSTMARK_SERVER_TOKEN_VARIABLE]: "   ",
    [POSTMARK_FROM_EMAIL_VARIABLE]: "",
  };
  assert.equal(adapter.isConfigured(blankValues), false);
  assert.deepEqual(missingPostmarkConfiguration(blankValues), [
    POSTMARK_SERVER_TOKEN_VARIABLE,
    POSTMARK_FROM_EMAIL_VARIABLE,
  ]);
  assert.equal(
    adapter.missingConfiguration.errorCode,
    POSTMARK_UNCONFIGURED_ERROR_CODE,
  );
  assert.ok(
    adapter.missingConfiguration.message.includes(
      POSTMARK_SERVER_TOKEN_VARIABLE,
    ),
  );
  assert.ok(
    adapter.missingConfiguration.message.includes(POSTMARK_FROM_EMAIL_VARIABLE),
  );
  assert.ok(!adapter.missingConfiguration.message.includes(postmarkServerToken));
  assert.ok(!adapter.missingConfiguration.message.includes(postmarkFromEmail));
});

test("postmark configuration: an unconfigured send fails closed before the transport, naming only the absent variable", async () => {
  const result = await sendWith(neverCalledFetch(), {
    [POSTMARK_FROM_EMAIL_VARIABLE]: postmarkFromEmail,
  });
  assert.equal(result.status, "failed");
  assert.ok(result.status === "failed");
  assert.equal(result.errorCode, POSTMARK_UNCONFIGURED_ERROR_CODE);
  assert.equal(result.retryable, false);
  assert.ok(result.message.includes(POSTMARK_SERVER_TOKEN_VARIABLE));
  assert.ok(!result.message.includes(POSTMARK_FROM_EMAIL_VARIABLE));
  assert.ok(!result.message.includes(postmarkFromEmail));
  const bothMissing = await sendWith(neverCalledFetch(), {});
  assert.ok(bothMissing.status === "failed");
  assert.ok(bothMissing.message.includes(POSTMARK_SERVER_TOKEN_VARIABLE));
  assert.ok(bothMissing.message.includes(POSTMARK_FROM_EMAIL_VARIABLE));
});

test("postmark success: a delivered send carries the provider message identifier and the resolved stream", async () => {
  const result = await sendWith(
    respondWith(200, postmarkSuccessBody(`  ${sentMessageId}  `)),
  );
  assert.deepEqual(result, {
    status: "sent",
    providerMessageId: sentMessageId,
    messageStream: POSTMARK_DEFAULT_MESSAGE_STREAM,
  });
  const unusable = await sendWith(
    respondWith(200, postmarkSuccessBody("x".repeat(300))),
  );
  assert.ok(unusable.status === "sent");
  assert.equal(unusable.providerMessageId, null);
  const absent = await sendWith(
    respondWith(200, { ErrorCode: 0, Message: "OK" }),
  );
  assert.ok(absent.status === "sent");
  assert.equal(absent.providerMessageId, null);
});

test("postmark classification: an error code embedded in a success-shaped response is a terminal failure carrying that code", async () => {
  for (const [errorCode, providerMessage] of [
    [406, "You tried to send to a recipient that has been marked as inactive."],
    [300, "Invalid email request."],
  ] as const) {
    const result = await sendWith(
      respondWith(200, { ErrorCode: errorCode, Message: providerMessage }),
    );
    assert.equal(result.status, "failed", "an embedded error code must fail");
    assert.ok(result.status === "failed");
    assert.equal(
      result.errorCode,
      `${POSTMARK_PROVIDER_ERROR_CODE_PREFIX}${errorCode}`,
    );
    assert.equal(result.retryable, false);
  }
});

test("postmark classification: HTTP failures use the body error code or status as the stable code with status-based retryability", async () => {
  const cases: readonly {
    status: number;
    body: unknown;
    json: boolean;
    expectedCode: string;
    retryable: boolean;
  }[] = [
    {
      status: 422,
      body: { ErrorCode: 406, Message: "Recipient marked inactive." },
      json: true,
      expectedCode: `${POSTMARK_PROVIDER_ERROR_CODE_PREFIX}406`,
      retryable: false,
    },
    {
      status: 422,
      body: { ErrorCode: 300, Message: "Invalid email request." },
      json: true,
      expectedCode: `${POSTMARK_PROVIDER_ERROR_CODE_PREFIX}300`,
      retryable: false,
    },
    {
      status: 422,
      body: { Message: "Unprocessable without a provider code." },
      json: true,
      expectedCode: `${POSTMARK_PROVIDER_ERROR_CODE_PREFIX}422`,
      retryable: false,
    },
    {
      status: 401,
      body: { ErrorCode: 10, Message: "No account or server token supplied." },
      json: true,
      expectedCode: `${POSTMARK_PROVIDER_ERROR_CODE_PREFIX}10`,
      retryable: false,
    },
    {
      status: 429,
      body: { ErrorCode: 429, Message: "Rate limit exceeded." },
      json: true,
      expectedCode: `${POSTMARK_PROVIDER_ERROR_CODE_PREFIX}429`,
      retryable: true,
    },
    {
      status: 408,
      body: "Request Timeout",
      json: false,
      expectedCode: `${POSTMARK_PROVIDER_ERROR_CODE_PREFIX}408`,
      retryable: true,
    },
    {
      status: 500,
      body: { Message: "Internal server error." },
      json: true,
      expectedCode: `${POSTMARK_PROVIDER_ERROR_CODE_PREFIX}500`,
      retryable: true,
    },
    {
      status: 503,
      body: "Service Unavailable",
      json: false,
      expectedCode: `${POSTMARK_PROVIDER_ERROR_CODE_PREFIX}503`,
      retryable: true,
    },
  ];
  for (const testCase of cases) {
    const fetchImpl: typeof fetch = testCase.json
      ? respondWith(testCase.status, testCase.body)
      : async () =>
          new Response(String(testCase.body), { status: testCase.status });
    const result = await sendWith(fetchImpl);
    assert.ok(
      result.status === "failed",
      `status ${testCase.status} must fail`,
    );
    assert.equal(result.errorCode, testCase.expectedCode);
    assert.equal(
      result.retryable,
      testCase.retryable,
      `status ${testCase.status} retryability`,
    );
  }
});

test("postmark classification: a success status that does not confirm ErrorCode 0 is a retryable failure", async () => {
  const unreadable: readonly (typeof fetch)[] = [
    async () => new Response("OK", { status: 200 }),
    respondWith(200, { Message: "No error code present." }),
    async () => new Response("null", { status: 200 }),
  ];
  for (const fetchImpl of unreadable) {
    const result = await sendWith(fetchImpl);
    assert.ok(result.status === "failed");
    assert.equal(result.errorCode, POSTMARK_RESPONSE_INVALID_ERROR_CODE);
    assert.equal(result.retryable, true);
  }
});

test("postmark classification: network failures and transport timeouts are retryable transport failures", async () => {
  const network = await sendWith(() =>
    Promise.reject(new TypeError("fetch failed: network unreachable")),
  );
  assert.ok(network.status === "failed");
  assert.equal(network.errorCode, POSTMARK_TRANSPORT_ERROR_CODE);
  assert.equal(network.retryable, true);
  const timedOut = await sendWith(
    withEmailTransportDeadline(hangingFetch(), 25),
  );
  assert.ok(timedOut.status === "failed");
  assert.equal(timedOut.errorCode, POSTMARK_TRANSPORT_ERROR_CODE);
  assert.equal(timedOut.retryable, true);
});

test("postmark sanitation: provider error text is redacted and length-bounded before it is returned", async () => {
  const result = await sendWith(
    respondWith(422, {
      ErrorCode: 406,
      Message: `Refused recipient ${fixtureMessage.toEmail} X-Postmark-Server-Token: ${postmarkServerToken} trace=${leakedHexBlob} ${"long provider sentence keeps going ".repeat(15)}`,
    }),
  );
  assert.ok(result.status === "failed");
  assert.ok(result.message.length <= 200, "sanitized text must stay bounded");
  assert.ok(!result.message.includes(fixtureMessage.toEmail));
  assert.ok(!result.message.includes(postmarkServerToken));
  assert.ok(!result.message.includes(leakedHexBlob));
  assert.ok(!/\p{Cc}/u.test(result.message));
});

test("postmark logging: no token, recipient address, subject, or body reaches any console output", async (t) => {
  const capturedCalls: unknown[][] = [];
  for (const level of [
    "log",
    "info",
    "warn",
    "error",
    "debug",
    "trace",
  ] as const) {
    t.mock.method(console, level, (...args: unknown[]) => {
      capturedCalls.push(args);
    });
  }
  await sendWith(respondWith(200, postmarkSuccessBody(sentMessageId)));
  await sendWith(respondWith(200, { ErrorCode: 406, Message: "Inactive." }));
  await sendWith(
    respondWith(422, {
      ErrorCode: 300,
      Message: `Invalid request for ${fixtureMessage.toEmail}.`,
    }),
  );
  await sendWith(respondWith(429, { ErrorCode: 429, Message: "Rate limit." }));
  await sendWith(async () => new Response("boom", { status: 503 }));
  await sendWith(() => Promise.reject(new TypeError("network unreachable")));
  await sendWith(neverCalledFetch(), {});
  const serialized = JSON.stringify(capturedCalls);
  for (const secret of [
    postmarkServerToken,
    fixtureMessage.toEmail,
    fixtureMessage.subject,
    fixtureMessage.textBody,
    fixtureMessage.htmlBody,
  ]) {
    assert.ok(
      !serialized.includes(secret),
      "console output must never carry the token, recipient, subject, or body",
    );
  }
  assert.deepEqual(
    capturedCalls,
    [],
    "the adapter must not write to the console at all",
  );
});

test("postmark registration: one registration makes the adapter selectable by name and as the automatic default", async () => {
  const registry = new EmailDeliveryAdapterRegistry([
    createPostmarkEmailDeliveryAdapter(),
  ]);
  assert.deepEqual(registry.names(), [POSTMARK_EMAIL_ADAPTER_NAME]);
  const named = resolveEmailDelivery(
    registry,
    configuredEnv({
      [EMAIL_DELIVERY_MODE_VARIABLE]: POSTMARK_EMAIL_ADAPTER_NAME,
    }),
  );
  assert.deepEqual(named.mode, {
    kind: "adapter",
    name: POSTMARK_EMAIL_ADAPTER_NAME,
  });
  assert.equal(named.adapter?.name, POSTMARK_EMAIL_ADAPTER_NAME);
  assert.deepEqual(named.readiness, { ready: true });
  const automatic = resolveEmailDelivery(registry, configuredEnv());
  assert.deepEqual(automatic.mode, { kind: "auto" });
  assert.equal(automatic.adapter?.name, POSTMARK_EMAIL_ADAPTER_NAME);
  const namedUnconfigured = resolveEmailDelivery(registry, {
    [EMAIL_DELIVERY_MODE_VARIABLE]: POSTMARK_EMAIL_ADAPTER_NAME,
  });
  assert.deepEqual(namedUnconfigured.readiness, {
    ready: false,
    reason: "missing_configuration",
  });
  const service = new EmailDeliveryService(registry, {
    env: configuredEnv(),
    fetchImpl: respondWith(200, postmarkSuccessBody(sentMessageId)),
  });
  const result = await service.send(fixtureMessage);
  assert.deepEqual(result, {
    status: "sent",
    provider: POSTMARK_EMAIL_ADAPTER_NAME,
    providerMessageId: sentMessageId,
  });
});

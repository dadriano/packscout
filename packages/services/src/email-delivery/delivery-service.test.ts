import assert from "node:assert/strict";
import { test } from "node:test";
import type { RenderedEmailMessage } from "@packscout/contracts";
import type { EmailAdapterSendResult } from "./adapter.ts";
import {
  EMAIL_DELIVERY_MODE_VARIABLE,
  EMAIL_REQUIRE_DELIVERY_VARIABLE,
  EmailDeliveryService,
  isProductionLikeEmailEnvironment,
  resolveEmailDelivery,
  resolveEmailDeliveryMode,
  resolveEmailDeliveryReadiness,
  type EmailDeliveryLogEntry,
} from "./delivery-service.ts";
import { EmailDeliveryAdapterRegistry } from "./registry.ts";
import {
  createStubEmailDeliveryAdapter,
  stubAdapterContractScenarios,
  stubConfiguredEnv,
  stubEmailApiToken,
} from "./stub-adapter.test-support.ts";

const message: RenderedEmailMessage = {
  kind: "operational_alert",
  toEmail: "operator@example.test",
  subject: "A provider import failed overnight",
  textBody: "The provider import stopped with a sanitized failure code.",
  htmlBody: "<p>The provider import stopped.</p>",
};

const scenarios = stubAdapterContractScenarios();

function stubRegistry() {
  const adapter = createStubEmailDeliveryAdapter();
  return { adapter, registry: new EmailDeliveryAdapterRegistry([adapter]) };
}

function countingFetch(inner: typeof fetch): {
  fetchImpl: typeof fetch;
  calls: () => number;
} {
  let count = 0;
  return {
    fetchImpl: (input, init) => {
      count += 1;
      return inner(input, init);
    },
    calls: () => count,
  };
}

const fixedClock = { now: () => new Date("2026-08-21T12:00:00.000Z") };

test("delivery mode resolves from server configuration and unrecognized values become automatic", () => {
  const { registry } = stubRegistry();
  assert.deepEqual(resolveEmailDeliveryMode(registry, {}), { kind: "auto" });
  assert.deepEqual(
    resolveEmailDeliveryMode(registry, {
      [EMAIL_DELIVERY_MODE_VARIABLE]: "disabled",
    }),
    { kind: "disabled" },
  );
  assert.deepEqual(
    resolveEmailDeliveryMode(registry, {
      [EMAIL_DELIVERY_MODE_VARIABLE]: " Console ",
    }),
    { kind: "console" },
  );
  assert.deepEqual(
    resolveEmailDeliveryMode(registry, {
      [EMAIL_DELIVERY_MODE_VARIABLE]: "email-stub",
    }),
    { kind: "adapter", name: "email-stub" },
  );
  for (const unrecognized of ["smtp-nonsense", "auto", "", "unregistered-name"]) {
    assert.deepEqual(
      resolveEmailDeliveryMode(registry, {
        [EMAIL_DELIVERY_MODE_VARIABLE]: unrecognized,
      }),
      { kind: "auto" },
      JSON.stringify(unrecognized),
    );
  }
});

test("automatic mode delivers through the default adapter and reports the sent shape", async () => {
  const { registry } = stubRegistry();
  const secondary = createStubEmailDeliveryAdapter("email-stub-secondary");
  let secondaryCalls = 0;
  registry.register({
    ...secondary,
    send: (sendMessage, context) => {
      secondaryCalls += 1;
      return secondary.send(sendMessage, context);
    },
  });
  const logs: EmailDeliveryLogEntry[] = [];
  const service = new EmailDeliveryService(registry, {
    env: stubConfiguredEnv(),
    fetchImpl: scenarios.sent.fetchImpl,
    observability: { log: (entry) => logs.push(entry) },
    clock: fixedClock,
  });
  assert.deepEqual(await service.send(message), {
    status: "sent",
    provider: "email-stub",
    providerMessageId: "stub-message-0001",
  });
  assert.equal(secondaryCalls, 0);
  assert.deepEqual(logs, [
    {
      event: "email_delivery",
      level: "info",
      status: "sent",
      code: "EMAIL_DELIVERY_SENT",
      mode: "auto",
      provider: "email-stub",
      messageKind: "operational_alert",
      occurredAt: "2026-08-21T12:00:00.000Z",
    },
  ]);
});

test("a named mode delivers through that adapter without changing the caller", async () => {
  const { registry } = stubRegistry();
  registry.register(createStubEmailDeliveryAdapter("email-stub-secondary"));
  const service = new EmailDeliveryService(registry, {
    env: {
      ...stubConfiguredEnv(),
      [EMAIL_DELIVERY_MODE_VARIABLE]: "email-stub-secondary",
    },
    fetchImpl: scenarios.sent.fetchImpl,
  });
  const result = await service.send(message);
  assert.deepEqual(result, {
    status: "sent",
    provider: "email-stub-secondary",
    providerMessageId: "stub-message-0001",
  });
});

test("disabled mode sends nothing and reports skipped", async () => {
  const { registry } = stubRegistry();
  const transport = countingFetch(scenarios.sent.fetchImpl);
  const service = new EmailDeliveryService(registry, {
    env: {
      ...stubConfiguredEnv(),
      [EMAIL_DELIVERY_MODE_VARIABLE]: "disabled",
    },
    fetchImpl: transport.fetchImpl,
  });
  assert.deepEqual(await service.send(message), {
    status: "skipped",
    reason: "delivery_disabled",
  });
  assert.equal(transport.calls(), 0);
});

test("console mode renders the message locally, skips sending, and never renders in production-like environments", async () => {
  const { registry } = stubRegistry();
  const rendered: RenderedEmailMessage[] = [];
  const renderer = { render: (m: RenderedEmailMessage) => rendered.push(m) };
  const transport = countingFetch(scenarios.sent.fetchImpl);
  const local = new EmailDeliveryService(registry, {
    env: {
      ...stubConfiguredEnv(),
      [EMAIL_DELIVERY_MODE_VARIABLE]: "console",
    },
    fetchImpl: transport.fetchImpl,
    consoleRenderer: renderer,
  });
  assert.deepEqual(await local.send(message), {
    status: "skipped",
    reason: "console_mode",
  });
  assert.deepEqual(rendered, [message]);
  assert.equal(transport.calls(), 0);

  const productionLike = new EmailDeliveryService(registry, {
    env: {
      ...stubConfiguredEnv(),
      [EMAIL_DELIVERY_MODE_VARIABLE]: "console",
      NODE_ENV: "production",
    },
    fetchImpl: transport.fetchImpl,
    consoleRenderer: renderer,
  });
  assert.deepEqual(await productionLike.send(message), {
    status: "skipped",
    reason: "console_mode",
  });
  assert.equal(rendered.length, 1, "production-like console never renders");
  assert.equal(transport.calls(), 0);
});

test("an unrecognized mode value delivers as automatic instead of failing", async () => {
  const { registry } = stubRegistry();
  const service = new EmailDeliveryService(registry, {
    env: {
      ...stubConfiguredEnv(),
      [EMAIL_DELIVERY_MODE_VARIABLE]: "smtp-nonsense",
    },
    fetchImpl: scenarios.sent.fetchImpl,
  });
  const result = await service.send(message);
  assert.equal(result.status, "sent");
});

test("production-like environments are NODE_ENV production or the explicit override", () => {
  assert.equal(isProductionLikeEmailEnvironment({}), false);
  assert.equal(
    isProductionLikeEmailEnvironment({ NODE_ENV: "production" }),
    true,
  );
  assert.equal(
    isProductionLikeEmailEnvironment({ [EMAIL_REQUIRE_DELIVERY_VARIABLE]: "1" }),
    true,
  );
  assert.equal(
    isProductionLikeEmailEnvironment({ [EMAIL_REQUIRE_DELIVERY_VARIABLE]: "0" }),
    false,
  );
});

test("readiness fails closed in production-like environments", () => {
  const { registry } = stubRegistry();
  assert.deepEqual(
    resolveEmailDeliveryReadiness(registry, { NODE_ENV: "production" }),
    { ready: false, reason: "missing_configuration" },
  );
  assert.deepEqual(
    resolveEmailDeliveryReadiness(registry, {
      NODE_ENV: "production",
      [EMAIL_DELIVERY_MODE_VARIABLE]: "disabled",
    }),
    { ready: false, reason: "delivery_disabled" },
  );
  assert.deepEqual(
    resolveEmailDeliveryReadiness(registry, {
      NODE_ENV: "production",
      [EMAIL_DELIVERY_MODE_VARIABLE]: "console",
    }),
    { ready: false, reason: "console_mode" },
  );
  assert.deepEqual(
    resolveEmailDeliveryReadiness(registry, {
      ...stubConfiguredEnv(),
      NODE_ENV: "production",
    }),
    { ready: true },
  );
  assert.deepEqual(
    resolveEmailDeliveryReadiness(new EmailDeliveryAdapterRegistry(), {
      NODE_ENV: "production",
    }),
    { ready: false, reason: "missing_configuration" },
  );
  assert.deepEqual(
    resolveEmailDeliveryReadiness(registry, {
      [EMAIL_REQUIRE_DELIVERY_VARIABLE]: "1",
    }),
    { ready: false, reason: "missing_configuration" },
  );
});

test("readiness fails a named but unconfigured adapter even locally", () => {
  const { registry } = stubRegistry();
  assert.deepEqual(
    resolveEmailDeliveryReadiness(registry, {
      [EMAIL_DELIVERY_MODE_VARIABLE]: "email-stub",
    }),
    { ready: false, reason: "missing_configuration" },
  );
  assert.deepEqual(
    resolveEmailDeliveryReadiness(registry, {
      ...stubConfiguredEnv(),
      [EMAIL_DELIVERY_MODE_VARIABLE]: "email-stub",
    }),
    { ready: true },
  );
});

test("readiness passes local automatic and console modes", () => {
  const { registry } = stubRegistry();
  assert.deepEqual(resolveEmailDeliveryReadiness(registry, {}), { ready: true });
  assert.deepEqual(
    resolveEmailDeliveryReadiness(registry, {
      [EMAIL_DELIVERY_MODE_VARIABLE]: "console",
    }),
    { ready: true },
  );
  assert.deepEqual(
    resolveEmailDeliveryReadiness(registry, {
      [EMAIL_DELIVERY_MODE_VARIABLE]: "disabled",
    }),
    { ready: true },
  );
});

test("delivery resolution exposes the mode, the resolved adapter, and readiness", () => {
  const { adapter, registry } = stubRegistry();
  const resolution = resolveEmailDelivery(registry, stubConfiguredEnv());
  assert.deepEqual(resolution.mode, { kind: "auto" });
  assert.equal(resolution.adapter, adapter);
  assert.equal(resolution.productionLike, false);
  assert.deepEqual(resolution.readiness, { ready: true });

  const service = new EmailDeliveryService(registry, {
    env: {
      ...stubConfiguredEnv(),
      [EMAIL_DELIVERY_MODE_VARIABLE]: "email-stub",
    },
  });
  assert.deepEqual(service.resolve().mode, {
    kind: "adapter",
    name: "email-stub",
  });
  assert.deepEqual(service.readiness(), { ready: true });
});

test("send results classify retryability per failure class", async () => {
  const { registry } = stubRegistry();
  const cases: readonly {
    label: string;
    fetchImpl: typeof fetch;
    errorCode: string;
    retryable: boolean;
  }[] = [
    {
      label: "rejected recipient",
      fetchImpl: scenarios.rejectedRecipient.fetchImpl,
      errorCode: "STUB_RECIPIENT_REJECTED",
      retryable: false,
    },
    {
      label: "malformed message",
      fetchImpl: scenarios.malformedMessage.fetchImpl,
      errorCode: "STUB_MALFORMED_MESSAGE",
      retryable: false,
    },
    {
      label: "rate limited",
      fetchImpl: scenarios.rateLimited.fetchImpl,
      errorCode: "STUB_RATE_LIMITED",
      retryable: true,
    },
    {
      label: "server error",
      fetchImpl: scenarios.serverError.fetchImpl,
      errorCode: "STUB_SERVER_ERROR",
      retryable: true,
    },
    {
      label: "network transport failure",
      fetchImpl: () => Promise.reject(new TypeError("fetch failed")),
      errorCode: "STUB_TRANSPORT_FAILED",
      retryable: true,
    },
  ];
  for (const testCase of cases) {
    const service = new EmailDeliveryService(registry, {
      env: stubConfiguredEnv(),
      fetchImpl: testCase.fetchImpl,
    });
    const result = await service.send(message);
    assert.equal(result.status, "failed", testCase.label);
    assert.ok(result.status === "failed");
    assert.equal(result.provider, "email-stub", testCase.label);
    assert.equal(result.errorCode, testCase.errorCode, testCase.label);
    assert.equal(result.retryable, testCase.retryable, testCase.label);
  }
});

test("missing configuration skips locally and fails closed in production-like or named modes", async () => {
  const { registry } = stubRegistry();
  const transport = countingFetch(scenarios.sent.fetchImpl);
  const local = new EmailDeliveryService(registry, {
    env: {},
    fetchImpl: transport.fetchImpl,
  });
  assert.deepEqual(await local.send(message), {
    status: "skipped",
    reason: "missing_configuration",
  });

  const production = new EmailDeliveryService(registry, {
    env: { NODE_ENV: "production" },
    fetchImpl: transport.fetchImpl,
  });
  const productionResult = await production.send(message);
  assert.deepEqual(productionResult, {
    status: "failed",
    provider: "email-stub",
    errorCode: "EMAIL_STUB_UNCONFIGURED",
    message: "Set EMAIL_STUB_API_TOKEN to enable the stub email adapter.",
    retryable: false,
  });

  const named = new EmailDeliveryService(registry, {
    env: { [EMAIL_DELIVERY_MODE_VARIABLE]: "email-stub" },
    fetchImpl: transport.fetchImpl,
  });
  const namedResult = await named.send(message);
  assert.ok(namedResult.status === "failed");
  assert.equal(namedResult.retryable, false);

  const emptyProduction = new EmailDeliveryService(
    new EmailDeliveryAdapterRegistry(),
    { env: { NODE_ENV: "production" }, fetchImpl: transport.fetchImpl },
  );
  const emptyResult = await emptyProduction.send(message);
  assert.deepEqual(emptyResult, {
    status: "failed",
    provider: null,
    errorCode: "EMAIL_DELIVERY_UNCONFIGURED",
    message: "No email delivery adapter is registered.",
    retryable: false,
  });

  const emptyLocal = new EmailDeliveryService(new EmailDeliveryAdapterRegistry(), {
    env: {},
    fetchImpl: transport.fetchImpl,
  });
  assert.deepEqual(await emptyLocal.send(message), {
    status: "skipped",
    reason: "missing_configuration",
  });
  assert.equal(transport.calls(), 0, "no unconfigured path may reach a provider");
});

test("a malformed rendered message fails without reaching any adapter", async () => {
  const { registry } = stubRegistry();
  const transport = countingFetch(scenarios.sent.fetchImpl);
  const logs: EmailDeliveryLogEntry[] = [];
  const service = new EmailDeliveryService(registry, {
    env: stubConfiguredEnv(),
    fetchImpl: transport.fetchImpl,
    observability: { log: (entry) => logs.push(entry) },
    clock: fixedClock,
  });
  assert.deepEqual(await service.send({ ...message, toEmail: "not-an-address" }), {
    status: "failed",
    provider: null,
    errorCode: "EMAIL_MESSAGE_INVALID",
    message: "The rendered message does not match the delivery contract.",
    retryable: false,
  });
  const invalidKind = await service.send({ ...message, kind: "Bad Kind" });
  assert.ok(invalidKind.status === "failed");
  assert.equal(transport.calls(), 0);
  assert.deepEqual(
    logs.map(({ messageKind }) => messageKind),
    ["operational_alert", "unknown"],
  );
});

test("an unresponsive provider yields a bounded retryable failure instead of hanging", async () => {
  const { adapter, registry } = stubRegistry();

  const hangingAdapterRegistry = new EmailDeliveryAdapterRegistry([
    { ...adapter, send: () => new Promise<EmailAdapterSendResult>(() => {}) },
  ]);
  const hangingAdapterService = new EmailDeliveryService(hangingAdapterRegistry, {
    env: stubConfiguredEnv(),
    fetchImpl: scenarios.sent.fetchImpl,
    sendTimeoutMs: 100,
  });
  const started = Date.now();
  const result = await hangingAdapterService.send(message);
  assert.ok(Date.now() - started < 2_000, "the boundary must not wait open-endedly");
  assert.deepEqual(result, {
    status: "failed",
    provider: "email-stub",
    errorCode: "EMAIL_DELIVERY_TIMEOUT",
    message: "The delivery adapter gave no answer within the send bound.",
    retryable: true,
  });

  const hangingTransportService = new EmailDeliveryService(registry, {
    env: stubConfiguredEnv(),
    fetchImpl: () => new Promise<Response>(() => {}),
    sendTimeoutMs: 100,
  });
  const transportResult = await hangingTransportService.send(message);
  assert.ok(transportResult.status === "failed");
  assert.equal(transportResult.errorCode, "STUB_TRANSPORT_FAILED");
  assert.equal(transportResult.retryable, true);
});

test("no credential, recipient address, or message body reaches logs or results", async () => {
  const { registry } = stubRegistry();
  const logs: EmailDeliveryLogEntry[] = [];
  const service = new EmailDeliveryService(registry, {
    env: stubConfiguredEnv(),
    fetchImpl: scenarios.leakingProviderError.fetchImpl,
    observability: { log: (entry) => logs.push(entry) },
    clock: fixedClock,
  });
  const result = await service.send(message);
  assert.ok(result.status === "failed");
  const serialized = JSON.stringify({ logs, result });
  for (const secret of [
    message.toEmail,
    message.subject,
    message.textBody,
    message.htmlBody,
    stubEmailApiToken,
  ]) {
    assert.ok(!serialized.includes(secret), `must not record ${secret.slice(0, 12)}`);
  }
  for (const entry of logs) {
    assert.deepEqual(
      Object.keys(entry).sort(),
      [
        "code",
        "event",
        "level",
        "messageKind",
        "mode",
        "occurredAt",
        "provider",
        "status",
      ],
      "log entries carry only the bounded, content-free fields",
    );
  }
});

test("thrown errors, invalid results, and unstable codes become classified failures", async () => {
  const { adapter } = stubRegistry();
  const send = async (
    override: (
      sendMessage: RenderedEmailMessage,
      context: Parameters<typeof adapter.send>[1],
    ) => Promise<EmailAdapterSendResult>,
  ) => {
    const registry = new EmailDeliveryAdapterRegistry([
      { ...adapter, send: override },
    ]);
    const service = new EmailDeliveryService(registry, {
      env: stubConfiguredEnv(),
      fetchImpl: scenarios.sent.fetchImpl,
    });
    return service.send(message);
  };

  const thrown = await send(async () => {
    throw new Error(
      `authorization: Bearer ${stubEmailApiToken} exploded reaching operator@example.test`,
    );
  });
  assert.ok(thrown.status === "failed");
  assert.equal(thrown.errorCode, "EMAIL_PROVIDER_SEND_FAILED");
  assert.equal(thrown.retryable, true);
  assert.ok(!thrown.message.includes(stubEmailApiToken));
  assert.ok(!thrown.message.includes("operator@example.test"));

  const garbage = await send(
    async () => ({ nonsense: true }) as unknown as EmailAdapterSendResult,
  );
  assert.ok(garbage.status === "failed");
  assert.equal(garbage.errorCode, "EMAIL_PROVIDER_RESULT_INVALID");
  assert.equal(garbage.retryable, false);

  const unstable = await send(async () => ({
    status: "failed",
    errorCode: "lower case",
    message: "x".repeat(5_000),
    retryable: true,
  }));
  assert.ok(unstable.status === "failed");
  assert.equal(unstable.errorCode, "EMAIL_PROVIDER_FAILED");
  assert.ok(unstable.message.length <= 200);
  assert.equal(unstable.retryable, true);

  const junkId = await send(async () => ({
    status: "sent",
    providerMessageId: "   ",
  }));
  assert.deepEqual(junkId, {
    status: "sent",
    provider: "email-stub",
    providerMessageId: null,
  });

  const paddedId = await send(async () => ({
    status: "sent",
    providerMessageId: "  provider-id-1  ",
  }));
  assert.ok(paddedId.status === "sent");
  assert.equal(paddedId.providerMessageId, "provider-id-1");
});

test("service construction refuses an out-of-bounds send timeout", () => {
  const { registry } = stubRegistry();
  for (const invalid of [0, 50, 99, 30_001, 1.5, Number.NaN]) {
    assert.throws(
      () => new EmailDeliveryService(registry, { sendTimeoutMs: invalid }),
      RangeError,
    );
  }
});

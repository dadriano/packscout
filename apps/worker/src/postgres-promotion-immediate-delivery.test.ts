import assert from "node:assert/strict";
import test from "node:test";
import {
  PROMOTION_JOB_IMMEDIATE_DELIVERY_CHANNEL,
  encodePromotionJobImmediateDelivery,
  type ProviderPromotionImmediateDeliveryRequest,
} from "@packscout/database";
import {
  logPromotionImmediateDeliveryDisabled,
  PostgresPromotionImmediateDeliverySubscriber,
  type PromotionImmediateDeliverySubscriberClient,
  type PromotionImmediateDeliverySubscriberLogger,
} from "./postgres-promotion-immediate-delivery.ts";

class MemoryNotificationClient
implements PromotionImmediateDeliverySubscriberClient {
  readonly queries: string[] = [];
  readonly notificationListeners = new Set<
    (notification: { channel: string; payload?: string }) => void
  >();
  readonly errorListeners = new Set<() => void>();
  readonly endListeners = new Set<() => void>();
  connectFailure = false;
  ended = false;

  connect(): Promise<void> {
    return this.connectFailure
      ? Promise.reject(new Error("listener unavailable"))
      : Promise.resolve();
  }

  query(statement: string): Promise<unknown> {
    this.queries.push(statement);
    return Promise.resolve([]);
  }

  end(): Promise<void> {
    this.ended = true;
    return Promise.resolve();
  }

  on(
    event: "notification",
    listener: (notification: { channel: string; payload?: string }) => void,
  ): unknown;
  on(event: "error", listener: () => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(
    event: "notification" | "error" | "end",
    listener: ((notification: {
      channel: string;
      payload?: string;
    }) => void) | (() => void),
  ): unknown {
    if (event === "notification") {
      this.notificationListeners.add(listener as (
        notification: { channel: string; payload?: string }
      ) => void);
    } else if (event === "error") {
      this.errorListeners.add(listener as () => void);
    } else this.endListeners.add(listener as () => void);
    return this;
  }

  removeListener(
    event: "notification",
    listener: (notification: { channel: string; payload?: string }) => void,
  ): unknown;
  removeListener(event: "error", listener: () => void): unknown;
  removeListener(event: "end", listener: () => void): unknown;
  removeListener(
    event: "notification" | "error" | "end",
    listener: ((notification: {
      channel: string;
      payload?: string;
    }) => void) | (() => void),
  ): unknown {
    if (event === "notification") {
      this.notificationListeners.delete(listener as (
        notification: { channel: string; payload?: string }
      ) => void);
    } else if (event === "error") {
      this.errorListeners.delete(listener as () => void);
    } else this.endListeners.delete(listener as () => void);
    return this;
  }

  notify(payload: string): void {
    for (const listener of this.notificationListeners) {
      listener({
        channel: PROMOTION_JOB_IMMEDIATE_DELIVERY_CHANNEL,
        payload,
      });
    }
  }

  fail(): void {
    for (const listener of this.errorListeners) listener();
  }

  disconnect(): void {
    for (const listener of this.endListeners) listener();
  }
}

const providerRequest: ProviderPromotionImmediateDeliveryRequest = {
  authority: "provider_publication",
  cause: "canonical_settlement",
  scopeId: "00000000-0000-4000-8000-000000000501",
  sourceGeneration: 7n,
  sourceEvidenceDigest: "a".repeat(64),
  requestedAt: new Date("2026-09-02T06:00:00.000Z"),
};

test("authority-local notifications call the existing immediate adapter", async () => {
  const client = new MemoryNotificationClient();
  const delivered: ProviderPromotionImmediateDeliveryRequest[] = [];
  const subscriber = new PostgresPromotionImmediateDeliverySubscriber<
    ProviderPromotionImmediateDeliveryRequest
  >({
    databaseUrl: "postgresql://provider.invalid/packscout_alpha",
    authority: "provider_publication",
    delivery: {
      request(input) {
        delivered.push(input);
        return Promise.resolve();
      },
    },
    clientFactory: () => client,
  });

  await subscriber.start();
  client.notify(encodePromotionJobImmediateDelivery(providerRequest));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(delivered, [providerRequest]);
  assert.deepEqual(client.queries, [
    `LISTEN ${PROMOTION_JOB_IMMEDIATE_DELIVERY_CHANNEL}`,
  ]);
  await subscriber.stop();
  assert.equal(client.ended, true);
});

test("subscription and adapter failures remain best-effort", async () => {
  const logs: Parameters<PromotionImmediateDeliverySubscriberLogger["log"]>[0][]
    = [];
  const logger: PromotionImmediateDeliverySubscriberLogger = {
    log(record) { logs.push(record); },
  };
  const unavailable = new MemoryNotificationClient();
  unavailable.connectFailure = true;
  const unavailableSubscriber =
    new PostgresPromotionImmediateDeliverySubscriber<
    ProviderPromotionImmediateDeliveryRequest
  >({
    databaseUrl: "postgresql://provider.invalid/packscout_alpha",
    authority: "provider_publication",
    delivery: { request: () => Promise.resolve() },
    clientFactory: () => unavailable,
    logger,
  });
  await unavailableSubscriber.start();
  assert.equal(unavailable.ended, true);
  await unavailableSubscriber.stop();

  const client = new MemoryNotificationClient();
  const subscriber = new PostgresPromotionImmediateDeliverySubscriber<
    ProviderPromotionImmediateDeliveryRequest
  >({
    databaseUrl: "postgresql://provider.invalid/packscout_alpha",
    authority: "provider_publication",
    delivery: {
      request: () => Promise.reject(new Error("runtime is busy")),
    },
    clientFactory: () => client,
    logger,
  });
  await subscriber.start();
  client.notify(encodePromotionJobImmediateDelivery(providerRequest));
  client.notify("not-json");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(logs.map(({ outcome }) => outcome), [
    "subscription_failed",
    "invalid_payload",
    "delivery_failed",
  ]);
  await subscriber.stop();
});

test("subscription reconnects after startup, error, and normal connection loss", async () => {
  const first = new MemoryNotificationClient();
  first.connectFailure = true;
  const second = new MemoryNotificationClient();
  const third = new MemoryNotificationClient();
  const fourth = new MemoryNotificationClient();
  const clients = [first, second, third, fourth];
  let factoryIndex = 0;
  const subscriber = new PostgresPromotionImmediateDeliverySubscriber<
    ProviderPromotionImmediateDeliveryRequest
  >({
    databaseUrl: "postgresql://provider.invalid/packscout_alpha",
    authority: "provider_publication",
    delivery: { request: () => Promise.resolve() },
    clientFactory: () => clients[factoryIndex++]!,
    logger: { log: () => undefined },
    operationTimeoutMilliseconds: 5,
    retryMilliseconds: 5,
  });

  await subscriber.start();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(second.queries, [
    `LISTEN ${PROMOTION_JOB_IMMEDIATE_DELIVERY_CHANNEL}`,
  ]);

  second.fail();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(third.queries, [
    `LISTEN ${PROMOTION_JOB_IMMEDIATE_DELIVERY_CHANNEL}`,
  ]);
  third.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(fourth.queries, [
    `LISTEN ${PROMOTION_JOB_IMMEDIATE_DELIVERY_CHANNEL}`,
  ]);
  await subscriber.stop();
});

test("disabled optional subscription emits one authority-scoped warning", () => {
  const logs: Parameters<PromotionImmediateDeliverySubscriberLogger["log"]>[0][]
    = [];
  logPromotionImmediateDeliveryDisabled("provider_publication", {
    log(record) { logs.push(record); },
  });
  assert.deepEqual(logs, [{
    level: "warning",
    event: "promotion_job_immediate_delivery",
    authority: "provider_publication",
    outcome: "subscription_disabled",
    failureCode: "IMMEDIATE_DELIVERY_SUBSCRIPTION_DISABLED",
  }]);
});

test("repeated stop awaits one listener close and absorbs shutdown errors", async () => {
  const client = new MemoryNotificationClient();
  let finishEnd: (() => void) | undefined;
  client.end = () => new Promise<void>((resolve) => {
    finishEnd = resolve;
  });
  const subscriber = new PostgresPromotionImmediateDeliverySubscriber<
    ProviderPromotionImmediateDeliveryRequest
  >({
    databaseUrl: "postgresql://provider.invalid/packscout_alpha",
    authority: "provider_publication",
    delivery: { request: () => Promise.resolve() },
    clientFactory: () => client,
    logger: { log: () => undefined },
    operationTimeoutMilliseconds: 50,
  });
  await subscriber.start();

  const firstStop = subscriber.stop();
  client.fail();
  let secondSettled = false;
  const secondStop = subscriber.stop().then(() => {
    secondSettled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondSettled, false);
  finishEnd?.();
  await Promise.all([firstStop, secondStop]);
  assert.equal(client.errorListeners.size, 0);
});

test("a timed-out close keeps late socket errors guarded", async () => {
  const client = new MemoryNotificationClient();
  client.end = () => new Promise<void>(() => undefined);
  const subscriber = new PostgresPromotionImmediateDeliverySubscriber<
    ProviderPromotionImmediateDeliveryRequest
  >({
    databaseUrl: "postgresql://provider.invalid/packscout_alpha",
    authority: "provider_publication",
    delivery: { request: () => Promise.resolve() },
    clientFactory: () => client,
    logger: { log: () => undefined },
    operationTimeoutMilliseconds: 5,
  });
  await subscriber.start();

  await subscriber.stop();

  assert.equal(client.errorListeners.size, 1);
  client.fail();
  assert.equal(client.errorListeners.size, 1);
});

test("an error during a deferred connect cannot consume the reconnect", async () => {
  let finishConnect: (() => void) | undefined;
  const first = new MemoryNotificationClient();
  first.connect = () => new Promise<void>((resolve) => {
    finishConnect = resolve;
  });
  const second = new MemoryNotificationClient();
  const clients = [first, second];
  let factoryIndex = 0;
  const subscriber = new PostgresPromotionImmediateDeliverySubscriber<
    ProviderPromotionImmediateDeliveryRequest
  >({
    databaseUrl: "postgresql://provider.invalid/packscout_alpha",
    authority: "provider_publication",
    delivery: { request: () => Promise.resolve() },
    clientFactory: () => clients[factoryIndex++]!,
    logger: { log: () => undefined },
    operationTimeoutMilliseconds: 50,
    retryMilliseconds: 5,
  });

  const starting = subscriber.start();
  first.fail();
  await new Promise((resolve) => setTimeout(resolve, 10));
  finishConnect?.();
  await starting;
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(second.queries, [
    `LISTEN ${PROMOTION_JOB_IMMEDIATE_DELIVERY_CHANNEL}`,
  ]);
  await subscriber.stop();
});

test("LISTEN refuses a Neon transaction-pool endpoint", () => {
  assert.throws(
    () => new PostgresPromotionImmediateDeliverySubscriber({
      databaseUrl:
        "postgresql://role:secret@ep-alpha-pooler.us-west-2.aws.neon.tech/db",
      authority: "provider_publication",
      delivery: { request: () => Promise.resolve() },
    }),
    /direct PostgreSQL URL/u,
  );
});

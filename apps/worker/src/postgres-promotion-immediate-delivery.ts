import { Client } from "pg";
import {
  PROMOTION_JOB_IMMEDIATE_DELIVERY_CHANNEL,
  decodePromotionJobImmediateDelivery,
  type PromotionJobImmediateDeliveryRequest,
} from "@packscout/database";
import {
  promotionImmediateDeliveryTimeout,
  waitForPromotionImmediateDelivery,
} from "./promotion-immediate-delivery-timeout.ts";

interface PostgresNotification {
  readonly channel: string;
  readonly payload?: string;
}

export interface PromotionImmediateDeliverySubscriberClient {
  connect(): Promise<unknown>;
  query(statement: string): Promise<unknown>;
  end(): Promise<void>;
  on(
    event: "notification",
    listener: (notification: PostgresNotification) => void,
  ): unknown;
  on(event: "error", listener: () => void): unknown;
  on(event: "end", listener: () => void): unknown;
  removeListener(
    event: "notification",
    listener: (notification: PostgresNotification) => void,
  ): unknown;
  removeListener(event: "error", listener: () => void): unknown;
  removeListener(event: "end", listener: () => void): unknown;
}

export interface PromotionImmediateDeliverySubscriberLogger {
  log(record: Readonly<{
    level: "warning";
    event: "promotion_job_immediate_delivery";
    authority: PromotionJobImmediateDeliveryRequest["authority"];
    outcome:
      | "delivery_failed"
      | "invalid_payload"
      | "subscription_disabled"
      | "subscription_failed";
    failureCode:
      | "IMMEDIATE_DELIVERY_FAILED"
      | "IMMEDIATE_DELIVERY_INVALID"
      | "IMMEDIATE_DELIVERY_SUBSCRIPTION_DISABLED"
      | "IMMEDIATE_DELIVERY_SUBSCRIPTION_FAILED";
  }>): void;
}

const consoleLogger: PromotionImmediateDeliverySubscriberLogger = {
  log(record) {
    console.warn(JSON.stringify(record));
  },
};

export function logPromotionImmediateDeliveryDisabled(
  authority: PromotionJobImmediateDeliveryRequest["authority"],
  logger: PromotionImmediateDeliverySubscriberLogger = consoleLogger,
): void {
  logger.log({
    level: "warning",
    event: "promotion_job_immediate_delivery",
    authority,
    outcome: "subscription_disabled",
    failureCode: "IMMEDIATE_DELIVERY_SUBSCRIPTION_DISABLED",
  });
}

export function promotionImmediateDeliveryListenDatabaseUrl(
  value: string,
): string {
  try {
    const url = new URL(value);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol)
      || !url.hostname
      || url.hostname.includes("-pooler.")
      || url.searchParams.get("pgbouncer") === "true"
      || url.searchParams.get("pool_mode") === "transaction"
    ) throw new Error("invalid");
    return value;
  } catch {
    throw new TypeError(
      "Promotion immediate delivery requires a direct PostgreSQL URL.",
    );
  }
}

/**
 * Authority-local PostgreSQL LISTEN host. Notifications are only latency
 * hints; malformed, lost, duplicated, or unavailable delivery never changes
 * durable admission and never stops the one-minute reconciliation runtime.
 */
export class PostgresPromotionImmediateDeliverySubscriber<
  TRequest extends PromotionJobImmediateDeliveryRequest,
> {
  readonly #clientFactory: () => PromotionImmediateDeliverySubscriberClient;
  readonly #logger: PromotionImmediateDeliverySubscriberLogger;
  readonly #operationTimeoutMilliseconds: number;
  readonly #retryMilliseconds: number;
  #client: PromotionImmediateDeliverySubscriberClient | null = null;
  #notificationListener: ((notification: PostgresNotification) => void) | null =
    null;
  #errorListener: (() => void) | null = null;
  #endListener: (() => void) | null = null;
  #attemptPromise: Promise<void> | null = null;
  #dropPromise: Promise<void> | null = null;
  #retryTimer: NodeJS.Timeout | null = null;
  #running = false;

  constructor(private readonly dependencies: Readonly<{
    databaseUrl: string;
    authority: TRequest["authority"];
    delivery: Readonly<{ request(input: TRequest): Promise<void> }>;
    clientFactory?: () => PromotionImmediateDeliverySubscriberClient;
    logger?: PromotionImmediateDeliverySubscriberLogger;
    operationTimeoutMilliseconds?: number;
    retryMilliseconds?: number;
  }>) {
    promotionImmediateDeliveryListenDatabaseUrl(dependencies.databaseUrl);
    this.#operationTimeoutMilliseconds = promotionImmediateDeliveryTimeout(
      dependencies.operationTimeoutMilliseconds,
    );
    this.#retryMilliseconds = promotionImmediateDeliveryTimeout(
      dependencies.retryMilliseconds,
    );
    this.#clientFactory = dependencies.clientFactory ?? (() =>
      new Client({
        connectionString: dependencies.databaseUrl,
        application_name: `packscout-${dependencies.authority}-immediate`,
        connectionTimeoutMillis: this.#operationTimeoutMilliseconds,
        query_timeout: this.#operationTimeoutMilliseconds,
        statement_timeout: this.#operationTimeoutMilliseconds,
      }) as unknown as PromotionImmediateDeliverySubscriberClient);
    this.#logger = dependencies.logger ?? consoleLogger;
  }

  start(): Promise<void> {
    this.#running = true;
    if (this.#client !== null) return Promise.resolve();
    if (this.#retryTimer !== null) return Promise.resolve();
    return this.#startAttempt();
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    await this.#dropClient(this.#client);
  }

  #startAttempt(): Promise<void> {
    if (this.#attemptPromise !== null) return this.#attemptPromise;
    const attempt = this.#connect().finally(() => {
      if (this.#attemptPromise === attempt) this.#attemptPromise = null;
    });
    this.#attemptPromise = attempt;
    return attempt;
  }

  #dropClient(
    expected: PromotionImmediateDeliverySubscriberClient | null,
  ): Promise<void> {
    if (expected === null || this.#client !== expected) {
      return this.#dropPromise ?? Promise.resolve();
    }
    const client = this.#client;
    const notificationListener = this.#notificationListener;
    const errorListener = this.#errorListener;
    const endListener = this.#endListener;
    this.#client = null;
    this.#notificationListener = null;
    this.#errorListener = null;
    this.#endListener = null;
    if (notificationListener !== null) {
      client.removeListener("notification", notificationListener);
    }
    if (endListener !== null) client.removeListener("end", endListener);
    const ending = Promise.resolve().then(() => client.end());
    void ending.then(
      () => {
        if (errorListener !== null) client.removeListener("error", errorListener);
      },
      () => {
        if (errorListener !== null) client.removeListener("error", errorListener);
      },
    );
    const drop = waitForPromotionImmediateDelivery(
      () => ending,
      this.#operationTimeoutMilliseconds,
    ).catch(() => undefined).finally(() => {
      if (this.#dropPromise === drop) this.#dropPromise = null;
    });
    this.#dropPromise = drop;
    return drop;
  }

  async #connect(): Promise<void> {
    if (!this.#running || this.#client !== null) return;
    const client = this.#clientFactory();
    const notificationListener = (notification: PostgresNotification) => {
      if (notification.channel !== PROMOTION_JOB_IMMEDIATE_DELIVERY_CHANNEL) {
        return;
      }
      const request = decodePromotionJobImmediateDelivery(
        notification.payload,
      );
      if (
        request === null || request.authority !== this.dependencies.authority
      ) {
        this.#log("invalid_payload", "IMMEDIATE_DELIVERY_INVALID");
        return;
      }
      void this.dependencies.delivery.request(request as TRequest).catch(() => {
        this.#log("delivery_failed", "IMMEDIATE_DELIVERY_FAILED");
      });
    };
    const errorListener = () => {
      if (!this.#running || this.#client !== client) return;
      this.#log(
        "subscription_failed",
        "IMMEDIATE_DELIVERY_SUBSCRIPTION_FAILED",
      );
      void this.#recover(client);
    };
    const endListener = () => {
      if (!this.#running || this.#client !== client) return;
      this.#log(
        "subscription_failed",
        "IMMEDIATE_DELIVERY_SUBSCRIPTION_FAILED",
      );
      void this.#recover(client);
    };
    this.#client = client;
    this.#notificationListener = notificationListener;
    this.#errorListener = errorListener;
    this.#endListener = endListener;
    client.on("notification", notificationListener);
    client.on("error", errorListener);
    client.on("end", endListener);
    try {
      await waitForPromotionImmediateDelivery(
        () => client.connect(),
        this.#operationTimeoutMilliseconds,
      );
      if (this.#client !== client) return;
      await waitForPromotionImmediateDelivery(
        () => client.query(
          `LISTEN ${PROMOTION_JOB_IMMEDIATE_DELIVERY_CHANNEL}`,
        ),
        this.#operationTimeoutMilliseconds,
      );
    } catch {
      this.#log(
        "subscription_failed",
        "IMMEDIATE_DELIVERY_SUBSCRIPTION_FAILED",
      );
      await this.#dropClient(client);
      this.#scheduleRetry();
    }
  }

  async #recover(
    client: PromotionImmediateDeliverySubscriberClient,
  ): Promise<void> {
    await this.#dropClient(client);
    this.#scheduleRetry();
  }

  #scheduleRetry(): void {
    if (!this.#running || this.#retryTimer !== null) return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      if (!this.#running) return;
      if (this.#attemptPromise !== null) {
        this.#scheduleRetry();
        return;
      }
      void this.#startAttempt();
    }, this.#retryMilliseconds);
  }

  #log(
    outcome: Parameters<PromotionImmediateDeliverySubscriberLogger["log"]>[0]["outcome"],
    failureCode: Parameters<PromotionImmediateDeliverySubscriberLogger["log"]>[0]["failureCode"],
  ): void {
    this.#logger.log({
      level: "warning",
      event: "promotion_job_immediate_delivery",
      authority: this.dependencies.authority,
      outcome,
      failureCode,
    });
  }
}

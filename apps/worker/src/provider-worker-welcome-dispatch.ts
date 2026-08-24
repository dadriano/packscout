import {
  createWelcomeDispatchDirectoryClient,
  resolveWelcomeDispatchSettings,
  WelcomeDispatchService,
  type ProviderClock,
  type WelcomeDispatchCycleResult,
  type WelcomeDispatchDirectoryPort,
  type WelcomeDispatchOutboxPort,
} from "@packscout/services";

/**
 * The provider worker's welcome-dispatch job (messaging/007), the sibling of
 * the message-outbox drain: the runtime calls it every worker cycle, and the
 * processor spaces real dispatcher passes on its own configured cadence,
 * reporting `waiting` in between — except that a full batch opens the gate
 * immediately so a backlog drains at cycle speed.
 *
 * The welcome kind's independence lives here: its off switch and its
 * integration configuration are resolved per pass from the environment, and
 * a disabled or unconfigured dispatcher idles without touching anything —
 * the outbox drain, alert routing, and every other message kind are
 * composed separately and never consult this job.
 */

export type ProviderWorkerWelcomeDispatchCycleResult =
  | WelcomeDispatchCycleResult
  | { readonly outcome: "waiting" }
  | { readonly outcome: "disabled" }
  | { readonly outcome: "unconfigured" };

export interface ProviderWorkerWelcomeDispatchPort {
  runCycle(): Promise<ProviderWorkerWelcomeDispatchCycleResult>;
}

export interface ProviderWorkerWelcomeDispatchSettings {
  readonly batchSize: number;
  readonly leaseMilliseconds: number;
  readonly pollIntervalMilliseconds: number;
}

export interface ProviderWorkerWelcomeDispatchInput {
  /** Environment the off switch and integration resolve from, per pass. */
  readonly env: NodeJS.ProcessEnv;
  /** The durable outbox's enqueue side; delivery stays the drain's job. */
  readonly outbox: WelcomeDispatchOutboxPort;
  readonly clock: ProviderClock;
  readonly settings: ProviderWorkerWelcomeDispatchSettings;
  readonly fetchImplementation?: typeof fetch;
  /** Test seam; production always talks to the configured integration. */
  readonly directory?: WelcomeDispatchDirectoryPort;
}

export function createProviderWorkerWelcomeDispatchProcessor(
  input: ProviderWorkerWelcomeDispatchInput,
): ProviderWorkerWelcomeDispatchPort {
  const pollIntervalMilliseconds = input.settings.pollIntervalMilliseconds;
  if (
    !Number.isInteger(pollIntervalMilliseconds) ||
    pollIntervalMilliseconds < 100 ||
    pollIntervalMilliseconds > 300_000
  ) {
    throw new RangeError(
      "Welcome dispatch poll interval is outside its safe bounds.",
    );
  }
  let nextPassAt: number | null = null;
  // One client per integration configuration; a changed origin or secret
  // (a fresh environment object in tests, a restart in production) rebuilds.
  let clientKey: string | null = null;
  let client: WelcomeDispatchDirectoryPort | null = null;

  function resolveClient(config: {
    baseUrl: string;
    token: string;
  }): WelcomeDispatchDirectoryPort {
    const key = `${config.baseUrl} ${config.token}`;
    if (client === null || clientKey !== key) {
      client = createWelcomeDispatchDirectoryClient({
        config,
        ...(input.fetchImplementation === undefined
          ? {}
          : { fetchImplementation: input.fetchImplementation }),
      });
      clientKey = key;
    }
    return client;
  }

  return {
    async runCycle(): Promise<ProviderWorkerWelcomeDispatchCycleResult> {
      const startedAt = input.clock.now().getTime();
      if (nextPassAt !== null && startedAt < nextPassAt) {
        return { outcome: "waiting" };
      }
      const settings = resolveWelcomeDispatchSettings(input.env);
      if (!settings.enabled || settings.integration === null) {
        nextPassAt = input.clock.now().getTime() + pollIntervalMilliseconds;
        return { outcome: settings.enabled ? "unconfigured" : "disabled" };
      }
      const directory = input.directory ?? resolveClient(settings.integration);
      const dispatch = new WelcomeDispatchService({
        directory,
        outbox: input.outbox,
        options: {
          batchSize: input.settings.batchSize,
          leaseMilliseconds: input.settings.leaseMilliseconds,
        },
      });
      const result = await dispatch.runCycle();
      nextPassAt = result.capReached
        ? input.clock.now().getTime()
        : input.clock.now().getTime() + pollIntervalMilliseconds;
      return result;
    },
  };
}

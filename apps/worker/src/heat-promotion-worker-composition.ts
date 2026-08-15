import {
  HeatPromotionBootstrapCoordinator,
  HeatPromotionRunner,
  SignedConvexHeatPublicationClient,
  type HeatPromotionAlertSink,
  type HeatPromotionHealthSink,
  type HeatPromotionLedgerPort,
  type HeatPromotionObservationPort,
  type HeatPromotionReleaseProofPort,
  type HeatPromotionSettlementPort,
} from "@packscout/services";
import type { HeatPromotionWorkerConfiguration } from "./heat-promotion-worker-config.ts";
import {
  HeatPromotionWorkerHealthLogger,
  HeatPromotionWorkerRuntime,
  type HeatPromotionRetentionPort,
  type HeatPromotionWorkerLogger,
  type HeatPromotionWorkerSleeper,
} from "./heat-promotion-worker-runtime.ts";
import { runPromotionObservabilityFanout } from "./promotion-observability-fanout.ts";

export interface HeatPromotionWorkerCompositionInput {
  readonly configuration: HeatPromotionWorkerConfiguration;
  readonly workerId: string;
  readonly ledger: HeatPromotionLedgerPort;
  readonly settlement: HeatPromotionSettlementPort;
  readonly releases: HeatPromotionReleaseProofPort;
  readonly observations: HeatPromotionObservationPort;
  readonly retention: HeatPromotionRetentionPort;
  readonly alerts: HeatPromotionAlertSink;
  readonly health?: HeatPromotionHealthSink;
  readonly logger: HeatPromotionWorkerLogger;
  readonly clock?: { now(): Date };
  readonly random?: { fraction(): number };
  readonly fetch?: typeof fetch;
  readonly nonce?: () => string;
  readonly sleeper?: HeatPromotionWorkerSleeper;
}

export function createHeatPromotionWorkerRuntime(
  input: HeatPromotionWorkerCompositionInput,
): HeatPromotionWorkerRuntime {
  const clock = input.clock ?? { now: () => new Date() };
  const transport = new SignedConvexHeatPublicationClient({
    baseUrl: input.configuration.convexBaseUrl,
    keyId: input.configuration.keyId,
    secret: input.configuration.secret,
    timeoutMilliseconds: input.configuration.requestTimeoutMilliseconds,
    now: () => clock.now(),
    fetch: input.fetch,
    nonce: input.nonce,
  });
  const healthLogger = new HeatPromotionWorkerHealthLogger(
    input.logger,
    input.workerId,
  );
  const runner = new HeatPromotionRunner({
    workerId: input.workerId,
    ledger: input.ledger,
    settlement: input.settlement,
    releases: input.releases,
    observations: input.observations,
    transport,
    bootstrap: new HeatPromotionBootstrapCoordinator(input.ledger, transport),
    clock,
    alerts: input.alerts,
    health: {
      async report(health) {
        await runPromotionObservabilityFanout(
          () => input.health?.report(health),
          () => healthLogger.report(health),
        );
      },
    },
    random: input.random,
  });
  return new HeatPromotionWorkerRuntime({
    runner,
    retention: input.retention,
    logger: input.logger,
    workerId: input.workerId,
    clock,
    sleeper: input.sleeper,
  });
}

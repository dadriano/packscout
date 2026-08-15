import {
  CatalogPromotionRunner,
  CatalogPromotionBootstrapCoordinator,
  SignedConvexCatalogPublicationClient,
  type CatalogPromotionAlertSink,
  type CatalogPromotionLedgerPort,
  type CatalogPromotionBootstrapLedgerPort,
  type CatalogPromotionHealthSink,
  type CatalogPromotionRandom,
  type CatalogPromotionSettlementPort,
  type CatalogReleaseAssemblerPort,
} from "@packscout/services";
import type { CatalogPromotionWorkerConfiguration } from "./catalog-promotion-worker-config.ts";
import {
  CatalogPromotionWorkerHealthLogger,
  CatalogPromotionWorkerRuntime,
  type CatalogPromotionWorkerLogger,
  type CatalogPromotionWorkerSleeper,
} from "./catalog-promotion-worker-runtime.ts";

export interface CatalogPromotionWorkerCompositionInput {
  readonly configuration: CatalogPromotionWorkerConfiguration;
  readonly organizationId: string;
  readonly workerId: string;
  readonly ledger: CatalogPromotionLedgerPort;
  readonly bootstrapLedger: CatalogPromotionBootstrapLedgerPort;
  readonly settlement: CatalogPromotionSettlementPort;
  readonly assembler: CatalogReleaseAssemblerPort;
  readonly alerts: CatalogPromotionAlertSink;
  readonly health?: CatalogPromotionHealthSink;
  readonly logger: CatalogPromotionWorkerLogger;
  readonly clock?: { now(): Date };
  readonly random?: CatalogPromotionRandom;
  readonly fetch?: typeof fetch;
  readonly nonce?: () => string;
  readonly sleeper?: CatalogPromotionWorkerSleeper;
}

export function createCatalogPromotionWorkerRuntime(
  input: CatalogPromotionWorkerCompositionInput,
): CatalogPromotionWorkerRuntime {
  const clock = input.clock ?? { now: () => new Date() };
  const transport = new SignedConvexCatalogPublicationClient({
    baseUrl: input.configuration.convexBaseUrl,
    keyId: input.configuration.keyId,
    secret: input.configuration.secret,
    timeoutMilliseconds: input.configuration.requestTimeoutMilliseconds,
    now: () => clock.now(),
    fetch: input.fetch,
    nonce: input.nonce,
  });
  const healthLogger = new CatalogPromotionWorkerHealthLogger(
    input.logger,
    input.workerId,
    () => clock.now(),
  );
  const runner = new CatalogPromotionRunner({
    organizationId: input.organizationId,
    deploymentKey: input.configuration.deploymentKey,
    workerId: input.workerId,
    ledger: input.ledger,
    bootstrap: new CatalogPromotionBootstrapCoordinator(
      input.bootstrapLedger,
      transport,
    ),
    settlement: input.settlement,
    assembler: input.assembler,
    transport,
    clock,
    random: input.random,
    alerts: input.alerts,
    health: {
      async report(health) {
        healthLogger.report(health);
        await input.health?.report(health);
      },
    },
  });
  return new CatalogPromotionWorkerRuntime({
    runner,
    logger: input.logger,
    workerId: input.workerId,
    pollIntervalMilliseconds: input.configuration.pollIntervalMilliseconds,
    sleeper: input.sleeper,
  });
}

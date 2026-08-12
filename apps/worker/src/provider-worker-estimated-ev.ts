import {
  DrizzleEstimatedEvRecomputationRepository,
  type createNodePostgresDatabase,
} from "@packscout/database";
import {
  CanonicalEstimatedEvProjectionRepository,
  EstimatedEvRecomputationProcessor,
  PackScoutEstimatedEvService,
  type EstimatedEvCanonicalHistoryPort,
  type PipelineOperationalReporter,
  type ProviderClock,
} from "@packscout/services";

type NodePostgresDatabase = ReturnType<typeof createNodePostgresDatabase>;

export interface ProviderWorkerEstimatedEvInput {
  readonly database: NodePostgresDatabase;
  readonly canonical: EstimatedEvCanonicalHistoryPort;
  readonly reporter: Pick<PipelineOperationalReporter, "calculation">;
  readonly clock: ProviderClock;
  readonly workerId: string;
  readonly verifiedUsdStablecoins?: readonly string[];
}

export function createProviderWorkerEstimatedEvProcessor(
  input: ProviderWorkerEstimatedEvInput,
): EstimatedEvRecomputationProcessor {
  const projections = new CanonicalEstimatedEvProjectionRepository(
    input.canonical,
  );
  return new EstimatedEvRecomputationProcessor(
    new DrizzleEstimatedEvRecomputationRepository(input.database),
    new PackScoutEstimatedEvService(projections, input.reporter),
    input.clock,
    {
      workerId: input.workerId,
      maximumRequestsPerCycle: 25,
      leaseMilliseconds: 30_000,
      retryDelayMilliseconds: 1_000,
      maximumAttempts: 5,
      verifiedUsdStablecoins: input.verifiedUsdStablecoins,
    },
  );
}

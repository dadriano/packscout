import {
  ProviderReleasePublicationRepository,
  ProviderReleaseRepository,
  type ProviderPrismaClient,
  type ProviderReleaseAssemblyResult,
} from "@packscout/database";
import {
  DistributedProviderReleasePublicationService,
  type DistributedProviderPublicationMetric,
  type DistributedProviderPublicationResult,
  type DistributedProviderReleasePublicationTransport,
} from "@packscout/services";

export interface BoundProviderReleasePublicationExecutor {
  publish(
    assembly: ProviderReleaseAssemblyResult,
    signal?: AbortSignal,
    deadlineAt?: number,
    cleanupDeadlineAt?: number,
  ): Promise<DistributedProviderPublicationResult>;
}

/**
 * Binds one publication executor to one already-authorized provider database
 * and one provider credential. Provider selection and central orchestration
 * deliberately stay outside this constructor.
 */
export function createBoundProviderReleasePublicationExecutor(input: {
  readonly provider: ProviderPrismaClient;
  readonly workerId: string;
  readonly transport: DistributedProviderReleasePublicationTransport;
  readonly leaseMilliseconds?: number;
  readonly now?: () => Date;
  readonly emitMetric?: (metric: DistributedProviderPublicationMetric) => void;
}): BoundProviderReleasePublicationExecutor {
  const releases = new ProviderReleaseRepository(input.provider);
  const service = new DistributedProviderReleasePublicationService({
    workerId: input.workerId,
    releases,
    publications: new ProviderReleasePublicationRepository(input.provider),
    transport: input.transport,
    ...(input.leaseMilliseconds === undefined
      ? {}
      : { leaseMilliseconds: input.leaseMilliseconds }),
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.emitMetric === undefined ? {} : { emitMetric: input.emitMetric }),
  });
  return {
    publish: (assembly, signal, deadlineAt, cleanupDeadlineAt) =>
      service.publish(assembly, signal, deadlineAt, cleanupDeadlineAt),
  };
}

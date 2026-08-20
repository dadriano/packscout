import {
  PrismaPublicChangeSettlementRepository,
  type PackscoutPrismaClient,
} from "@packscout/database";
import { PublicChangeSettlementService } from "@packscout/services";

export function createProviderWorkerPublicSettlementReader(input: {
  database: PackscoutPrismaClient;
  publicOrganizationId: string;
}): PublicChangeSettlementService {
  return new PublicChangeSettlementService(
    new PrismaPublicChangeSettlementRepository(input.database),
    { organizationId: input.publicOrganizationId },
  );
}

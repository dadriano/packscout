const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface PublicChangeCheckpoint {
  readonly organizationId: string;
  readonly settledSequence: bigint;
  readonly settledAt: Date | null;
  readonly sourceHeadSequence: bigint;
  readonly sourceHeadAt: Date | null;
  readonly sourceHeads: readonly Readonly<{
    sourceKey: string;
    sourceRevisionKey: string | null;
    sequence: bigint;
    occurredAt: Date;
    settled: boolean;
  }>[];
}

export interface SettledPublicChange {
  readonly organizationId: string;
  readonly sequence: bigint;
  readonly changeKind:
    | "provider_projection"
    | "quarantine_correction"
    | "relationship_resolution"
    | "estimated_ev_outcome"
    | "public_configuration"
    | "provider_lifecycle"
    | "manual_correction";
  readonly entityKey: string;
  readonly sourceKey: string | null;
  readonly sourceRevisionKey: string | null;
  readonly metadata: Record<string, unknown>;
  readonly occurredAt: Date;
  readonly authoritativeTransactionId: string;
}

export interface PublicChangeSettlementReadPort {
  getSettledWatermark(organizationId: string): Promise<PublicChangeCheckpoint>;
  listSettledCauses(input: {
    organizationId: string;
    afterSequence: bigint;
    throughSequence: bigint;
    limit: number;
  }): Promise<readonly SettledPublicChange[]>;
}

export class PublicOrganizationConfigurationError extends Error {
  readonly code = "PUBLIC_ORGANIZATION_ID_INVALID" as const;

  constructor() {
    super("Public organization configuration is invalid.");
    this.name = "PublicOrganizationConfigurationError";
  }
}

export function resolvePackScoutPublicOrganizationId(
  value: string | undefined,
): string {
  if (!value || !uuidPattern.test(value)) {
    throw new PublicOrganizationConfigurationError();
  }
  return value.toLowerCase();
}

/**
 * Binds the only publishable PackScout organization at construction time.
 * Public request data never supplies or overrides this tenant boundary.
 */
export class PublicChangeSettlementService {
  readonly #organizationId: string;

  constructor(
    private readonly repository: PublicChangeSettlementReadPort,
    configuration: { organizationId: string },
  ) {
    this.#organizationId = resolvePackScoutPublicOrganizationId(
      configuration.organizationId,
    );
  }

  getCheckpoint(): Promise<PublicChangeCheckpoint> {
    return this.repository.getSettledWatermark(this.#organizationId);
  }

  async listSettledChanges(input: {
    afterSequence: bigint;
    throughSequence?: bigint;
    limit?: number;
  }): Promise<readonly SettledPublicChange[]> {
    const checkpoint = await this.getCheckpoint();
    const throughSequence = input.throughSequence ?? checkpoint.settledSequence;
    if (throughSequence > checkpoint.settledSequence) {
      throw new RangeError("Public changes cannot be read beyond settlement.");
    }
    return this.repository.listSettledCauses({
      organizationId: this.#organizationId,
      afterSequence: input.afterSequence,
      throughSequence,
      limit: input.limit ?? 500,
    });
  }
}

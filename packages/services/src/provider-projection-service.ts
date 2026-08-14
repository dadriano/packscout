import type {
  ProviderProjectionOutcome,
  ProviderProjectionPort,
} from "./provider-import-types.ts";

const catalogKinds = new Set(["catalog_asset", "ev_input", "pack"]);
const eventKinds = new Set(["pull", "trade"]);

export class ProviderProjectionService implements ProviderProjectionPort {
  constructor(
    private readonly catalog: ProviderProjectionPort,
    private readonly events: ProviderProjectionPort,
  ) {}

  project(
    input: Parameters<ProviderProjectionPort["project"]>[0],
  ): ProviderProjectionOutcome | Promise<ProviderProjectionOutcome> {
    if (input.candidates.length === 0) {
      return {
        status: "invalid",
        reasonCode: "PROJECTION_CANDIDATE_SET_EMPTY",
        fieldPath: "candidates",
      };
    }
    const kinds = new Set(input.candidates.map(({ candidateKind }) => candidateKind));
    if ([...kinds].every((kind) => catalogKinds.has(kind))) {
      return this.catalog.project(input);
    }
    if ([...kinds].every((kind) => eventKinds.has(kind))) {
      return this.events.project(input);
    }
    return {
      status: "invalid",
      reasonCode: "PROJECTION_CANDIDATE_SET_MIXED",
      fieldPath: "candidates",
    };
  }
}

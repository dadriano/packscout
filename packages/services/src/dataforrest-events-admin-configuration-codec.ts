import type { LaunchProviderKey } from "@packscout/contracts";
import type {
  ImmutableSourceAdapterConfiguration,
  SourceAdapter,
  SourceAdapterConfigurationValidation,
} from "./source-adapter.ts";
import type { SourceAdminConfigurationCodec } from "./source-admin-configuration-codec.ts";

export class DataforrestEventsAdminConfigurationCodec
  implements SourceAdminConfigurationCodec {
  readonly sourceTypeKey: string;
  readonly adapterVersion: string;

  constructor(private readonly adapter: SourceAdapter) {
    this.sourceTypeKey = adapter.manifest.sourceTypeKey;
    this.adapterVersion = adapter.manifest.adapterVersion;
  }

  createConnection(input: Readonly<{
    endpoint: string;
    credential: string;
  }>): SourceAdapterConfigurationValidation {
    return this.adapter.validateConnectionConfiguration({
      endpoint: input.endpoint,
      bearerToken: input.credential,
    });
  }

  rotateCredential(
    current: ImmutableSourceAdapterConfiguration,
    input: Readonly<{ credential: string }>,
  ): SourceAdapterConfigurationValidation {
    if (typeof current.endpoint !== "string") {
      return this.adapter.validateConnectionConfiguration(null);
    }
    return this.adapter.validateConnectionConfiguration({
      endpoint: current.endpoint,
      bearerToken: input.credential,
    });
  }

  createSource(provider: LaunchProviderKey): SourceAdapterConfigurationValidation {
    return this.adapter.validateSourceConfiguration(provider, {
      platform: provider,
    });
  }

  describeConnection(
    configuration: ImmutableSourceAdapterConfiguration,
  ): Readonly<{ endpointHost: string }> | null {
    if (typeof configuration.endpoint !== "string") return null;
    try {
      return Object.freeze({ endpointHost: new URL(configuration.endpoint).hostname });
    } catch {
      return null;
    }
  }
}

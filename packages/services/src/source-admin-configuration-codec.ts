import type { LaunchProviderKey } from "@packscout/contracts";
import type {
  ImmutableSourceAdapterConfiguration,
  SourceAdapterConfigurationValidation,
} from "./source-adapter.ts";

export interface SourceAdminConfigurationCodec {
  readonly sourceTypeKey: string;
  readonly adapterVersion: string;
  createConnection(input: Readonly<{
    endpoint: string;
    credential: string;
  }>): SourceAdapterConfigurationValidation;
  rotateCredential(
    current: ImmutableSourceAdapterConfiguration,
    input: Readonly<{ credential: string }>,
  ): SourceAdapterConfigurationValidation;
  createSource(
    provider: LaunchProviderKey,
  ): SourceAdapterConfigurationValidation;
  describeConnection(
    configuration: ImmutableSourceAdapterConfiguration,
  ): Readonly<{ endpointHost: string }> | null;
}

export class SourceAdminConfigurationCodecRegistry {
  readonly #codecs = new Map<string, SourceAdminConfigurationCodec>();

  constructor(codecs: Iterable<SourceAdminConfigurationCodec>) {
    for (const codec of codecs) {
      const key = this.#key(codec.sourceTypeKey, codec.adapterVersion);
      if (this.#codecs.has(key)) {
        throw new TypeError("Duplicate source admin configuration codec.");
      }
      this.#codecs.set(key, Object.freeze({
        sourceTypeKey: codec.sourceTypeKey,
        adapterVersion: codec.adapterVersion,
        createConnection: codec.createConnection.bind(codec),
        rotateCredential: codec.rotateCredential.bind(codec),
        createSource: codec.createSource.bind(codec),
        describeConnection: codec.describeConnection.bind(codec),
      }));
    }
  }

  resolve(sourceTypeKey: string, adapterVersion: string): SourceAdminConfigurationCodec {
    const codec = this.#codecs.get(this.#key(sourceTypeKey, adapterVersion));
    if (!codec) throw new TypeError("Source admin configuration codec is not registered.");
    return codec;
  }

  #key(sourceTypeKey: string, adapterVersion: string): string {
    return JSON.stringify([sourceTypeKey, adapterVersion]);
  }
}

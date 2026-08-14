import {
  ProviderTransportAdapterRegistry,
  ProviderTransportRequestError,
  type ProviderTransportAdapter,
} from "@packscout/services";

const decoderUnavailableFailure = Object.freeze({
  code: "invalid_configuration" as const,
  retryable: false,
  issueCodes: Object.freeze(["live_response_decoder_unavailable"]),
});

/**
 * Declares the configuration key without pretending the live API can be read.
 * Provider drafts and revisions remain editable, while connection tests fail
 * closed and activation therefore stays gated on a real decoder-backed adapter.
 */
class DecoderUnavailableHttpCursorV2Adapter
  implements ProviderTransportAdapter
{
  readonly key = "http-cursor-v2";

  supportsPlatform(platform: string): boolean {
    return platform.trim().length > 0;
  }

  async testConnection() {
    return {
      ok: false as const,
      latencyMs: 0,
      failure: decoderUnavailableFailure,
    };
  }

  async fetchPage(): Promise<never> {
    throw new ProviderTransportRequestError(decoderUnavailableFailure);
  }
}

export function createProviderConfigurationTransportRegistry(): ProviderTransportAdapterRegistry {
  return new ProviderTransportAdapterRegistry([
    new DecoderUnavailableHttpCursorV2Adapter(),
  ]);
}

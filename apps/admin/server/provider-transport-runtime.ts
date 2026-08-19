import {
  createDataForrestProviderTransportRegistry,
  type HttpCursorAdapterDependencies,
} from "@packscout/services";

export function createProviderLiveTransportRegistry(
  dependencies: Omit<HttpCursorAdapterDependencies, "decoder"> = {},
) {
  return createDataForrestProviderTransportRegistry(dependencies);
}

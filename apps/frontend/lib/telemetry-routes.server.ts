import {
  parseAnonymousProductEvent,
  parsePublicReadFailureBeacon,
  type AnonymousProductEvent,
  type PublicReadFailureBeacon,
} from "./telemetry-contract";
import {
  createTelemetryIngressHandler,
  type TelemetryIngressDependencies,
} from "./telemetry-request.server";

export type ProductTelemetryRouteDependencies = Omit<
  TelemetryIngressDependencies<AnonymousProductEvent>,
  "parse"
>;

export type PublicReadFailureRouteDependencies = Omit<
  TelemetryIngressDependencies<PublicReadFailureBeacon>,
  "parse"
>;

export function createProductTelemetryPostHandler(
  dependencies: ProductTelemetryRouteDependencies,
) {
  return createTelemetryIngressHandler({
    ...dependencies,
    parse: parseAnonymousProductEvent,
  });
}

export function createPublicReadFailurePostHandler(
  dependencies: PublicReadFailureRouteDependencies,
) {
  return createTelemetryIngressHandler({
    ...dependencies,
    parse: parsePublicReadFailureBeacon,
  });
}

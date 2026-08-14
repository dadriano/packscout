import { parsePublicReadFailureBeacon } from "@/lib/telemetry-contract";
import {
  configuredPublicOrigin,
  createTelemetryIngressHandler,
  unavailableTelemetryDependencies,
} from "@/lib/telemetry-request.server";

export const dynamic = "force-dynamic";

export const POST = createTelemetryIngressHandler(
  unavailableTelemetryDependencies(
    configuredPublicOrigin(),
    parsePublicReadFailureBeacon,
  ),
);

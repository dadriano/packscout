import net from "node:net";
import { localBackfillProviderPorts } from "./provider-backfill-supervisor-authority.mts";
import { refuseBackfill, type BackfillPins } from "./provider-backfill-supervisor-policy.mts";
import type { ContinuousCadence } from "./provider-continuous-cadence.mts";
import type { ContinuousPostHeadPolicy } from "./provider-continuous-post-head-policy.mts";

export const continuousResidencyPort = (pins: BackfillPins) => localBackfillProviderPorts[pins.providerKey] + 1000;
export interface ContinuousHealth {
  state: string;
  runId?: string;
  nextDueAt?: string;
  code?: string;
  /** Consecutive bounded retries of a provider-database refusal, when in that state. */
  retry?: number;
  cadence?: ContinuousCadence;
  effectiveIntervalSeconds?: number;
  postHeadPolicy?: ContinuousPostHeadPolicy;
}
/** Local-host exclusivity, not a replacement for database fencing. The kernel
 * releases the port after a crash, so no PID file is deleted or trusted. */
export async function claimContinuousResidency(pins: BackfillPins, health: () => ContinuousHealth,
  port = continuousResidencyPort(pins)) {
  const server = net.createServer(socket => {
    socket.on("error", () => socket.destroy());
    socket.setTimeout(1000, () => socket.destroy());
    socket.end(`${JSON.stringify({ event: "provider_continuous_health", providerId: pins.providerId,
      providerKey: pins.providerKey, operationId: pins.operationId, pid: process.pid,
      observedAt: new Date().toISOString(), ...health() })}\n`);
  });
  server.maxConnections = 4;
  await new Promise<void>((resolve, reject) => {
    server.once("error", () => reject(new Error("CONTINUOUS_RESIDENT_ALREADY_OWNED")));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
  }).catch(() => refuseBackfill("CONTINUOUS_RESIDENT_ALREADY_OWNED"));
  return { port: (server.address() as net.AddressInfo).port,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
export async function withContinuousResidency<T>(pins: BackfillPins, health: () => ContinuousHealth,
  run: () => Promise<T>, port = continuousResidencyPort(pins)): Promise<T> {
  const residency = await claimContinuousResidency(pins, health, port);
  try { return await run(); } finally { await residency.close(); }
}

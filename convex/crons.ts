import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "retain production Heat frames",
  { hours: 1 },
  internal.productionHeatRetention.scheduledRetention,
  {},
);

crons.interval(
  "remove expired publication nonces",
  { hours: 1 },
  internal.providerReleaseCleanup.scheduledNonceCleanup,
  {},
);

export default crons;

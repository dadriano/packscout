import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "retain production Heat frames",
  { hours: 1 },
  internal.productionHeatRetention.scheduledRetention,
  {},
);

export default crons;

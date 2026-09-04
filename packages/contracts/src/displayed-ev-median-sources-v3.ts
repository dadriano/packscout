import { z } from "zod";

export const displayedEvMedianSourceSchema = z.enum([
  "packscout", "provider_reported", "mixed",
]);
const groupSourceSchema = z.object({
  key: z.string().min(1).max(100),
  source: displayedEvMedianSourceSchema.nullable(),
}).strict();
const groupSourcesSchema = z.array(groupSourceSchema).max(5).refine(
  (groups) => new Set(groups.map(({ key }) => key)).size === groups.length,
  { message: "displayed_ev_median_sources.duplicate_group" },
);

/** Response-envelope metadata; inner dashboard records keep their strict shape. */
export const displayedEvMedianSourcesV3Schema = z.object({
  overall: displayedEvMedianSourceSchema.nullable(),
  vendors: groupSourcesSchema,
  categories: groupSourcesSchema,
}).strict();

export type DisplayedEvMedianSource = z.infer<typeof displayedEvMedianSourceSchema>;
export type DisplayedEvMedianSourcesV3 = z.infer<typeof displayedEvMedianSourcesV3Schema>;

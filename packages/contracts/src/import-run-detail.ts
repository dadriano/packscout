import { z } from "zod";

/** Provider-local run identifiers are meaningful only with their provider. */
export const importRunDetailQuerySchema = z.object({
  providerId: z.uuid(),
}).strict();

export const importRunDetailLocationSchema = importRunDetailQuerySchema.extend({
  runId: z.uuid(),
}).strict();

export type ImportRunDetailLocation = z.infer<
  typeof importRunDetailLocationSchema
>;

export function importRunDetailPath(input: ImportRunDetailLocation): string {
  return `/runs/${encodeURIComponent(input.runId)}?providerId=${
    encodeURIComponent(input.providerId)
  }`;
}

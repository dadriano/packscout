import { z } from "zod";
import { packCatalogSha256Schema, packCatalogTextSchema, packCatalogUuidSchema } from "./pack-catalog-v1.ts";
import { packActivationIntentSchema } from "./pack-publication.ts";

/** Reconstruct transport bytes from this command plus its immutable local artifact. No credentials. */
export const providerPackPublicationOperationSchema = z.object({
  operationId: packCatalogUuidSchema,
  organizationId: packCatalogUuidSchema,
  intent: packActivationIntentSchema,
  idempotencyKey: packCatalogTextSchema(200),
  kind: z.enum(["start_snapshot", "stage_batch", "finalize_snapshot", "activate_head"]),
  batchIndex: z.number().int().min(0).max(31).nullable(),
  payloadSha256: packCatalogSha256Schema,
}).strict().refine(value => (value.kind === "stage_batch") === (value.batchIndex !== null), "pack.operation_batch_invalid");
export type ProviderPackPublicationOperation = z.infer<typeof providerPackPublicationOperationSchema>;

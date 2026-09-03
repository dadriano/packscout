import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { Router, type Response } from "express";
import { z } from "zod";
import {
  providerSourceDiagnosticFilterSchema,
  providerSourceDiagnosticHistorySchema,
  providerSourceOperationsDetailSchema,
  providerSourceOperationsOverviewSchema,
  type ProviderSourceDiagnosticFilter,
} from "@packscout/contracts";
import {
  ProviderSourceOperationsError,
  type AuthService,
  type ProviderSourceOperationsService,
} from "@packscout/services";
import type { SessionCookiePolicy } from "../auth/cookies.ts";
import {
  createRequireSession,
  getAuthenticatedActor,
} from "../auth/middleware.ts";

const uuidSchema = z.string().uuid();
const diagnosticQuerySchema = providerSourceDiagnosticFilterSchema.extend({
  cursor: z.string().trim().min(1).max(2_048).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
}).strict();
const cursorPayloadSchema = z.object({
  version: z.literal(1),
  organizationId: uuidSchema,
  providerId: uuidSchema,
  filter: z.object({
    severity: z.enum(["info", "warning", "critical"]).nullable(),
    phase: z.string().regex(/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u).nullable(),
    runId: uuidSchema.nullable(),
  }).strict(),
  occurredAt: z.iso.datetime({ offset: true }),
  eventId: uuidSchema,
}).strict();

export interface ProviderSourceOperationsRouterDependencies {
  readonly auth: Pick<AuthService, "resolveSession" | "requirePermission">;
  readonly cookiePolicy: SessionCookiePolicy;
  readonly operations: Pick<
    ProviderSourceOperationsService,
    "overview" | "detail" | "diagnostics"
  >;
  readonly diagnosticCursorKey: Uint8Array;
}

function cursorFilter(filter: ProviderSourceDiagnosticFilter) {
  return {
    severity: filter.severity ?? null,
    phase: filter.phase ?? null,
    runId: filter.runId ?? null,
  };
}

function invalid(response: Response, details: unknown): void {
  response.status(422).json({
    error: "Check the source operation request and try again.",
    code: "INVALID_SOURCE_OPERATION_REQUEST",
    details,
  });
}

export class InvalidProviderSourceDiagnosticCursorError extends Error {
  constructor() {
    super("provider_source_operations.invalid_diagnostic_cursor");
    this.name = "InvalidProviderSourceDiagnosticCursorError";
  }
}

export class ProviderSourceDiagnosticCursorCodec {
  readonly #key: Buffer;

  constructor(secret: Uint8Array) {
    if (secret.byteLength < 32) {
      throw new TypeError("Diagnostic cursor key must contain at least 32 bytes.");
    }
    this.#key = createHash("sha256")
      .update("packscout-provider-source-diagnostic-cursor-v1\0")
      .update(secret)
      .digest();
  }

  encode(input: Readonly<{
    organizationId: string;
    providerId: string;
    filter: ProviderSourceDiagnosticFilter;
    keyset: Readonly<{ occurredAt: Date; id: string }>;
  }>): string {
    const payload = cursorPayloadSchema.parse({
      version: 1,
      organizationId: input.organizationId,
      providerId: input.providerId,
      filter: cursorFilter(input.filter),
      occurredAt: input.keyset.occurredAt.toISOString(),
      eventId: input.keyset.id,
    });
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(payload), "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted])
      .toString("base64url");
  }

  decode(input: Readonly<{
    cursor: string;
    organizationId: string;
    providerId: string;
    filter: ProviderSourceDiagnosticFilter;
  }>): Readonly<{ occurredAt: Date; id: string }> {
    try {
      const encoded = Buffer.from(input.cursor, "base64url");
      if (encoded.byteLength < 29 || encoded.byteLength > 1_536) {
        throw new Error("invalid");
      }
      const nonce = encoded.subarray(0, 12);
      const authTag = encoded.subarray(12, 28);
      const encrypted = encoded.subarray(28);
      const decipher = createDecipheriv("aes-256-gcm", this.#key, nonce);
      decipher.setAuthTag(authTag);
      const payload = cursorPayloadSchema.parse(JSON.parse(Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
      ]).toString("utf8")));
      if (
        payload.organizationId !== input.organizationId ||
        payload.providerId !== input.providerId ||
        JSON.stringify(payload.filter) !== JSON.stringify(cursorFilter(input.filter))
      ) {
        throw new Error("scope mismatch");
      }
      return { occurredAt: new Date(payload.occurredAt), id: payload.eventId };
    } catch {
      throw new InvalidProviderSourceDiagnosticCursorError();
    }
  }
}

function failure(response: Response, error: unknown): void {
  if (error instanceof InvalidProviderSourceDiagnosticCursorError) {
    response.status(422).json({
      error: "The diagnostic history cursor is invalid for these filters.",
      code: "INVALID_DIAGNOSTIC_CURSOR",
    });
    return;
  }
  if (error instanceof ProviderSourceOperationsError) {
    const notFound = error.code === "SOURCE_OPERATIONS_NOT_FOUND";
    response.status(notFound ? 404 : 503).json({
      error: notFound
        ? "Provider source operations were not found."
        : "Provider source operations are temporarily unavailable.",
      code: error.code,
    });
    return;
  }
  if (typeof error === "object" && error !== null && "code" in error &&
      error.code === "RATE_LIMITED") {
    response.status(429).json({
      error: "Too many source operation requests. Try again later.",
      code: "RATE_LIMITED",
    });
    return;
  }
  response.status(503).json({
    error: "Provider source operations are temporarily unavailable.",
    code: "SOURCE_OPERATIONS_UNAVAILABLE",
  });
}

export function createProviderSourceOperationsRouter(
  dependencies: ProviderSourceOperationsRouterDependencies,
) {
  const router = Router();
  const read = createRequireSession(dependencies.auth, dependencies.cookiePolicy, {
    permission: "providers:view",
  });
  const cursors = new ProviderSourceDiagnosticCursorCodec(
    dependencies.diagnosticCursorKey,
  );

  router.get("/", read, async (_request, response) => {
    try {
      const actor = getAuthenticatedActor(response);
      response.status(200).json(providerSourceOperationsOverviewSchema.parse(
        await dependencies.operations.overview(actor.organizationId),
      ));
    } catch (error) {
      failure(response, error);
    }
  });

  router.get("/providers/:providerId", read, async (request, response) => {
    const providerId = uuidSchema.safeParse(request.params.providerId);
    if (!providerId.success) return invalid(response, providerId.error.issues);
    try {
      const actor = getAuthenticatedActor(response);
      response.status(200).json(providerSourceOperationsDetailSchema.parse(
        await dependencies.operations.detail(
          actor.organizationId,
          providerId.data,
        ),
      ));
    } catch (error) {
      failure(response, error);
    }
  });

  router.get(
    "/providers/:providerId/diagnostics",
    read,
    async (request, response) => {
      const providerId = uuidSchema.safeParse(request.params.providerId);
      const query = diagnosticQuerySchema.safeParse(request.query);
      if (!providerId.success || !query.success) {
        return invalid(response, {
          ...(!providerId.success ? { providerId: providerId.error.issues } : {}),
          ...(!query.success ? query.error.flatten().fieldErrors : {}),
        });
      }
      const { cursor, limit, ...filter } = query.data;
      try {
        const actor = getAuthenticatedActor(response);
        const before = cursor
          ? cursors.decode({
              cursor,
              organizationId: actor.organizationId,
              providerId: providerId.data,
              filter,
            })
          : undefined;
        const page = await dependencies.operations.diagnostics({
          organizationId: actor.organizationId,
          providerId: providerId.data,
          filter,
          limit,
          ...(before ? { before } : {}),
        });
        response.status(200).json(providerSourceDiagnosticHistorySchema.parse({
          ...page.response,
          nextCursor: page.next
            ? cursors.encode({
                organizationId: actor.organizationId,
                providerId: providerId.data,
                filter,
                keyset: page.next,
              })
            : null,
        }));
      } catch (error) {
        failure(response, error);
      }
    },
  );

  return router;
}

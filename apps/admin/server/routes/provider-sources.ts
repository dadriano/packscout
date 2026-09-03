import { Router, type RequestHandler, type Response } from "express";
import { z } from "zod";
import {
  confirmProviderSourceCursorResetRequestSchema,
  activateSourceConnectionRecoveryRequestSchema,
  createProviderSourceRequestSchema,
  createSourceConnectionProfileRequestSchema,
  createSourceConnectionRecoveryRevisionRequestSchema,
  previewProviderSourceCursorResetRequestSchema,
  providerSourceRevisionCommandSchema,
  requestSourceConnectionRecoveryTestSchema,
  reviseProviderSourceIntervalRequestSchema,
  reviseProviderSourceRecordsPerRequestRequestSchema,
  revokeSourceConnectionRevisionRequestSchema,
  rotateSourceConnectionCredentialRequestSchema,
  sourceConnectionRevisionCommandSchema,
  type ProviderSourceAdminCatalog,
  type ProviderSourceAdminAuditReceipt,
  type ProviderSourceAdminErrorCode,
} from "@packscout/contracts";
import {
  ProviderSourceActivationError,
  ProviderSourceAdminServiceError,
  type AuthService,
  type ProviderSourceAdminCommandContext,
  type ProviderSourceLifecycleService,
  type SourceConnectionConfigurationService,
} from "@packscout/services";
import type { SessionCookiePolicy } from "../auth/cookies.ts";
import {
  createRequireSession,
  getAuthenticatedActor,
} from "../auth/middleware.ts";

const uuid = z.string().uuid();
const connectionParams = z.object({ connectionProfileId: uuid }).strict();
const sourceParams = z.object({ providerId: uuid, sourceInstanceId: uuid }).strict();

export interface ProviderSourcesRouterDependencies {
  readonly auth: Pick<AuthService, "resolveSession" | "requirePermission">;
  readonly cookiePolicy: SessionCookiePolicy;
  readonly sameOrigin: RequestHandler;
  readonly actorKeyer: Readonly<{
    keyFor(input: Readonly<{
      organizationId: string;
      operatorId: string;
    }>): string;
  }>;
  readonly failureAudit: Readonly<{
    recordFailure(input: Readonly<{
      organizationId: string;
      actorKey: string;
      action: ProviderSourceAdminAuditReceipt["action"];
      subjectType: ProviderSourceAdminAuditReceipt["subjectType"];
      subjectId: string | null;
      revisionId: string | null;
      safeCode: ProviderSourceAdminErrorCode;
    }>): Promise<ProviderSourceAdminAuditReceipt>;
  }>;
  readonly catalog: Readonly<{
    getCatalog(context: ProviderSourceAdminCommandContext):
      Promise<ProviderSourceAdminCatalog>;
  }>;
  readonly connections: Pick<
    SourceConnectionConfigurationService,
    | "createProfile"
    | "rotateCredential"
    | "requestTest"
    | "activateRevision"
    | "revokeRevision"
    | "createRecoveryRevision"
    | "requestRecoveryTest"
    | "activateRecovery"
  >;
  readonly sources: Pick<
    ProviderSourceLifecycleService,
    | "createSource"
    | "requestTest"
    | "activatePaused"
    | "reviseInterval"
    | "reviseRecordsPerRequest"
    | "pause"
    | "resume"
    | "disable"
    | "previewCursorReset"
    | "resetCursor"
  >;
}

function context(
  dependencies: ProviderSourcesRouterDependencies,
  response: Response,
): ProviderSourceAdminCommandContext {
  const actor = getAuthenticatedActor(response);
  return {
    organizationId: actor.organizationId,
    actorKey: dependencies.actorKeyer.keyFor({
      organizationId: actor.organizationId,
      operatorId: actor.operatorId,
    }),
  };
}

function invalid(response: Response, details: unknown): void {
  response.status(422).json({
    error: "Check the source configuration and try again.",
    code: "INVALID_SOURCE_CONFIGURATION",
    details,
  });
}

interface ClassifiedServiceError {
  readonly status: 404 | 409 | 422 | 424 | 503;
  readonly message: string;
  readonly code: Exclude<
    ProviderSourceAdminErrorCode,
    "AUTH_REQUIRED" | "FORBIDDEN"
  >;
}

function classifyServiceError(error: unknown): ClassifiedServiceError {
  if (error instanceof ProviderSourceAdminServiceError) {
    return {
      status: error.status,
      message: "The source command could not be completed.",
      code: error.code,
    };
  }
  if (error instanceof ProviderSourceActivationError) {
    const dependency = error.code === "activation_candidate_not_found"
      ? "SOURCE_NOT_FOUND"
      : error.code === "activation_candidate_invalid"
        ? "SOURCE_TEST_REQUIRED"
        : "INVALID_SOURCE_CONFIGURATION";
    return {
      status: dependency === "SOURCE_NOT_FOUND" ? 404 : 409,
      message: "The source is not ready for activation.",
      code: dependency,
    };
  }
  if (typeof error === "object" && error !== null && "code" in error) {
    if (error.code === "CONFIG_REVISION_UNTESTED") {
      return {
        status: 409,
        message: "A current successful test is required.",
        code: "SOURCE_TEST_REQUIRED",
      };
    }
    if (["SOURCE_FENCED", "HEALTH_GENERATION_STALE"].includes(String(error.code))) {
      return {
        status: 409,
        message: "The source changed before the command completed.",
        code: "SOURCE_CONFLICT",
      };
    }
    if (["P2002", "SOURCE_IDENTITY_CONFLICT"].includes(String(error.code))) {
      return {
        status: 409,
        message: "A conflicting source configuration already exists.",
        code: "SOURCE_CONFLICT",
      };
    }
    if (["TENANT_SCOPE_VIOLATION", "NOT_FOUND"].includes(String(error.code))) {
      return {
        status: 404,
        message: "The source was not found.",
        code: "SOURCE_NOT_FOUND",
      };
    }
    if (error.code === "CONNECTION_BLOCKED") {
      return {
        status: 424,
        message: "The connection requires recovery.",
        code: "SOURCE_DEPENDENCY_REQUIRED",
      };
    }
  }
  return {
    status: 503,
    message: "Source administration is temporarily unavailable.",
    code: "SOURCE_UPSTREAM_UNAVAILABLE",
  };
}

function serviceError(
  response: Response,
  classified: ClassifiedServiceError,
  audit?: ProviderSourceAdminAuditReceipt,
): void {
  response.status(classified.status).json({
    error: classified.message,
    code: classified.code,
    ...(audit ? { audit } : {}),
  });
}

type Handler = (
  request: Parameters<RequestHandler>[0],
  response: Parameters<RequestHandler>[1],
) => Promise<unknown>;

function command(
  handler: Handler,
  options: Readonly<{
    created?: boolean;
    auditFailure?: (
      request: Parameters<RequestHandler>[0],
      response: Parameters<RequestHandler>[1],
      code: ClassifiedServiceError["code"],
    ) => Promise<ProviderSourceAdminAuditReceipt>;
  }> = {},
): RequestHandler {
  return async (request, response) => {
    try {
      const result = await handler(request, response);
      if (response.headersSent) return;
      response.status(options.created ? 201 : 200).json(result);
    } catch (error) {
      const classified = classifyServiceError(error);
      if (!options.auditFailure) return serviceError(response, classified);
      try {
        const audit = await options.auditFailure(
          request,
          response,
          classified.code,
        );
        serviceError(response, classified, audit);
      } catch {
        serviceError(response, classifyServiceError(undefined));
      }
    }
  };
}

function parsedParams(
  schema: typeof connectionParams | typeof sourceParams,
  request: Parameters<RequestHandler>[0],
  response: Parameters<RequestHandler>[1],
) {
  const parsed = schema.safeParse(request.params);
  if (!parsed.success) {
    invalid(response, parsed.error.flatten().fieldErrors);
    return null;
  }
  return parsed.data;
}

function parsedBody<T>(
  schema: z.ZodType<T>,
  request: Parameters<RequestHandler>[0],
  response: Parameters<RequestHandler>[1],
): T | null {
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    invalid(response, parsed.error.flatten().fieldErrors);
    return null;
  }
  return parsed.data;
}

export function createProviderSourcesRouter(
  dependencies: ProviderSourcesRouterDependencies,
) {
  const router = Router();
  const bodyRevision = (
    request: Parameters<RequestHandler>[0],
    keys: readonly string[],
  ): string | null => {
    if (typeof request.body !== "object" || request.body === null) return null;
    const body = request.body as Record<string, unknown>;
    for (const key of keys) {
      const parsed = uuid.safeParse(body[key]);
      if (parsed.success) return parsed.data;
    }
    return null;
  };
  const audited = (
    handler: Handler,
    target: Readonly<{
      action: ProviderSourceAdminAuditReceipt["action"];
      subjectType: ProviderSourceAdminAuditReceipt["subjectType"];
      subjectId(request: Parameters<RequestHandler>[0]): string | null;
      revisionId(request: Parameters<RequestHandler>[0]): string | null;
    }>,
    created = false,
  ): RequestHandler => command(handler, {
    created,
    auditFailure: async (request, response, safeCode) => {
      const actor = context(dependencies, response);
      return dependencies.failureAudit.recordFailure({
        ...actor,
        action: target.action,
        subjectType: target.subjectType,
        subjectId: target.subjectId(request),
        revisionId: target.revisionId(request),
        safeCode,
      });
    },
  });
  const connectionSubject = (request: Parameters<RequestHandler>[0]) => {
    const parsed = uuid.safeParse(request.params.connectionProfileId);
    return parsed.success ? parsed.data : null;
  };
  const sourceSubject = (request: Parameters<RequestHandler>[0]) => {
    const parsed = uuid.safeParse(request.params.sourceInstanceId);
    return parsed.success ? parsed.data : null;
  };
  const read = createRequireSession(dependencies.auth, dependencies.cookiePolicy, {
    permission: "providers:view",
  });
  const manage = createRequireSession(dependencies.auth, dependencies.cookiePolicy, {
    csrf: true,
    permission: "providers:manage",
  });
  const secrets = createRequireSession(dependencies.auth, dependencies.cookiePolicy, {
    csrf: true,
    permission: "provider_secrets:manage",
  });
  const operate = createRequireSession(dependencies.auth, dependencies.cookiePolicy, {
    csrf: true,
    permission: "imports:start",
  });

  router.get("/", read, command(async (_request, response) => ({
    catalog: await dependencies.catalog.getCatalog(context(dependencies, response)),
  })));

  router.post(
    "/connections",
    dependencies.sameOrigin,
    secrets,
    audited(async (request, response) => {
      const body = createSourceConnectionProfileRequestSchema.safeParse(request.body);
      if (!body.success) return invalid(response, body.error.flatten().fieldErrors);
      return dependencies.connections.createProfile(
        context(dependencies, response),
        body.data,
      );
    }, {
      action: "connection_profile_created",
      subjectType: "source_connection_profile",
      subjectId: () => null,
      revisionId: () => null,
    }, true),
  );

  const connectionCommand = (
    action:
      | "rotate"
      | "test"
      | "activate"
      | "revoke"
      | "recovery-revision"
      | "recovery-test"
      | "recovery-activate",
  ) => audited(async (request, response) => {
    const params = parsedParams(connectionParams, request, response);
    if (!params || !("connectionProfileId" in params)) return;
    const actor = context(dependencies, response);
    if (action === "rotate") {
      const body = parsedBody(
        rotateSourceConnectionCredentialRequestSchema,
        request,
        response,
      );
      if (!body) return;
      return dependencies.connections.rotateCredential(
        actor,
        params.connectionProfileId,
        body,
      );
    }
    if (action === "test") {
      const body = parsedBody(
        sourceConnectionRevisionCommandSchema,
        request,
        response,
      );
      if (!body) return;
      return dependencies.connections.requestTest(
        actor,
        params.connectionProfileId,
        body,
      );
    }
    if (action === "recovery-revision") {
      const body = parsedBody(
        createSourceConnectionRecoveryRevisionRequestSchema,
        request,
        response,
      );
      if (!body) return;
      return dependencies.connections.createRecoveryRevision(
        actor,
        params.connectionProfileId,
        body,
      );
    }
    if (action === "recovery-test") {
      const body = parsedBody(
        requestSourceConnectionRecoveryTestSchema,
        request,
        response,
      );
      if (!body) return;
      return dependencies.connections.requestRecoveryTest(
        actor,
        params.connectionProfileId,
        body,
      );
    }
    if (action === "recovery-activate") {
      const body = parsedBody(
        activateSourceConnectionRecoveryRequestSchema,
        request,
        response,
      );
      if (!body) return;
      return dependencies.connections.activateRecovery(
        actor,
        params.connectionProfileId,
        body,
      );
    }
    if (action === "activate") {
      const body = parsedBody(
        sourceConnectionRevisionCommandSchema,
        request,
        response,
      );
      if (!body) return;
      return {
        audit: await dependencies.connections.activateRevision(
          actor,
          params.connectionProfileId,
          body,
        ),
      };
    }
    const body = parsedBody(
      revokeSourceConnectionRevisionRequestSchema,
      request,
      response,
    );
    if (!body) return;
    return {
      audit: await dependencies.connections.revokeRevision(
        actor,
        params.connectionProfileId,
        body,
      ),
    };
  }, {
    action: action === "rotate"
      ? "connection_credential_rotated"
      : action === "test"
        ? "connection_test_requested"
        : action === "activate"
          ? "connection_revision_activated"
          : action === "revoke"
            ? "connection_revision_revoked"
            : action === "recovery-revision"
              ? "connection_recovery_revision_created"
              : action === "recovery-test"
                ? "connection_recovery_test_requested"
                : "connection_recovery_activated",
    subjectType: "source_connection_profile",
    subjectId: connectionSubject,
    revisionId: (request) => bodyRevision(
      request,
      ["expectedRevisionId", "expectedBlockedRevisionId", "blockedRevisionId"],
    ),
  });
  for (const [action, secret] of [
    ["rotate", true],
    ["test", false],
    ["activate", false],
    ["revoke", true],
    ["recovery-revision", true],
    ["recovery-test", false],
    ["recovery-activate", false],
  ] as const) {
    router.post(
      `/connections/:connectionProfileId/${action}`,
      dependencies.sameOrigin,
      secret ? secrets : manage,
      connectionCommand(action),
    );
  }

  router.post(
    "/sources",
    dependencies.sameOrigin,
    manage,
    audited(async (request, response) => {
      const body = createProviderSourceRequestSchema.safeParse(request.body);
      if (!body.success) return invalid(response, body.error.flatten().fieldErrors);
      return dependencies.sources.createSource(
        context(dependencies, response),
        body.data,
      );
    }, {
      action: "source_created",
      subjectType: "provider_source",
      subjectId: () => null,
      revisionId: () => null,
    }, true),
  );
  const sourceCommand = (
    action:
      | "test"
      | "activate"
      | "interval"
      | "records-per-request"
      | "pause"
      | "resume"
      | "disable"
      | "cursor-reset-preview"
      | "cursor-reset",
  ) => {
    const handler = async (
      request: Parameters<RequestHandler>[0],
      response: Parameters<RequestHandler>[1],
    ) => {
    const params = parsedParams(sourceParams, request, response);
    if (!params || !("sourceInstanceId" in params)) return;
    const schema = action === "interval"
      ? reviseProviderSourceIntervalRequestSchema
      : action === "records-per-request"
        ? reviseProviderSourceRecordsPerRequestRequestSchema
      : action === "cursor-reset-preview"
        ? previewProviderSourceCursorResetRequestSchema
        : action === "cursor-reset"
          ? confirmProviderSourceCursorResetRequestSchema
          : providerSourceRevisionCommandSchema;
    const body = parsedBody(schema, request, response);
    if (!body) return;
    const args = [
      context(dependencies, response),
      params.providerId,
      params.sourceInstanceId,
      body,
    ] as const;
    switch (action) {
      case "test": return dependencies.sources.requestTest(...args);
      case "activate": return {
        audit: await dependencies.sources.activatePaused(...args),
      };
      case "interval": return dependencies.sources.reviseInterval(...args);
      case "records-per-request":
        return dependencies.sources.reviseRecordsPerRequest(...args);
      case "pause": return dependencies.sources.pause(...args);
      case "resume": return {
        state: "resumed" as const,
        audit: await dependencies.sources.resume(...args),
      };
      case "disable": return { audit: await dependencies.sources.disable(...args) };
      case "cursor-reset-preview":
        return { preview: await dependencies.sources.previewCursorReset(...args) };
      case "cursor-reset": return dependencies.sources.resetCursor(...args);
    }
    };
    if (action === "cursor-reset-preview") return command(handler);
    return audited(handler, {
      action: action === "test"
        ? "source_test_requested"
        : action === "activate"
          ? "source_activated_paused"
          : action === "interval"
            ? "source_interval_revised"
            : action === "records-per-request"
              ? "source_records_per_request_revised"
            : action === "pause"
              ? "source_pause_requested"
              : action === "resume"
                ? "source_resumed"
                : action === "disable"
                  ? "source_disabled"
                  : "source_cursor_reset",
      subjectType: "provider_source",
      subjectId: sourceSubject,
      revisionId: (request) => bodyRevision(request, ["expectedSourceRevisionId"]),
    });
  };
  for (const action of [
    "test",
    "activate",
    "interval",
    "records-per-request",
    "pause",
    "resume",
    "disable",
    "cursor-reset-preview",
    "cursor-reset",
  ] as const) {
    router.post(
      `/providers/:providerId/sources/:sourceInstanceId/${action}`,
      dependencies.sameOrigin,
      action === "pause" || action === "resume" ? operate : manage,
      sourceCommand(action),
    );
  }

  return router;
}

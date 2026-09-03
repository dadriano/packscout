import { randomUUID } from "node:crypto";
import express, {
  type ErrorRequestHandler,
  type RequestHandler,
} from "express";
import type { AuthService } from "@packscout/services";
import type { SessionCookiePolicy } from "./auth/cookies.ts";
import { createHealthRouter } from "./routes/health.ts";
import { createAuthRouter } from "./routes/auth.ts";
import {
  createOperatorsRouter,
  type OperatorInvitationRuntime,
} from "./routes/operators.ts";
import type { OperatorAccountCreatedNotifier } from "./operator-account-created-notice.ts";
import { createOperatorInvitationsRouter } from "./routes/operator-invitations.ts";
import { createProvidersRouter, type ProvidersRouterDependencies } from "./routes/providers.ts";
import {
  createImportOperationsRouter,
  type ImportOperationsRouterDependencies,
} from "./routes/import-operations.ts";
import {
  createOperationalAlertsRouter,
  type OperationalAlertsRouterDependencies,
} from "./routes/operational-alerts.ts";
import {
  createOperationalHealthRouter,
  type OperationalHealthRouterDependencies,
} from "./routes/operational-health.ts";
import {
  createProviderSourcesRouter,
  type ProviderSourcesRouterDependencies,
} from "./routes/provider-sources.ts";
import {
  createProviderSourceOperationsRouter,
  type ProviderSourceOperationsRouterDependencies,
} from "./routes/provider-source-operations.ts";
import {
  createBackgroundWorkRouter,
  type BackgroundWorkRouterDependencies,
} from "./routes/background-work.ts";
import {
  createProductUsersRouter,
  type ProductUsersRouterDependencies,
} from "./routes/product-users.ts";
import {
  createBetaAllowlistRouter,
  type BetaAllowlistRouterDependencies,
} from "./routes/beta-allowlist.ts";
import {
  createDataInspectionRouter,
  type DataInspectionRouterDependencies,
} from "./routes/data-inspection.ts";
import {
  createWorkerFleetRouter,
  type WorkerFleetRouterDependencies,
} from "./routes/worker-fleet.ts";
import {
  createMessagesRouter,
  type MessagesRouterDependencies,
} from "./routes/messages.ts";
import {
  createPasswordResetRouter,
  type PasswordResetRouterDependencies,
} from "./routes/password-reset.ts";

export interface AdminAuthHttpDependencies {
  service: AuthService;
  cookiePolicy: SessionCookiePolicy;
  sameOrigin: RequestHandler;
}

export interface AdminAppDependencies {
  trustedProxies?: readonly string[];
  /** Adapter-owned hop count for platforms that overwrite forwarded headers. */
  trustedProxyHops?: number;
  auth?: AdminAuthHttpDependencies;
  providers?: Omit<
    ProvidersRouterDependencies,
    "auth" | "cookiePolicy" | "sameOrigin"
  >;
  importOperations?: Omit<
    ImportOperationsRouterDependencies,
    "auth" | "cookiePolicy" | "sameOrigin"
  >;
  operationalAlerts?: Omit<
    OperationalAlertsRouterDependencies,
    "auth" | "cookiePolicy" | "sameOrigin"
  >;
  operationalHealth?: Omit<
    OperationalHealthRouterDependencies,
    "auth" | "cookiePolicy"
  >;
  providerSources?: Omit<
    ProviderSourcesRouterDependencies,
    "auth" | "cookiePolicy" | "sameOrigin"
  >;
  providerSourceOperations?: Omit<
    ProviderSourceOperationsRouterDependencies,
    "auth" | "cookiePolicy"
  >;
  backgroundWork?: Omit<
    BackgroundWorkRouterDependencies,
    "auth" | "cookiePolicy" | "sameOrigin"
  >;
  productUsers?: Omit<
    ProductUsersRouterDependencies,
    "auth" | "cookiePolicy" | "sameOrigin"
  >;
  betaAllowlist?: Omit<
    BetaAllowlistRouterDependencies,
    "auth" | "cookiePolicy" | "sameOrigin"
  >;
  workerFleet?: Omit<WorkerFleetRouterDependencies, "auth" | "cookiePolicy">;
  canonical?: DataInspectionRouterDependencies["canonical"];
  published?: DataInspectionRouterDependencies["published"];
  parity?: DataInspectionRouterDependencies["parity"];
  /**
   * Deployments without the source-connection keys run with source
   * administration deliberately unconfigured. The provider-source routes are
   * then mounted with a stable "unconfigured" answer so clients parse an
   * explicit capability state instead of a generic 404.
   */
  sourceAdministrationUnconfigured?: boolean;
  messages?: Omit<
    MessagesRouterDependencies,
    "auth" | "cookiePolicy" | "sameOrigin"
  >;
  passwordReset?: Omit<PasswordResetRouterDependencies, "sameOrigin">;
  operatorInvitations?: OperatorInvitationRuntime;
  operatorAccountCreatedNotifier?: OperatorAccountCreatedNotifier;
}

const apiNotFound: RequestHandler = (_request, response) => {
  response.status(404).json({
    error: "Admin API route not found.",
    code: "API_ROUTE_NOT_FOUND",
  });
};

const sourceAdministrationUnconfigured: RequestHandler = (
  _request,
  response,
) => {
  response.status(503).json({
    error: "Source administration is not configured on this deployment.",
    code: "SOURCE_ADMIN_UNCONFIGURED",
  });
};

function isMalformedJson(error: unknown): boolean {
  return (
    error instanceof SyntaxError &&
    typeof error === "object" &&
    error !== null &&
    "body" in error
  );
}

const handleApiError: ErrorRequestHandler = (
  error: unknown,
  _request,
  response,
  _next,
) => {
  void _next;

  if (isMalformedJson(error)) {
    response.status(400).json({
      error: "Request body must contain valid JSON.",
      code: "INVALID_JSON",
    });
    return;
  }

  response.status(500).json({
    error: "The admin service could not complete the request.",
    code: "INTERNAL_ERROR",
  });
};

export function createAdminApp(dependencies: AdminAppDependencies = {}) {
  const app = express();

  app.disable("x-powered-by");
  if (dependencies.trustedProxyHops !== undefined) {
    app.set("trust proxy", dependencies.trustedProxyHops);
  } else if (dependencies.trustedProxies?.length) {
    app.set("trust proxy", [...dependencies.trustedProxies]);
  }
  app.use((request, response, next) => {
    const requestId = request.get("x-request-id")?.slice(0, 128) || randomUUID();
    response.setHeader("X-Request-Id", requestId);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "same-origin");
    response.setHeader("X-Frame-Options", "DENY");
    next();
  });
  app.use(express.json({ limit: "1mb" }));

  app.use("/api/health", createHealthRouter());
  if (dependencies.auth) {
    const { service, cookiePolicy, sameOrigin } = dependencies.auth;
    app.use(
      "/api/auth",
      createAuthRouter({ service, cookiePolicy, sameOrigin }),
    );
    app.use(
      "/api/operators",
      createOperatorsRouter({
        service,
        cookiePolicy,
        sameOrigin,
        invitations: dependencies.operatorInvitations,
        accountCreatedNotifier: dependencies.operatorAccountCreatedNotifier,
      }),
    );
    if (dependencies.providers) {
      app.use(
        "/api/data-providers",
        createProvidersRouter({
          ...dependencies.providers,
          auth: service,
          cookiePolicy,
          sameOrigin,
        }),
      );
    }
    if (dependencies.importOperations) {
      app.use(
        "/api",
        createImportOperationsRouter({
          ...dependencies.importOperations,
          auth: service,
          cookiePolicy,
          sameOrigin,
        }),
      );
    }
    if (dependencies.operationalAlerts) {
      app.use(
        "/api/operational-alerts",
        createOperationalAlertsRouter({
          ...dependencies.operationalAlerts,
          auth: service,
          cookiePolicy,
          sameOrigin,
        }),
      );
    }
    if (dependencies.backgroundWork) {
      app.use(
        "/api/background-work",
        createBackgroundWorkRouter({
          ...dependencies.backgroundWork,
          auth: service,
          cookiePolicy,
          sameOrigin,
        }),
      );
    }
    if (dependencies.workerFleet) {
      app.use(
        "/api/worker-fleet",
        createWorkerFleetRouter({
          ...dependencies.workerFleet,
          auth: service,
          cookiePolicy,
        }),
      );
    }
    // Read-only and unconditional: the surface needs no injected dependency to
    // report what is in comparison scope, and mounting it always means a caller
    // without the permission is refused rather than routed to the API 404.
    app.use(
      "/api/data-inspection",
      createDataInspectionRouter({
        auth: service,
        cookiePolicy,
        canonical: dependencies.canonical,
        published: dependencies.published,
        parity: dependencies.parity,
      }),
    );
    if (dependencies.productUsers) {
      app.use(
        "/api/product-users",
        createProductUsersRouter({
          ...dependencies.productUsers,
          auth: service,
          cookiePolicy,
          sameOrigin,
        }),
      );
    }
    if (dependencies.betaAllowlist) {
      app.use(
        "/api/beta-allowlist",
        createBetaAllowlistRouter({
          ...dependencies.betaAllowlist,
          auth: service,
          cookiePolicy,
          sameOrigin,
        }),
      );
    }
    if (dependencies.operationalHealth) {
      app.use(
        "/api/operational-health",
        createOperationalHealthRouter({
          ...dependencies.operationalHealth,
          auth: service,
          cookiePolicy,
        }),
      );
    }
    if (dependencies.providerSources) {
      app.use(
        "/api/provider-sources",
        createProviderSourcesRouter({
          ...dependencies.providerSources,
          auth: service,
          cookiePolicy,
          sameOrigin,
        }),
      );
    }
    if (dependencies.messages) {
      app.use(
        "/api/messages",
        createMessagesRouter({
          ...dependencies.messages,
          auth: service,
          cookiePolicy,
          sameOrigin,
        }),
      );
    }
    if (dependencies.providerSourceOperations) {
      app.use(
        "/api/provider-source-operations",
        createProviderSourceOperationsRouter({
          ...dependencies.providerSourceOperations,
          auth: service,
          cookiePolicy,
        }),
      );
    }
    if (dependencies.operatorInvitations) {
      // Mounted beside the reset routes and for the same reason: an
      // unauthenticated route INTO authentication, guarded by the same
      // trusted-origin discipline.
      app.use(
        "/api/auth/invitations",
        createOperatorInvitationsRouter({
          flow: dependencies.operatorInvitations.flow,
          sameOrigin,
        }),
      );
    }
    if (dependencies.passwordReset) {
      // Mounted after the session routes: an unauthenticated route INTO
      // authentication, guarded by the same trusted-origin discipline.
      app.use(
        "/api/auth/password-reset",
        createPasswordResetRouter({
          ...dependencies.passwordReset,
          sameOrigin,
        }),
      );
    }
  }
  if (dependencies.sourceAdministrationUnconfigured) {
    app.use("/api/provider-sources", sourceAdministrationUnconfigured);
    app.use(
      "/api/provider-source-operations",
      sourceAdministrationUnconfigured,
    );
  }
  app.use("/api", apiNotFound);
  app.use(handleApiError);

  return app;
}

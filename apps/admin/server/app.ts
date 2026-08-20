import { randomUUID } from "node:crypto";
import express, {
  type ErrorRequestHandler,
  type RequestHandler,
} from "express";
import type { AuthService } from "@packscout/services";
import type { SessionCookiePolicy } from "./auth/cookies.ts";
import { createHealthRouter } from "./routes/health.ts";
import { createAuthRouter } from "./routes/auth.ts";
import { createOperatorsRouter } from "./routes/operators.ts";
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
  createBackgroundWorkRouter,
  type BackgroundWorkRouterDependencies,
} from "./routes/background-work.ts";
import {
  createProductUsersRouter,
  type ProductUsersRouterDependencies,
} from "./routes/product-users.ts";

export interface AdminAuthHttpDependencies {
  service: AuthService;
  cookiePolicy: SessionCookiePolicy;
  sameOrigin: RequestHandler;
}

export interface AdminAppDependencies {
  trustedProxies?: readonly string[];
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
  backgroundWork?: Omit<
    BackgroundWorkRouterDependencies,
    "auth" | "cookiePolicy" | "sameOrigin"
  >;
  productUsers?: Omit<
    ProductUsersRouterDependencies,
    "auth" | "cookiePolicy" | "sameOrigin"
  >;
}

const apiNotFound: RequestHandler = (_request, response) => {
  response.status(404).json({
    error: "Admin API route not found.",
    code: "API_ROUTE_NOT_FOUND",
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
  if (dependencies.trustedProxies?.length) {
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
      createOperatorsRouter({ service, cookiePolicy, sameOrigin }),
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
  }
  app.use("/api", apiNotFound);
  app.use(handleApiError);

  return app;
}

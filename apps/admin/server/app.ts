import express, {
  type ErrorRequestHandler,
  type RequestHandler,
} from "express";
import { createHealthRouter } from "./routes/health.ts";

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

export function createAdminApp() {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.use("/api/health", createHealthRouter());
  app.use("/api", apiNotFound);
  app.use(handleApiError);

  return app;
}

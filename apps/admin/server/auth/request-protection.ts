import type { RequestHandler } from "express";

export function createSameOriginGuard(allowedOrigins: readonly string[]): RequestHandler {
  const normalizedOrigins = new Set(
    allowedOrigins.map((origin) => new URL(origin).origin),
  );
  if (normalizedOrigins.size === 0) {
    throw new Error("At least one trusted admin origin is required.");
  }

  return (request, response, next) => {
    const origin = request.get("origin");
    if (!origin) {
      response.status(403).json({
        error: "The request could not be verified.",
        code: "FORBIDDEN",
      });
      return;
    }
    try {
      if (!normalizedOrigins.has(new URL(origin).origin)) {
        response.status(403).json({
          error: "The request could not be verified.",
          code: "FORBIDDEN",
        });
        return;
      }
    } catch {
      response.status(403).json({
        error: "The request could not be verified.",
        code: "FORBIDDEN",
      });
      return;
    }
    next();
  };
}

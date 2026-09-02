import { Router } from "express";
import { z } from "zod";
import {
  ProviderPromotionBootstrapError,
  type ProviderPromotionBootstrapService,
} from "../promotion-job-provider-bootstrap.ts";

const requestSchema = z.object({
  providerId: z.string().regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  ),
}).strict();

export interface ProviderPromotionBootstrapRouterDependencies {
  readonly bootstrap: Pick<ProviderPromotionBootstrapService, "load">;
}

/** Internal machine route; it does not accept browser sessions or routing. */
export function createProviderPromotionBootstrapRouter(
  dependencies: ProviderPromotionBootstrapRouterDependencies,
) {
  const router = Router();
  router.post("/", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const parsed = requestSchema.safeParse(request.body);
    const authorization = request.get("authorization");
    const bearer = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : null;
    if (!parsed.success || bearer === null) {
      response.status(401).json({
        error: "The provider promotion bootstrap request was rejected.",
        code: "PROVIDER_PROMOTION_BOOTSTRAP_UNAUTHORIZED",
      });
      return;
    }
    try {
      response.status(200).json(await dependencies.bootstrap.load({
        providerId: parsed.data.providerId,
        bearerTokenBase64: bearer,
      }));
    } catch (error) {
      const code = error instanceof ProviderPromotionBootstrapError
        ? error.code
        : "PROVIDER_PROMOTION_BOOTSTRAP_UNAVAILABLE";
      response.status(
        code === "PROVIDER_PROMOTION_BOOTSTRAP_UNAUTHORIZED" ? 401 : 503,
      ).json({
        error: code === "PROVIDER_PROMOTION_BOOTSTRAP_UNAUTHORIZED"
          ? "The provider promotion bootstrap request was rejected."
          : "Provider promotion bootstrap is temporarily unavailable.",
        code,
      });
    }
  });
  return router;
}

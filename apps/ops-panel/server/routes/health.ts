import { Router } from "express";

export const OPS_PANEL_SERVICE_NAME = "packscout-ops-panel";

/**
 * Liveness only. It carries no configuration, no paths, and no secrets: the
 * panel answers "I am running" and nothing else.
 */
export function createHealthRouter(): Router {
  const router = Router();
  router.get("/", (_request, response) => {
    response.json({ ok: true, service: OPS_PANEL_SERVICE_NAME, scope: "local" });
  });
  return router;
}

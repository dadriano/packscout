import { Router } from "express";

export function createHealthRouter() {
  const router = Router();

  router.get("/", (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json({
      ok: true,
      service: "packscout-admin",
    });
  });

  return router;
}

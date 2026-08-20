import { Router } from "express";
import { AUDIT_TRAIL_LIMIT, type AuditTrail } from "../core/audit-trail.ts";

/** How many recent privileged attempts the panel view requests by default. */
export const DEFAULT_ACTIVITY_PAGE_SIZE = 50;

/**
 * The panel's view of its own privileged activity. Read-only, and bounded by
 * the trail itself, so no caller-supplied value can widen it.
 */
export function createActivityRouter({ audit }: { audit: AuditTrail }): Router {
  const router = Router();

  router.get("/", (request, response) => {
    const requested = Number(request.query.limit);
    const limit =
      Number.isInteger(requested) && requested > 0
        ? Math.min(requested, AUDIT_TRAIL_LIMIT)
        : DEFAULT_ACTIVITY_PAGE_SIZE;
    response.json({
      limit,
      total: audit.size(),
      capacity: AUDIT_TRAIL_LIMIT,
      entries: audit.list({ limit }),
    });
  });

  return router;
}

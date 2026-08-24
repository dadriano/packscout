import { Router } from "express";
import { comparisonScope } from "@packscout/contracts";
import type { AuthService } from "@packscout/services";
import type { SessionCookiePolicy } from "../auth/cookies.ts";
import { createRequireSession } from "../auth/middleware.ts";

/**
 * The admin's read-only data-inspection surface.
 *
 * Every route here authenticates first and then requires `data_inspection:view`,
 * a permission held separately from provider configuration access so it can be
 * withdrawn on its own. Nothing on this router mutates anything: the surfaces it
 * backs read canonical records, read their published counterparts, and compare
 * the two. Remediation stays with the provider, import-run, and background-work
 * routers that already own it.
 */

export interface DataInspectionRouterDependencies {
  readonly auth: Pick<AuthService, "resolveSession" | "requirePermission">;
  readonly cookiePolicy: SessionCookiePolicy;
}

/** The permission every data-inspection route requires. */
export const DATA_INSPECTION_PERMISSION = "data_inspection:view" as const;

export function createDataInspectionRouter(
  dependencies: DataInspectionRouterDependencies,
) {
  const router = Router();
  const read = createRequireSession(
    dependencies.auth,
    dependencies.cookiePolicy,
    { permission: DATA_INSPECTION_PERMISSION },
  );

  /**
   * Which canonical kinds have a published counterpart and which are
   * pipeline-only. Served from the shared contract rather than restated per
   * surface, so the published browser and the comparison view cannot drift into
   * disagreeing about what "missing" means.
   */
  router.get("/scope", read, (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.status(200).json(comparisonScope());
  });

  return router;
}

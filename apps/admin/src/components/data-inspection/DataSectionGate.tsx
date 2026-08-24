import type { ReactNode } from "react";
import { AuthRestrictedState } from "../auth/AuthRestrictedState";
import { useSession } from "../../providers/session";

/**
 * The Data section's client-side permission gate.
 *
 * The server is the real gate — every data-inspection route refuses a caller
 * without the permission. This exists so a deep link lands on the admin's
 * standard restricted treatment instead of a page that renders its chrome and
 * then fills with permission errors.
 */

const DATA_INSPECTION_DESCRIPTION =
  "Your operator account is active, but it does not include permission to inspect pipeline data. You can continue using the operational tools assigned to your role.";

export function useCanInspectData(): boolean {
  const { status } = useSession();
  return (
    status.phase === "authenticated" &&
    status.session.permissions.includes("data_inspection:view")
  );
}

export function DataSectionGate({ children }: { children: ReactNode }) {
  const canInspect = useCanInspectData();
  if (!canInspect) {
    return <AuthRestrictedState description={DATA_INSPECTION_DESCRIPTION} />;
  }
  return <>{children}</>;
}

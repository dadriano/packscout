import { Navigate } from "react-router-dom";

/**
 * Historical bookmarks must not reopen the retired configuration-revision
 * writer. Provider Sources is the sole administration surface after cutover.
 */
export function ProviderFormPage() {
  return <Navigate to="/source-configuration" replace />;
}

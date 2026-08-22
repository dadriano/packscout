import {
  Navigate,
  Outlet,
  Route,
  useLocation,
  useParams,
} from "react-router-dom";
import * as React from "react";
import { AdminLayout } from "./layouts/AdminLayout";
import { BackgroundWorkPage } from "./pages/BackgroundWorkPage";
import { LoginPage } from "./pages/LoginPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { OperatorsPage } from "./pages/OperatorsPage";
import { OverviewPage } from "./pages/OverviewPage";
import { ProductUserDetailPage } from "./pages/ProductUserDetailPage";
import { ProductUsersPage } from "./pages/ProductUsersPage";
import { ProviderDetailPage } from "./pages/ProviderDetailPage";
import { ProviderFormPage } from "./pages/ProviderFormPage";
import { ProvidersPage } from "./pages/ProvidersPage";
import { OperationsPage } from "./pages/OperationsPage";
import { QuarantineDetailPage } from "./pages/QuarantineDetailPage";
import { QuarantinePage } from "./pages/QuarantinePage";
import { RunDetailPage } from "./pages/RunDetailPage";
import { RunsPage } from "./pages/RunsPage";
import { AlertDetailPage } from "./pages/AlertDetailPage";
import { AlertsPage } from "./pages/AlertsPage";
import { SourceConfigurationPage } from "./pages/SourceConfigurationPage";
import { WorkerFleetPage } from "./pages/WorkerFleetPage";
import { useSession } from "./providers/session";

function SessionLoading() {
  return (
    <main className="admin-route-state" aria-busy="true" aria-live="polite">
      <div className="admin-route-card">
        <span className="admin-kicker">PackScout operations</span>
        <h1>Checking your access…</h1>
        <p>Opening the secure operations workspace.</p>
      </div>
    </main>
  );
}

function LoginRoute() {
  const { status } = useSession();
  if (status.phase === "loading") return <SessionLoading />;
  if (status.phase === "authenticated") return <Navigate to="/" replace />;
  return <LoginPage />;
}

function ProtectedRoute() {
  const { status, retry } = useSession();
  const location = useLocation();

  if (status.phase === "loading") return <SessionLoading />;
  if (status.phase === "unavailable") {
    return (
      <main className="admin-route-state" role="alert">
        <div className="admin-route-card">
          <span className="admin-kicker">PackScout operations</span>
          <h1>The admin service is unavailable.</h1>
          <p>
            Your account has not been changed. Try the secure connection again.
          </p>
          <button
            type="button"
            className="admin-button admin-button-secondary"
            onClick={retry}
          >
            Try again
          </button>
        </div>
      </main>
    );
  }
  if (status.phase === "unauthenticated") {
    const returnTo = `${location.pathname}${location.search}${location.hash}`;
    const reason = status.reason === "expired" ? "&reason=session_expired" : "";
    return (
      <Navigate
        to={`/login?returnTo=${encodeURIComponent(returnTo)}${reason}`}
        replace
      />
    );
  }
  return <Outlet />;
}

function ProviderDetailRoute() {
  const { providerId = "" } = useParams();
  return <ProviderDetailPage key={providerId} />;
}

export const appRoutes = (
  <React.Fragment>
    <Route path="/login" element={<LoginRoute />} />
    <Route element={<ProtectedRoute />}>
      <Route path="/" element={<AdminLayout />}>
        <Route index element={<OverviewPage />} />
        <Route path="operators" element={<OperatorsPage />} />
        <Route path="users" element={<ProductUsersPage />} />
        {/* An opaque handle, never the person's subject key: this path is
            written into history, access logs, and the sign-in returnTo. */}
        <Route path="users/:handle" element={<ProductUserDetailPage />} />
        <Route path="providers" element={<ProvidersPage />} />
        <Route path="providers/new" element={<ProviderFormPage />} />
        <Route path="providers/:providerId" element={<ProviderDetailRoute />} />
        <Route path="providers/:providerId/edit" element={<ProviderFormPage />} />
        <Route path="source-configuration" element={<SourceConfigurationPage />} />
        <Route path="operations" element={<OperationsPage />} />
        <Route path="runs" element={<RunsPage />} />
        <Route path="runs/:runId" element={<RunDetailPage />} />
        <Route path="background-work" element={<BackgroundWorkPage />} />
        <Route path="workers" element={<WorkerFleetPage />} />
        <Route path="quarantine" element={<QuarantinePage />} />
        <Route path="quarantine/:quarantineId" element={<QuarantineDetailPage />} />
        <Route path="alerts" element={<AlertsPage />} />
        <Route path="alerts/:alertId" element={<AlertDetailPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Route>
  </React.Fragment>
);

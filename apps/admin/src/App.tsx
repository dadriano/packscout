import {
  Navigate,
  Outlet,
  Route,
  useLocation,
} from "react-router-dom";
import * as React from "react";
import { AdminLayout } from "./layouts/AdminLayout";
import { BackgroundWorkPage } from "./pages/BackgroundWorkPage";
import { BetaAllowlistPage } from "./pages/BetaAllowlistPage";
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
import { WorkerFleetPage } from "./pages/WorkerFleetPage";
import { useSession } from "./providers/session";
import { MessageDetailPage } from "./pages/MessageDetailPage";
import { MessagesPage } from "./pages/MessagesPage";
import { ForgotPasswordPage } from "./pages/ForgotPasswordPage";
import { ResetPasswordPage } from "./pages/ResetPasswordPage";
import { AcceptInvitationPage } from "./pages/AcceptInvitationPage";

function SessionLoading() {
  return (
    <main className="admin-session-gate" aria-busy="true" aria-live="polite">
      <span className="admin-eyebrow">PackScout operations</span>
      <h1>Checking your access…</h1>
      <p>Opening the secure operations workspace.</p>
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
      <main className="admin-session-gate" role="alert">
        <span className="admin-eyebrow">PackScout operations</span>
        <h1>The admin service is unavailable.</h1>
        <p>Your account has not been changed. Try the secure connection again.</p>
        <button
          type="button"
          className="admin-button admin-button--secondary"
          onClick={retry}
        >
          Try again
        </button>
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
        <Route path="allowlist" element={<BetaAllowlistPage />} />
        <Route path="providers" element={<ProvidersPage />} />
        <Route path="providers/new" element={<ProviderFormPage />} />
        <Route path="providers/:providerId" element={<ProviderDetailPage />} />
        <Route path="providers/:providerId/edit" element={<ProviderFormPage />} />
        <Route path="operations" element={<OperationsPage />} />
        <Route path="runs" element={<RunsPage />} />
        <Route path="runs/:runId" element={<RunDetailPage />} />
        <Route path="background-work" element={<BackgroundWorkPage />} />
        <Route path="workers" element={<WorkerFleetPage />} />
        <Route path="quarantine" element={<QuarantinePage />} />
        <Route path="quarantine/:quarantineId" element={<QuarantineDetailPage />} />
        <Route path="alerts" element={<AlertsPage />} />
        <Route path="alerts/:alertId" element={<AlertDetailPage />} />
        <Route path="messages" element={<MessagesPage />} />
        {/* An opaque queue UUID, never a recipient address: this path is
            written into history, access logs, and the sign-in returnTo. */}
        <Route path="messages/:intentId" element={<MessageDetailPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Route>
    {/* Mailbox-proven account recovery: reachable without a session, like
        /login. The reset link's token rides in the query string and is only
        ever posted to the completion endpoint — never logged or echoed. */}
    <Route path="/forgot-password" element={<ForgotPasswordPage />} />
    <Route path="/reset-password" element={<ResetPasswordPage />} />
    {/* Mailbox-proven provisioning: an invited operator has no session and no
        password yet, so this lands beside the recovery screens. The token
        rides in the query string and is only ever posted to the acceptance
        endpoint — never logged or echoed. */}
    <Route path="/accept-invitation" element={<AcceptInvitationPage />} />
  </React.Fragment>
);

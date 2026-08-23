import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { login } from "../api/auth";
import { AdminApiError } from "../api/client";
import { AuthErrorSummary } from "../components/auth/AuthErrorSummary";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

const genericFailure =
  "We couldn't sign you in. Check your details and try again.";

function safeReturnPath(search: string): string {
  const candidate = new URLSearchParams(search).get("returnTo");
  if (
    !candidate ||
    !candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    candidate.includes("\\") ||
    candidate.startsWith("/login")
  ) {
    return "/";
  }
  const base = new URL("https://admin.packscout.invalid");
  const resolved = new URL(candidate, base);
  return resolved.origin === base.origin
    ? `${resolved.pathname}${resolved.search}${resolved.hash}`
    : "/";
}

function loginErrorMessage(error: unknown): string {
  if (!(error instanceof AdminApiError)) return genericFailure;
  if (error.code === "RATE_LIMITED") {
    return "Too many sign-in attempts. Wait a moment, then try again.";
  }
  if (error.code === "SERVICE_UNAVAILABLE" || error.status === 503) {
    return "PackScout Admin is temporarily unavailable. Your account has not been changed.";
  }
  return genericFailure;
}

export function LoginPage() {
  useDocumentTitle("Sign in");
  const location = useLocation();
  const navigate = useNavigate();
  const errorRef = useRef<HTMLDivElement>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionExpired =
    new URLSearchParams(location.search).get("reason") === "session_expired";

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await login({ email, password });
      navigate(safeReturnPath(location.search), { replace: true });
    } catch (caught) {
      setError(loginErrorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="admin-route-state">
      <div className="admin-route-card">
        <span className="admin-kicker">PackScout operations</span>
        <h1>Sign in to continue.</h1>
        <p>Use the operator account provided by your PackScout admin.</p>

        <form
          className="admin-stack admin-login-form"
          aria-label="Operator sign in"
          noValidate
          onSubmit={(event) => void submit(event)}
        >
          {sessionExpired && !error ? (
            <p className="admin-form-error" role="status">
              Your session ended. Sign in again to continue.
            </p>
          ) : null}
          {error ? <AuthErrorSummary ref={errorRef} message={error} /> : null}

          <div className="admin-field">
            <label htmlFor="login-email">Email</label>
            <input
              id="login-email"
              name="email"
              type="email"
              autoComplete="username"
              autoFocus
              required
              value={email}
              disabled={submitting}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>

          <div className="admin-field">
            <label htmlFor="login-password">Password</label>
            <input
              id="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              disabled={submitting}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>

          <button
            type="submit"
            className="admin-button admin-button-primary"
            disabled={submitting || !email || !password}
          >
            {submitting ? "Signing in…" : "Sign in"}
          </button>
          <span className="admin-visually-hidden" aria-live="polite">
            {submitting ? "Signing in…" : ""}
          </span>

          <p className="admin-auth-links">
            <Link to="/forgot-password">Forgot your password?</Link>
          </p>
        </form>
      </div>
    </main>
  );
}

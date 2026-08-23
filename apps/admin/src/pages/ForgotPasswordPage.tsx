import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { requestPasswordReset } from "../api/auth";
import { AdminApiError } from "../api/client";
import { AuthErrorSummary } from "../components/auth/AuthErrorSummary";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

/**
 * The reset-request screen, reachable from sign-in without a session. Its
 * confirmation deliberately says the same thing for every address: whether
 * mail is coming is never observable here, only in the mailbox.
 */

const serviceFailure =
  "PackScout Admin is temporarily unavailable. Your account has not been changed.";

function requestErrorMessage(error: unknown): string {
  if (error instanceof AdminApiError && error.code === "VALIDATION_FAILED") {
    const details = error.details as
      | { email?: readonly string[] }
      | undefined;
    return details?.email?.[0] ?? "Enter a valid email address.";
  }
  return serviceFailure;
}

export function ForgotPasswordPage() {
  useDocumentTitle("Reset your password");
  const errorRef = useRef<HTMLDivElement>(null);
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await requestPasswordReset({ email });
      setSent(true);
    } catch (caught) {
      setError(requestErrorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="admin-layout">
      <main className="admin-main">
        <div className="admin-main__inner">
          <div className="admin-not-found admin-auth-screen">
            <span className="admin-eyebrow">PackScout operations</span>
            {sent ? (
              <>
                <h1>Check your mail.</h1>
                <p role="status">
                  If that address belongs to an operator account, a reset link
                  is on its way. The link works once and expires soon, and
                  requesting another replaces it.
                </p>
                <p>
                  Nothing arrived? Check the address and your spam folder, or
                  request another link.
                </p>
                <button
                  type="button"
                  className="admin-button admin-button--secondary"
                  onClick={() => setSent(false)}
                >
                  Request another link
                </button>
                <p className="admin-auth-links">
                  <Link to="/login">Back to sign in</Link>
                </p>
              </>
            ) : (
              <>
                <h1>Reset your password.</h1>
                <p>
                  Enter your operator email address. If it is registered, a
                  one-time reset link will be mailed to it.
                </p>

                <form
                  className="admin-ledger admin-page admin-auth-card"
                  aria-label="Request a password reset"
                  noValidate
                  onSubmit={(event) => void submit(event)}
                >
                  {error ? (
                    <AuthErrorSummary ref={errorRef} message={error} />
                  ) : null}

                  <div className="admin-field">
                    <label htmlFor="reset-request-email">Email</label>
                    <input
                      id="reset-request-email"
                      name="email"
                      type="email"
                      autoComplete="username"
                      autoFocus
                      required
                      maxLength={254}
                      value={email}
                      disabled={submitting}
                      onChange={(event) => setEmail(event.target.value)}
                    />
                  </div>

                  <button
                    type="submit"
                    className="admin-button admin-button--primary"
                    disabled={submitting || !email}
                  >
                    {submitting ? "Sending…" : "Send reset link"}
                  </button>
                  <span className="admin-visually-hidden" aria-live="polite">
                    {submitting ? "Sending…" : ""}
                  </span>
                </form>

                <p className="admin-auth-links">
                  <Link to="/login">Back to sign in</Link>
                </p>
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

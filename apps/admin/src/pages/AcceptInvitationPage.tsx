import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { operatorInvitationAcceptanceRequestSchema } from "@packscout/contracts";
import { acceptOperatorInvitation } from "../api/auth";
import { AdminApiError } from "../api/client";
import { AuthErrorSummary } from "../components/auth/AuthErrorSummary";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

/**
 * The set-password screen a mailed invitation link lands on. The token rides
 * in the `token` query parameter and is only ever posted to the acceptance
 * endpoint — never echoed, stored, or logged. Every dead link — missing,
 * malformed, expired, superseded, cancelled, or already used — collapses into
 * the one plain invalid-link state, which says nothing about whether an
 * account exists or what state it is in. The password is validated against
 * the exact schema an administrator-set password must satisfy, so the
 * messages are the ones the rest of the admin shows.
 */

type Phase = "form" | "success" | "invalid_link";

const serviceFailure =
  "PackScout Admin is temporarily unavailable. Your account is unchanged.";

function passwordMessageFrom(error: AdminApiError): string | null {
  const details = error.details as
    | { password?: readonly string[] }
    | undefined;
  return details?.password?.[0] ?? null;
}

function InvalidLinkState() {
  return (
    <>
      <h1>This invitation link is no longer valid.</h1>
      <p role="status">
        Invitation links work once and expire on their own, and a newer
        invitation replaces any older one. Ask an administrator to send a new
        invitation.
      </p>
      <p className="admin-auth-links">
        <Link to="/login">Back to sign in</Link>
      </p>
    </>
  );
}

export function AcceptInvitationPage() {
  useDocumentTitle("Accept your invitation");
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const errorRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>(token ? "form" : "invalid_link");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setError(null);

    // The same schema — and therefore the same messages — the acceptance
    // endpoint and the administrator-facing credential forms enforce.
    const parsed = operatorInvitationAcceptanceRequestSchema.safeParse({
      token,
      password,
    });
    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors;
      if (fieldErrors.password?.length) {
        setError(fieldErrors.password[0]);
        return;
      }
      setPhase("invalid_link");
      return;
    }

    setSubmitting(true);
    try {
      await acceptOperatorInvitation(parsed.data);
      setPhase("success");
    } catch (caught) {
      if (caught instanceof AdminApiError) {
        if (caught.code === "EMAIL_LINK_INVALID") {
          setPhase("invalid_link");
          return;
        }
        if (caught.code === "VALIDATION_FAILED") {
          setError(
            passwordMessageFrom(caught) ?? "Check the new password and try again.",
          );
          return;
        }
      }
      setError(serviceFailure);
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
            {phase === "invalid_link" ? (
              <InvalidLinkState />
            ) : phase === "success" ? (
              <>
                <h1>Your operator account is ready.</h1>
                <p role="status">
                  Sign in with your email address and the password you just
                  chose.
                </p>
                <Link to="/login" className="admin-button admin-button--primary">
                  Go to sign in
                </Link>
              </>
            ) : (
              <>
                <h1>Choose your password.</h1>
                <p>
                  This one-time link proves you control the mailbox it was sent
                  to. Choose a password and your PackScout operator account
                  becomes active.
                </p>

                <form
                  className="admin-ledger admin-page admin-auth-card"
                  aria-label="Choose your password"
                  noValidate
                  onSubmit={(event) => void submit(event)}
                >
                  {error ? (
                    <AuthErrorSummary ref={errorRef} message={error} />
                  ) : null}

                  <div className="admin-field">
                    <label htmlFor="invitation-new-password">Password</label>
                    <input
                      id="invitation-new-password"
                      name="password"
                      type="password"
                      autoComplete="new-password"
                      autoFocus
                      required
                      minLength={12}
                      maxLength={128}
                      value={password}
                      disabled={submitting}
                      aria-describedby="invitation-new-password-note"
                      onChange={(event) => setPassword(event.target.value)}
                    />
                    <small id="invitation-new-password-note">
                      Use at least 12 characters. PackScout will never show
                      this value again.
                    </small>
                  </div>

                  <button
                    type="submit"
                    className="admin-button admin-button--primary"
                    disabled={submitting || !password}
                  >
                    {submitting ? "Activating account…" : "Activate my account"}
                  </button>
                  <span className="admin-visually-hidden" aria-live="polite">
                    {submitting ? "Activating account…" : ""}
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

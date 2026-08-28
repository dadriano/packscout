import { useEffect, useState, type FormEvent } from "react";
import type {
  OperatorRole,
  OperatorState,
  OperatorSummary,
} from "@packscout/contracts";
import { AdminApiError } from "../api/client";
import {
  cancelOperatorInvitation,
  createOperatorWithPassword,
  inviteOperator,
  listOperators,
  reissueOperatorInvitation,
  updateOperator,
} from "../api/operators";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { AuthRestrictedState } from "../components/auth/AuthRestrictedState";
import {
  OperatorDialog,
  type OperatorDialogMode,
  type OperatorDialogSubmission,
} from "../components/auth/OperatorDialog";
import { OperatorLedger } from "../components/auth/OperatorLedger";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useConfirm } from "../providers/confirm";
import { useSession } from "../providers/session";
import { useToast } from "../providers/toast";

interface ActiveDialog {
  mode: OperatorDialogMode;
  operator?: OperatorSummary;
}

function errorMessage(error: unknown): string {
  if (error instanceof AdminApiError) return error.message;
  return "PackScout Admin is temporarily unavailable. Your account has not been changed.";
}

function isAmbiguousDirectCreationFailure(error: unknown): boolean {
  return !(
    error instanceof AdminApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.code !== "INVALID_RESPONSE"
  );
}

function roleName(role: OperatorRole): string {
  return role === "admin" ? "administrator" : "data operator";
}

export function OperatorsPage() {
  useDocumentTitle("Operators");
  const { confirm } = useConfirm();
  const { status: sessionStatus } = useSession();
  const { showToast } = useToast();
  const session =
    sessionStatus.phase === "authenticated" ? sessionStatus.session : null;
  const [operators, setOperators] = useState<OperatorSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeDialog, setActiveDialog] = useState<ActiveDialog | null>(null);
  const [dialogPending, setDialogPending] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [searchDraft, setSearchDraft] = useState("");
  const [roleFilter, setRoleFilter] = useState<OperatorRole | "">("");
  const [stateFilter, setStateFilter] = useState<OperatorState | "">("");
  const [refreshIndex, setRefreshIndex] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void listOperators(
      {
        search: searchDraft || undefined,
        role: roleFilter || undefined,
        state: stateFilter || undefined,
      },
      controller.signal,
    )
      .then((result) => {
        setOperators(result.items);
        setLoadError(null);
        setForbidden(false);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (error instanceof AdminApiError && error.status === 403) {
          setForbidden(true);
        } else {
          setLoadError(errorMessage(error));
        }
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [refreshIndex, roleFilter, searchDraft, stateFilter]);

  function replaceOperator(updated: OperatorSummary) {
    setOperators((current) => {
      const exists = current.some((item) => item.id === updated.id);
      return exists
        ? current.map((item) => (item.id === updated.id ? updated : item))
        : [updated, ...current];
    });
  }

  async function submitDialog(submission: OperatorDialogSubmission) {
    setDialogPending(true);
    setDialogError(null);
    try {
      if (submission.mode === "invite") {
        const result = await inviteOperator(submission.input);
        replaceOperator(result.operator);
        showToast(
          `Invitation sent to ${result.operator.email}. They choose their own password.`,
        );
      } else if (submission.mode === "create") {
        const result = await createOperatorWithPassword(submission.input);
        replaceOperator(result.operator);
        if (result.notification.status === "enqueued") {
          showToast(
            `${result.operator.displayName} can now sign in. Account email queued; share the initial password separately.`,
          );
        } else if (
          result.notification.reason === "EMAIL_OUTBOX_UNAVAILABLE"
        ) {
          showToast(
            `${result.operator.displayName} can now sign in, but email queueing could not be confirmed. Check Messages before sending sign-in details and the initial password through a secure channel.`,
            "error",
          );
        } else {
          showToast(
            `${result.operator.displayName} can now sign in, but the account email was not queued. Share the sign-in details and initial password through a secure channel.`,
            "error",
          );
        }
      } else if (submission.mode === "role" && activeDialog?.operator) {
        const result = await updateOperator(activeDialog.operator.id, {
          role: submission.role,
        });
        replaceOperator(result.operator);
        showToast(
          `${result.operator.displayName} is now an ${roleName(result.operator.role)}.`,
        );
      } else if (submission.mode === "credential" && activeDialog?.operator) {
        const result = await updateOperator(activeDialog.operator.id, {
          password: submission.password,
        });
        replaceOperator(result.operator);
        showToast(`Credential rotated for ${result.operator.displayName}.`);
      }
      setActiveDialog(null);
    } catch (error) {
      if (
        submission.mode === "create" &&
        isAmbiguousDirectCreationFailure(error)
      ) {
        setActiveDialog(null);
        setLoading(true);
        setRefreshIndex((current) => current + 1);
        showToast(
          "PackScout could not confirm whether the account was created or the email was queued. Check the operators list and Messages before trying again.",
          "error",
        );
      } else {
        setDialogError(errorMessage(error));
      }
    } finally {
      setDialogPending(false);
    }
  }

  async function toggleState(operator: OperatorSummary) {
    if (operator.id === session?.operator.id && operator.state === "active") {
      showToast("You cannot disable the account you are currently using.", "error");
      return;
    }
    const nextState: OperatorState =
      operator.state === "active" ? "disabled" : "active";
    if (nextState === "disabled") {
      await confirm({
        tier: "danger",
        title: `Disable access for ${operator.displayName}?`,
        description:
          "Their active sessions will end and they won't be able to sign in.",
        confirmLabel: "Disable access",
        successMessage: `Access disabled for ${operator.displayName}.`,
        action: async () => {
          const result = await updateOperator(operator.id, { state: nextState });
          replaceOperator(result.operator);
        },
      });
      return;
    }
    try {
      const result = await updateOperator(operator.id, { state: nextState });
      replaceOperator(result.operator);
      showToast(`Access enabled for ${operator.displayName}.`);
    } catch (error) {
      showToast(errorMessage(error), "error");
    }
  }

  /**
   * Sending a fresh invitation supersedes the account's outstanding one, so
   * the older link stops working. Nothing about the link reaches the browser:
   * the response carries only when it was sent and when it stops working.
   */
  async function reissueInvitation(operator: OperatorSummary) {
    try {
      const result = await reissueOperatorInvitation(operator.id);
      replaceOperator({ ...operator, invitation: result.invitation });
      showToast(`A new invitation is on its way to ${operator.email}.`);
    } catch (error) {
      showToast(errorMessage(error), "error");
    }
  }

  async function cancelInvitation(operator: OperatorSummary) {
    await confirm({
      tier: "danger",
      title: `Cancel the invitation for ${operator.displayName}?`,
      description:
        "Their invitation link stops working immediately and the account cannot be used.",
      confirmLabel: "Cancel invitation",
      successMessage: `Invitation cancelled for ${operator.displayName}.`,
      action: async () => {
        const result = await cancelOperatorInvitation(operator.id);
        replaceOperator(result.operator);
      },
    });
  }

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setRefreshIndex((current) => current + 1);
  }

  if (forbidden) {
    return (
      <div className="admin-page">
        <PageHeader
          eyebrow="Workspace / Operators"
          title="Operator access"
          description="Provision and maintain operator access to PackScout operations."
        />
        <AuthRestrictedState />
      </div>
    );
  }

  return (
    <div className="admin-page">
      <PageHeader
        eyebrow="Workspace / Operators"
        title="Operator access"
        description="Invite operators to choose their own password, or create an active account with an initial password. Assign the least access needed and end sessions when responsibilities change."
        actions={
          <>
            <button
              type="button"
              className="admin-button admin-button-secondary"
              onClick={() => {
                setDialogError(null);
                setActiveDialog({ mode: "create" });
              }}
            >
              Create with password
            </button>
            <button
              type="button"
              className="admin-button admin-button-primary"
              onClick={() => {
                setDialogError(null);
                setActiveDialog({ mode: "invite" });
              }}
            >
              Invite operator
            </button>
          </>
        }
      />

      <form className="admin-surface admin-panel" aria-label="Filter operators" onSubmit={applyFilters}>
        <div className="admin-section-header">
          <div className="admin-field">
            <label htmlFor="operator-search">Search name or email</label>
            <input
              id="operator-search"
              type="search"
              value={searchDraft}
              onChange={(event) => setSearchDraft(event.target.value)}
            />
          </div>
          <div className="admin-field">
            <label htmlFor="operator-role-filter">Role</label>
            <select
              id="operator-role-filter"
              value={roleFilter}
              onChange={(event) =>
                setRoleFilter(event.target.value as OperatorRole | "")
              }
            >
              <option value="">All roles</option>
              <option value="admin">Administrator</option>
              <option value="data_operator">Data operator</option>
            </select>
          </div>
          <div className="admin-field">
            <label htmlFor="operator-state-filter">State</label>
            <select
              id="operator-state-filter"
              value={stateFilter}
              onChange={(event) =>
                setStateFilter(event.target.value as OperatorState | "")
              }
            >
              <option value="">All states</option>
              <option value="pending">Awaiting activation</option>
              <option value="active">Active</option>
              <option value="disabled">Disabled</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
          <button className="admin-button admin-button-secondary" type="submit">
            Apply filters
          </button>
        </div>
      </form>

      {loading ? (
        <section className="admin-surface admin-panel" aria-busy="true" aria-live="polite">
          <span className="admin-kicker">Loading access ledger…</span>
        </section>
      ) : loadError ? (
        <EmptyState
          eyebrow="Operator service unavailable"
          title="Operator access could not be loaded."
          description={loadError}
          action={
            <button
              type="button"
              className="admin-button admin-button-secondary"
              onClick={() => {
                setLoading(true);
                setRefreshIndex((current) => current + 1);
              }}
            >
              Try again
            </button>
          }
        />
      ) : operators.length === 0 ? (
        <EmptyState
          eyebrow="Access ledger"
          title="No other operators yet"
          description="Send an invitation so the operator chooses their own password, or create an active account and share its initial password securely."
          action={
            <div className="admin-form-actions">
              <button
                type="button"
                className="admin-button admin-button-secondary"
                onClick={() => {
                  setDialogError(null);
                  setActiveDialog({ mode: "create" });
                }}
              >
                Create with password
              </button>
              <button
                type="button"
                className="admin-button admin-button-primary"
                onClick={() => {
                  setDialogError(null);
                  setActiveDialog({ mode: "invite" });
                }}
              >
                Invite operator
              </button>
            </div>
          }
        />
      ) : (
        <OperatorLedger
          operators={operators}
          currentOperatorId={session?.operator.id ?? ""}
          onChangeRole={(operator) => {
            setDialogError(null);
            setActiveDialog({ mode: "role", operator });
          }}
          onRotateCredential={(operator) => {
            setDialogError(null);
            setActiveDialog({ mode: "credential", operator });
          }}
          onToggleState={(operator) => void toggleState(operator)}
          onReissueInvitation={(operator) => void reissueInvitation(operator)}
          onCancelInvitation={(operator) => void cancelInvitation(operator)}
        />
      )}

      {activeDialog ? (
        <OperatorDialog
          open
          mode={activeDialog.mode}
          operator={activeDialog.operator}
          pending={dialogPending}
          error={dialogError}
          onClose={() => {
            if (!dialogPending) setActiveDialog(null);
          }}
          onSubmit={submitDialog}
        />
      ) : null}
    </div>
  );
}

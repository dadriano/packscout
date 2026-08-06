import { useEffect, useState, type FormEvent } from "react";
import type {
  OperatorRole,
  OperatorState,
  OperatorSummary,
} from "@packscout/contracts";
import { AdminApiError } from "../api/client";
import {
  createOperator,
  listOperators,
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
      if (submission.mode === "create") {
        const result = await createOperator(submission.input);
        replaceOperator(result.operator);
        showToast(`${result.operator.displayName} can now sign in.`);
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
      setDialogError(errorMessage(error));
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
          description="Provision and maintain invite-only access to PackScout operations."
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
        description="Provision operator accounts, assign the least access needed, and end sessions when responsibilities change."
        actions={
          <button
            type="button"
            className="admin-button admin-button--primary"
            onClick={() => {
              setDialogError(null);
              setActiveDialog({ mode: "create" });
            }}
          >
            Add operator
          </button>
        }
      />

      <form className="admin-ledger" aria-label="Filter operators" onSubmit={applyFilters}>
        <div className="admin-section-heading">
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
              <option value="active">Active</option>
              <option value="disabled">Disabled</option>
            </select>
          </div>
          <button className="admin-button admin-button--secondary" type="submit">
            Apply filters
          </button>
        </div>
      </form>

      {loading ? (
        <section className="admin-ledger" aria-busy="true" aria-live="polite">
          <span className="admin-eyebrow">Loading access ledger…</span>
        </section>
      ) : loadError ? (
        <EmptyState
          eyebrow="Operator service unavailable"
          title="Operator access could not be loaded."
          description={loadError}
          action={
            <button
              type="button"
              className="admin-button admin-button--secondary"
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
          description="Add an operator to grant invite-only access. Initial credentials are delivered outside PackScout."
          action={
            <button
              type="button"
              className="admin-button admin-button--primary"
              onClick={() => setActiveDialog({ mode: "create" })}
            >
              Add operator
            </button>
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

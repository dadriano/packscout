import { useRef, useState, type FormEvent } from "react";
import type {
  CreateOperatorRequest,
  OperatorRole,
  OperatorSummary,
} from "@packscout/contracts";
import { AdminDialog } from "../AdminDialog";
import { AuthErrorSummary } from "./AuthErrorSummary";

export type OperatorDialogMode = "create" | "role" | "credential";

export type OperatorDialogSubmission =
  | { mode: "create"; input: CreateOperatorRequest }
  | { mode: "role"; role: OperatorRole }
  | { mode: "credential"; password: string };

interface OperatorDialogProps {
  open: boolean;
  mode: OperatorDialogMode;
  operator?: OperatorSummary;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (submission: OperatorDialogSubmission) => Promise<void>;
}

function dialogContent(mode: OperatorDialogMode) {
  if (mode === "create") {
    return {
      title: "Add an operator",
      description:
        "Enter an initial credential and deliver it to the operator outside PackScout.",
      action: "Add operator",
      pendingAction: "Adding operator…",
    };
  }
  if (mode === "role") {
    return {
      title: "Change operator role",
      description:
        "The new permissions take effect immediately and active sessions will end.",
      action: "Save role",
      pendingAction: "Saving role…",
    };
  }
  return {
    title: "Rotate credential",
    description:
      "The current credential and active sessions will stop working immediately.",
    action: "Rotate credential",
    pendingAction: "Rotating credential…",
  };
}

export function OperatorDialog({
  open,
  mode,
  operator,
  pending,
  error,
  onClose,
  onSubmit,
}: OperatorDialogProps) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<OperatorRole>(
    operator?.role ?? "data_operator",
  );
  const firstInputRef = useRef<HTMLInputElement>(null);
  const copy = dialogContent(mode);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (mode === "create") {
      await onSubmit({
        mode,
        input: { email, displayName, password, role },
      });
    } else if (mode === "role") {
      await onSubmit({ mode, role });
    } else {
      await onSubmit({ mode, password });
    }
  }

  return (
    <AdminDialog
      open={open}
      size="small"
      title={copy.title}
      description={copy.description}
      onClose={onClose}
      dismissible={!pending}
      initialFocusRef={firstInputRef}
      footer={
        <>
          <button
            type="button"
            className="admin-button admin-button-secondary"
            disabled={pending}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="operator-access-form"
            className="admin-button admin-button-primary"
            disabled={pending}
          >
            {pending ? copy.pendingAction : copy.action}
          </button>
        </>
      }
    >
      <form
        id="operator-access-form"
        className="admin-page"
        onSubmit={(event) => void submit(event)}
      >
        {error ? <AuthErrorSummary message={error} /> : null}
        {mode === "create" ? (
          <>
            <div className="admin-field">
              <label htmlFor="operator-display-name">Display name</label>
              <input
                id="operator-display-name"
                ref={firstInputRef}
                value={displayName}
                required
                maxLength={120}
                disabled={pending}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </div>
            <div className="admin-field">
              <label htmlFor="operator-email">Email</label>
              <input
                id="operator-email"
                type="email"
                autoComplete="off"
                value={email}
                required
                maxLength={254}
                disabled={pending}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
          </>
        ) : null}

        {mode !== "credential" ? (
          <div className="admin-field">
            <label htmlFor="operator-role">Role</label>
            <select
              id="operator-role"
              value={role}
              disabled={pending}
              onChange={(event) => setRole(event.target.value as OperatorRole)}
            >
              <option value="data_operator">Data operator</option>
              <option value="admin">Administrator</option>
            </select>
          </div>
        ) : null}

        {mode !== "role" ? (
          <div className="admin-field">
            <label htmlFor="operator-password">
              {mode === "create" ? "Initial password" : "New password"}
            </label>
            <input
              id="operator-password"
              ref={mode === "credential" ? firstInputRef : undefined}
              type="password"
              autoComplete="new-password"
              value={password}
              required
              minLength={12}
              maxLength={128}
              disabled={pending}
              aria-describedby="operator-password-note"
              onChange={(event) => setPassword(event.target.value)}
            />
            <small id="operator-password-note">
              Use at least 12 characters. PackScout will never show this value again.
            </small>
          </div>
        ) : null}
      </form>
    </AdminDialog>
  );
}

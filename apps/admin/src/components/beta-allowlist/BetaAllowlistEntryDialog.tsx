import { useRef, useState, type FormEvent } from "react";
import {
  BETA_ALLOWLIST_MAX_EMAIL_LENGTH,
  BETA_ALLOWLIST_MAX_LABEL_LENGTH,
  BETA_ALLOWLIST_MAX_WALLET_ADDRESS_LENGTH,
  type BetaAllowlistEntry,
} from "@packscout/contracts";
import { AdminDialog } from "../AdminDialog";
import { AuthErrorSummary } from "../auth/AuthErrorSummary";

/**
 * The full identifier statement an add or edit submits: each field is a
 * trimmed value or null for "no value". The page decides whether that becomes
 * a create or an update.
 */
export interface BetaAllowlistEntryFields {
  readonly email: string | null;
  readonly walletAddress: string | null;
  readonly label: string | null;
}

interface BetaAllowlistEntryDialogProps {
  open: boolean;
  /** The entry being edited, or undefined when adding a new one. */
  entry?: BetaAllowlistEntry;
  pending: boolean;
  /** A failed submission's message; normalization and duplicate refusals land here. */
  error: string | null;
  onClose: () => void;
  onSubmit: (fields: BetaAllowlistEntryFields) => Promise<void>;
}

const dialogCopy = {
  add: {
    title: "Add an allowlist entry",
    description:
      "Enter the invitee's email address, wallet address, or both. If they are already waiting for review, adding the entry admits them immediately; otherwise they walk straight in the first time they sign in.",
    action: "Add entry",
    pendingAction: "Adding entry…",
  },
  edit: {
    title: "Edit this allowlist entry",
    description:
      "Changing an identifier stops automatic admission for the old value and starts it for the new one. Anyone already admitted keeps their access.",
    action: "Save entry",
    pendingAction: "Saving entry…",
  },
} as const;

/**
 * One form for adding and editing an entry, so validation and messaging stay
 * identical between them. The form deliberately does not second-guess what
 * counts as a valid address — the product backend owns normalization and
 * duplicate detection, and its refusals surface in the error slot above the
 * fields as plain human messages.
 */
export function BetaAllowlistEntryDialog({
  open,
  entry,
  pending,
  error,
  onClose,
  onSubmit,
}: BetaAllowlistEntryDialogProps) {
  const [email, setEmail] = useState(entry?.email ?? "");
  const [walletAddress, setWalletAddress] = useState(entry?.walletAddress ?? "");
  const [label, setLabel] = useState(entry?.label ?? "");
  const [identifierMissing, setIdentifierMissing] = useState(false);
  const firstInputRef = useRef<HTMLInputElement>(null);
  const copy = dialogCopy[entry === undefined ? "add" : "edit"];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const fields: BetaAllowlistEntryFields = {
      email: email.trim() || null,
      walletAddress: walletAddress.trim() || null,
      label: label.trim() || null,
    };
    if (fields.email === null && fields.walletAddress === null) {
      setIdentifierMissing(true);
      return;
    }
    setIdentifierMissing(false);
    await onSubmit(fields);
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
            form="beta-allowlist-entry-form"
            className="admin-button admin-button-primary"
            disabled={pending}
          >
            {pending ? copy.pendingAction : copy.action}
          </button>
        </>
      }
    >
      <form
        id="beta-allowlist-entry-form"
        className="admin-page"
        onSubmit={(event) => void submit(event)}
      >
        {error !== null ? (
          <AuthErrorSummary message={error} />
        ) : identifierMissing ? (
          <AuthErrorSummary message="Enter an email address, a wallet address, or both." />
        ) : null}
        <div className="admin-field">
          <label htmlFor="beta-allowlist-email">Email address</label>
          <input
            id="beta-allowlist-email"
            ref={firstInputRef}
            type="email"
            autoComplete="off"
            value={email}
            maxLength={BETA_ALLOWLIST_MAX_EMAIL_LENGTH}
            disabled={pending}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className="admin-field">
          <label htmlFor="beta-allowlist-wallet-address">Wallet address</label>
          <input
            id="beta-allowlist-wallet-address"
            autoComplete="off"
            spellCheck={false}
            value={walletAddress}
            maxLength={BETA_ALLOWLIST_MAX_WALLET_ADDRESS_LENGTH}
            disabled={pending}
            aria-describedby="beta-allowlist-identifier-note"
            onChange={(event) => setWalletAddress(event.target.value)}
          />
          <small id="beta-allowlist-identifier-note">
            At least one identifier is required. Wallet addresses match
            regardless of letter casing.
          </small>
        </div>
        <div className="admin-field">
          <label htmlFor="beta-allowlist-label">Label (optional)</label>
          <input
            id="beta-allowlist-label"
            autoComplete="off"
            value={label}
            maxLength={BETA_ALLOWLIST_MAX_LABEL_LENGTH}
            disabled={pending}
            aria-describedby="beta-allowlist-label-note"
            onChange={(event) => setLabel(event.target.value)}
          />
          <small id="beta-allowlist-label-note">
            A short note for other operators, such as who invited this person.
          </small>
        </div>
      </form>
    </AdminDialog>
  );
}

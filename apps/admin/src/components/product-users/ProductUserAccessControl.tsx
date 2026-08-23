import {
  describeProductUserAccessActions,
  describeProductUserAccessOutcome,
  describeProductUserAccessProvenance,
  describeProductUserAccessState,
  type ProductUserAccessDecision,
  type ProductUserAccessDecisionChange,
  type ProductUserAccessState,
  type ProductUserRecord,
} from "@packscout/contracts";
import { decideProductUserAccess } from "../../api/product-users";
import { useConfirm } from "../../providers/confirm";
import { useToast } from "../../providers/toast";
import { StatusBadge, type StatusTone } from "../StatusBadge";
import { dateTime } from "../operations/OperationStatus";

/**
 * The closed-beta access presentation and controls for one product user.
 *
 * Access is a separate dimension from standing and must read as one: a
 * waiting account is a person at the door, not a disciplined one, so the
 * waiting badge is the pending tone and never the danger tone suspension
 * uses. The badge names the state; the provenance line says how it was
 * decided — automatically by the allowlist, by an operator, or not yet.
 *
 * The decision controls are reversible flips — approve, decline, revoke —
 * each behind an explicit confirmation stating the consequence for that
 * person. They render only for operators holding the manage permission; the
 * server enforces that independently, and this is the matching absence in
 * the interface rather than the enforcement itself. Nothing here deletes a
 * person or touches what they have saved.
 */

const ACCESS_TONES: Record<ProductUserAccessState, StatusTone> = {
  awaiting_review: "pending",
  approved: "ready",
  declined: "danger",
};

export function ProductUserAccessBadge({
  state,
}: {
  readonly state: ProductUserAccessState;
}) {
  return (
    <StatusBadge
      label={describeProductUserAccessState(state)}
      tone={ACCESS_TONES[state]}
    />
  );
}

/**
 * The provenance line under the access badge: how the current decision came
 * to be, and when. For a record still on its default decision the date is
 * when the person started waiting — their first sign-in.
 */
export function productUserAccessProvenanceLine(
  decision: ProductUserAccessDecision,
): string {
  return `${describeProductUserAccessProvenance(decision)} · ${dateTime(
    decision.decidedAt,
  )}`;
}

interface ProductUserAccessControlProps {
  readonly user: Pick<ProductUserRecord, "subject" | "access">;
  /**
   * Receives the decision the backend reports afterwards. It may differ from
   * the one requested when another administrator acted first, so callers must
   * render this rather than assuming their own request won.
   */
  readonly onDecided: (
    subject: string,
    change: ProductUserAccessDecisionChange,
  ) => void;
}

export function ProductUserAccessControl({
  user,
  onDecided,
}: ProductUserAccessControlProps) {
  const { confirm } = useConfirm();
  const { showToast } = useToast();

  return (
    <>
      {describeProductUserAccessActions(user.access.state).map((action) => (
        <button
          key={action.actionLabel}
          type="button"
          className={`admin-button admin-button--${
            action.destructive ? "danger" : "secondary"
          }`}
          onClick={() => {
            void confirm({
              title: action.title,
              description: action.description,
              confirmLabel: action.confirmLabel,
              tier: action.destructive ? "danger" : "standard",
              action: async () => {
                const change = await decideProductUserAccess(
                  action.action,
                  user.subject,
                );
                // The outcome describes what the backend now holds, so a
                // repeat or a concurrent decision is reported honestly
                // rather than claiming a change that never was.
                showToast(describeProductUserAccessOutcome(change));
                onDecided(user.subject, change);
              },
            });
          }}
        >
          {action.actionLabel}
        </button>
      ))}
    </>
  );
}

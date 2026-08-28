import {
  describeProductUserStandingAction,
  describeProductUserStandingOutcome,
  type ProductUserRecord,
  type ProductUserStandingChange,
} from "@packscout/contracts";
import { setProductUserStanding } from "../../api/product-users";
import { useConfirm } from "../../providers/confirm";
import { useToast } from "../../providers/toast";

/**
 * The one account control an administrator has over a product user.
 *
 * It is a reversible flip — suspend an active account, reinstate a suspended
 * one — and there is deliberately no third option: nothing here deletes a
 * person or edits what they have saved. Both directions require an explicit
 * confirmation that states the consequence in full, so an administrator never
 * changes someone's access by a single stray click.
 *
 * The control renders only for operators holding the manage permission; the
 * server enforces that independently, and this is the matching absence in the
 * interface rather than the enforcement itself.
 */

interface ProductUserStandingControlProps {
  readonly user: Pick<ProductUserRecord, "subject" | "standing">;
  /**
   * Receives the standing the backend reports afterwards. It may differ from
   * the one requested when another administrator acted first, so callers must
   * render this rather than assuming their own request won.
   */
  readonly onChanged: (change: ProductUserStandingChange) => void;
}

export function ProductUserStandingControl({
  user,
  onChanged,
}: ProductUserStandingControlProps) {
  const { confirm } = useConfirm();
  const { showToast } = useToast();
  const action = describeProductUserStandingAction(user.standing);

  return (
    <button
      type="button"
      className={`admin-button admin-button-${
        action.destructive ? "danger" : "secondary"
      }`}
      onClick={() => {
        void confirm({
          title: action.title,
          description: action.description,
          confirmLabel: action.confirmLabel,
          tier: action.destructive ? "danger" : "standard",
          action: async () => {
            const change = await setProductUserStanding(
              user.subject,
              // The target standing, never a toggle: a repeat or a concurrent
              // action converges instead of flipping the account back.
              action.standing,
            );
            // The outcome describes what the backend now holds, so a repeat
            // says so plainly rather than claiming a change that never was.
            showToast(describeProductUserStandingOutcome(change));
            onChanged(change);
          },
        });
      }}
    >
      {action.actionLabel}
    </button>
  );
}

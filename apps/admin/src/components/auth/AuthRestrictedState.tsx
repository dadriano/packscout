import { Link } from "react-router-dom";
import { EmptyState } from "../EmptyState";

interface AuthRestrictedStateProps {
  /** Names the capability the operator's role does not include. */
  description?: string;
}

const OPERATOR_ACCESS_DESCRIPTION =
  "Your operator account is active, but it does not include permission to manage operator access. You can continue using the operational tools assigned to your role.";

export function AuthRestrictedState({
  description = OPERATOR_ACCESS_DESCRIPTION,
}: AuthRestrictedStateProps = {}) {
  return (
    <EmptyState
      eyebrow="Access restricted"
      title="This workspace is limited to administrators."
      description={description}
      action={
        <Link className="admin-button admin-button-secondary" to="/">
          Return to overview
        </Link>
      }
    />
  );
}

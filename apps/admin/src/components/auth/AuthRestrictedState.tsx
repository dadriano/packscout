import { Link } from "react-router-dom";
import { EmptyState } from "../EmptyState";

export function AuthRestrictedState() {
  return (
    <EmptyState
      eyebrow="Access restricted"
      title="This workspace is limited to administrators."
      description="Your operator account is active, but it does not include permission to manage operator access. You can continue using the operational tools assigned to your role."
      action={
        <Link className="admin-button admin-button--secondary" to="/">
          Return to overview
        </Link>
      }
    />
  );
}

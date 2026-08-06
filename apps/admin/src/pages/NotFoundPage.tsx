import { Link } from "react-router-dom";

export function NotFoundPage() {
  return (
    <div className="admin-not-found">
      <span className="admin-eyebrow">Off route / 404</span>
      <h1>That admin trail has not been mapped.</h1>
      <p>The address is outside the current Packscout operations workspace.</p>
      <Link to="/" className="admin-button admin-button--primary">
        Return to overview
      </Link>
    </div>
  );
}

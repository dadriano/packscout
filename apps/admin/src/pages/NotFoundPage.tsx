import { Link } from "react-router-dom";

export function NotFoundPage() {
  return (
    <section className="admin-surface admin-empty-state">
      <span className="admin-kicker">Off route / 404</span>
      <h2>That admin trail has not been mapped.</h2>
      <p>The address is outside the current Packscout operations workspace.</p>
      <div className="admin-empty-state__action">
        <Link to="/" className="admin-button admin-button-primary">
          Return to overview
        </Link>
      </div>
    </section>
  );
}

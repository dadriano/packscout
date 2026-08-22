import { Link, matchPath, useLocation } from "react-router-dom";
import {
  ROOT_TITLE,
  ROUTABLE_PATTERNS,
  breadcrumbLabel,
} from "../routes/admin-routes";

/**
 * Route-driven breadcrumbs. Each URL segment becomes one entry, labelled from
 * the shared destination list. Only segments that resolve to a real page are
 * rendered as links, so an intermediate identifier never navigates into the
 * catch-all route.
 */

interface Crumb {
  label: string;
  path: string;
  routable: boolean;
}

function isRoutable(path: string): boolean {
  return ROUTABLE_PATTERNS.some((pattern) => matchPath(pattern, path) !== null);
}

export function Breadcrumbs() {
  const location = useLocation();
  const segments = location.pathname.split("/").filter(Boolean);

  // The overview is the trail's root, so it needs no trail of its own.
  if (segments.length === 0) return null;

  const crumbs: Crumb[] = [
    { label: ROOT_TITLE, path: "/", routable: true },
    ...segments.map((segment, index) => {
      const path = `/${segments.slice(0, index + 1).join("/")}`;
      return {
        label: breadcrumbLabel(segment),
        path,
        routable: isRoutable(path),
      };
    }),
  ];

  return (
    <nav aria-label="Breadcrumb" className="admin-breadcrumbs">
      {crumbs.map((crumb, index) => {
        const isLast = index === crumbs.length - 1;
        return (
          <span key={crumb.path} className="admin-breadcrumbs__crumb">
            {index > 0 ? (
              <span className="admin-breadcrumbs__separator" aria-hidden="true">
                /
              </span>
            ) : null}
            {!isLast && crumb.routable ? (
              <Link to={crumb.path} className="admin-breadcrumbs__link">
                {crumb.label}
              </Link>
            ) : (
              <span
                className={isLast ? "admin-breadcrumbs__current" : undefined}
                aria-current={isLast ? "page" : undefined}
              >
                {crumb.label}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}

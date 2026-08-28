import type { PublicReadError } from "@packscout/contracts";
import Link from "next/link";
import { catalogResultRecoveryPresentation } from "./catalog-state";
import { CatalogRouteRecovery } from "./CatalogRouteRecovery.client";

export function CatalogResultRecovery({
  error,
  recoveryHref,
  recoveryActionLabel,
}: Readonly<{
  error: PublicReadError;
  recoveryHref: string;
  recoveryActionLabel?: string;
}>) {
  const presentation = catalogResultRecoveryPresentation(error);
  if (presentation.kind === "retry") return <CatalogRouteRecovery />;

  return (
    <section
      aria-labelledby="catalog-result-recovery-title"
      className="route-placeholder"
      data-state="catalog-result-recovery"
    >
      <div className="route-placeholder__inner">
        <p className="route-kicker">{presentation.eyebrow}</p>
        <h2 className="route-title" id="catalog-result-recovery-title">
          {presentation.title}
        </h2>
        <p className="route-copy">{presentation.description}</p>
        <Link className="route-action" href={recoveryHref}>
          {recoveryActionLabel ?? presentation.actionLabel}
        </Link>
      </div>
    </section>
  );
}

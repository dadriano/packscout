import type {
  CanonicalKindSummary,
  CanonicalProviderSummary,
} from "@packscout/contracts";

/**
 * Per-kind counts and freshness for one provider.
 *
 * A count that stopped at the server's bound is a floor, not a total, and is
 * labelled in the card itself rather than in a tooltip. An operator uses this
 * surface to judge whether a feed is complete; a number that reads as exact and
 * is not would send them to the wrong conclusion.
 */

const KIND_LABELS: Record<string, string> = {
  platform: "Platforms",
  pack: "Packs",
  catalog_asset: "Catalog assets",
  ev_input: "EV inputs",
  pull: "Pulls",
  market_event: "Market events",
  estimated_ev: "Estimated EV",
};

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

export function countText(summary: CanonicalKindSummary): string {
  const formatted = summary.count.toLocaleString("en-US");
  return summary.precision === "at_least" ? `${formatted}+` : formatted;
}

function dateText(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toISOString().replace("T", " ").slice(0, 16);
}

export function CanonicalSummary({
  summary,
  selectedKind,
}: {
  summary: CanonicalProviderSummary;
  selectedKind: string;
}) {
  return (
    <section
      className="inspect-summary"
      aria-labelledby="canonical-summary-title"
    >
      <header className="admin-section-header">
        <div>
          <span className="admin-kicker">What PostgreSQL holds</span>
          <h2 id="canonical-summary-title">Records by kind</h2>
        </div>
      </header>
      <div className="inspect-summary__grid" role="list">
        {summary.kinds.map((kind) => {
          const selected = kind.recordKind === selectedKind;
          return (
            <div
              key={kind.recordKind}
              role="listitem"
              className={`inspect-summary__card${selected ? " is-selected" : ""}`}
              aria-current={selected ? "true" : undefined}
            >
              <span className="inspect-summary__label">
                {kindLabel(kind.recordKind)}
              </span>
              <strong className="inspect-summary__count">
                {countText(kind)}
              </strong>
              {kind.precision === "at_least" ? (
                <span className="inspect-summary__precision">
                  At least — counting stopped at the server bound
                </span>
              ) : (
                <span className="inspect-summary__precision">Exact count</span>
              )}
              <dl className="inspect-summary__facts">
                {kind.collectedExtremaComplete ? (
                  <>
                    <div>
                      <dt>Oldest collected</dt>
                      <dd>{dateText(kind.oldestCollectedAt)}</dd>
                    </div>
                    <div>
                      <dt>Newest collected</dt>
                      <dd>{dateText(kind.newestCollectedAt)}</dd>
                    </div>
                  </>
                ) : (
                  // Not computed is not the same fact as not present. A dash
                  // here would read as "this provider collected nothing".
                  <div>
                    <dt>Collected range</dt>
                    <dd>Not computed at this size</dd>
                  </div>
                )}
                <div>
                  <dt>Oldest accepted</dt>
                  <dd>{dateText(kind.oldestAcceptedAt)}</dd>
                </div>
                <div>
                  <dt>Newest accepted</dt>
                  <dd>{dateText(kind.newestAcceptedAt)}</dd>
                </div>
              </dl>
            </div>
          );
        })}
      </div>
    </section>
  );
}

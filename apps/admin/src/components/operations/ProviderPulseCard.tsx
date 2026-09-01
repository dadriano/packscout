import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { IndicatorTooltip } from "../IndicatorTooltip";
import { ProviderPulseDetails } from "./ProviderPulseDetails";
import type { SourceOperationControlsProps } from "./SourceOperationControls";
import { count, measuredAge, metricDescriptions, pulseIssue, pulseNeedsAttention, pulseState } from "./provider-pulse-presentation";
import { isRecentRateEligible, recentRateDescription, recentRateValue, type RecentRateReading } from "./provider-recent-rate";

function Metric({ label, description, children }: { label: string; description: string; children: ReactNode }) {
  return <div><dt><IndicatorTooltip label={label} description={description} /></dt><dd>{children}</dd></div>;
}

export function ProviderPulseCard(props: SourceOperationControlsProps & { observedAt: string; recentRate?: RecentRateReading }) {
  const { source, observedAt, recentRate = { state: "unavailable" } } = props;
  const state = pulseState(source);
  const issue = pulseIssue(source);
  const { storage, records, activity } = source.measurements;
  return (
    <article className={`admin-surface provider-pulse__card${pulseNeedsAttention(source) ? " provider-pulse__card--attention" : ""}`}
      aria-labelledby={`provider-pulse-${source.providerId}`} data-provider-id={source.providerId}>
      <div className="provider-pulse__card-overview">
        <header className="provider-pulse__card-header">
          <h2 id={`provider-pulse-${source.providerId}`}>
            <Link to={source.configured ? `/providers/${source.providerId}` : "/source-configuration"}>{source.displayName}</Link>
          </h2>
          <IndicatorTooltip label={state.label} description={state.description} tone={state.tone} />
        </header>
        {issue ? <p className="provider-pulse__issue">{issue}</p> : null}
        {isRecentRateEligible(source) ? (
          <div className="provider-pulse__rate" data-rate-state={recentRate.state} role="group" aria-label="Recent processing rate">
            <IndicatorTooltip label="Recent rate" description={recentRateDescription(recentRate)} />
            <p className="provider-pulse__rate-value"><strong>{recentRateValue(recentRate)}</strong>{recentRate.state === "available" ? <span>records/sec</span> : null}</p>
          </div>
        ) : null}
        <dl className="provider-pulse__metrics">
          <Metric label="Stored rows" description={metricDescriptions.stored}>{count(storage.state === "available" ? storage.counts.total : null)}</Metric>
          <Metric label="Records processed" description={metricDescriptions.processed}>
            {count(records.state === "available" ? records.processed : null)}
            <span className="provider-pulse__subtext">All retained runs</span>
          </Metric>
          <Metric label="Last page" description={metricDescriptions.page}>{activity.state === "available" ? measuredAge(activity.lastCommittedPageAt, observedAt) : "Unavailable"}</Metric>
          <Metric label="Open quarantine" description={metricDescriptions.quarantine}>
            {activity.state === "available" ? <Link to={`/quarantine?providerId=${source.providerId}&state=open`}>{count(activity.quarantine.open)}</Link> : "Unavailable"}
          </Metric>
        </dl>
        {activity.state === "available" ? (
          <p className="provider-pulse__subtext">Page & quarantine checked {measuredAge(activity.historyMeasuredAt, observedAt)}</p>
        ) : null}
      </div>
      <ProviderPulseDetails {...props} />
    </article>
  );
}

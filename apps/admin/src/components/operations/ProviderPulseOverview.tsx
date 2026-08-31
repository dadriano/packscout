import type { ProviderSourceOperationsOverview } from "@packscout/contracts";
import { EmptyState } from "../EmptyState";
import { IndicatorTooltip } from "../IndicatorTooltip";
import { ProviderPulseCard } from "./ProviderPulseCard";
import type { SourceOperationControlsProps } from "./SourceOperationControls";
import { count, measurementTotal, metricDescriptions, pulseNeedsAttention, pulseState, sortPulseSources } from "./provider-pulse-presentation";
import type { RecentRateReading } from "./provider-recent-rate";

export function ProviderPulseOverview({ overview, recentRates = {}, ...controls }: Omit<SourceOperationControlsProps, "source"> & {
  overview: ProviderSourceOperationsOverview;
  recentRates?: Readonly<Record<string, RecentRateReading>>;
}) {
  const sources = sortPulseSources(overview.sources);
  const stored = measurementTotal(sources, "storage");
  const processed = measurementTotal(sources, "records");
  const running = sources.filter((source) => source.processor?.activity === "running"
    && ["Running", "Retrying"].includes(pulseState(source).label)
    && source.measurements.activity.state === "available" && source.measurements.activity.importLease.state === "active").length;
  const attention = sources.filter(pulseNeedsAttention).length;
  return (
    <section className="provider-pulse" aria-label="Provider overview">
      <dl className="provider-pulse__summary" aria-label="Pipeline totals">
        <div><dt><IndicatorTooltip label="Running" description="Providers reporting running activity with a valid database import lease, including retries. A lease does not prove process liveness or committed progress. A running provider can also need attention." /></dt><dd>{count(running)}<span className="provider-pulse__subtext">{sources.length} registered providers</span></dd></div>
        <div><dt><IndicatorTooltip label="Needs attention" description={metricDescriptions.attention} /></dt><dd className={attention > 0 ? "provider-pulse__attention-value" : undefined}>{count(attention)}<span className="provider-pulse__subtext">Shown first below</span></dd></div>
        <div><dt><IndicatorTooltip label="Stored rows" description={metricDescriptions.stored} /></dt><dd>{count(stored.value)}<span className="provider-pulse__subtext">{stored.coverage}</span></dd></div>
        <div><dt><IndicatorTooltip label="Records processed" description={metricDescriptions.processed} /></dt><dd>{count(processed.value)}<span className="provider-pulse__subtext">{processed.coverage} · retained runs</span></dd></div>
      </dl>
      {sources.length === 0 ? <EmptyState title="No providers registered" description="Registered providers appear here when available." /> : (
        <div className="provider-pulse__grid">
          {sources.map((source) => <ProviderPulseCard key={source.providerId} source={source} observedAt={overview.refreshedAt} recentRate={recentRates[source.providerId]} {...controls} />)}
        </div>
      )}
    </section>
  );
}

import { DataSectionGate } from "../components/data-inspection/DataSectionGate";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";

export function CanonicalDataPage() {
  return (
    <DataSectionGate>
      <div className="admin-page">
        <PageHeader
          eyebrow="Data / Canonical"
          title="Canonical data"
          description="What the pipeline landed in PostgreSQL for each provider: per-kind counts, freshness, the records themselves, and one record's current canonical content."
        />
        <EmptyState
          eyebrow="Not built yet"
          title="This surface is not available yet."
          description="Record browsing arrives with the canonical browse task. The section, its permission, and its routes are in place."
        />
      </div>
    </DataSectionGate>
  );
}

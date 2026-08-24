import { DataSectionGate } from "../components/data-inspection/DataSectionGate";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";

export function PublishedDataPage() {
  return (
    <DataSectionGate>
      <div className="admin-page">
        <PageHeader
          eyebrow="Data / Published"
          title="Published data"
          description="What the product actually serves for each provider: the catalog release the active manifest selects, its identity and counts, and the published documents inside it."
        />
        <EmptyState
          eyebrow="Not built yet"
          title="This surface is not available yet."
          description="Release and document browsing arrives with the published browse task. The section, its permission, and its routes are in place."
        />
      </div>
    </DataSectionGate>
  );
}

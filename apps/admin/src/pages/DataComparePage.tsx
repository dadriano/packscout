import { DataSectionGate } from "../components/data-inspection/DataSectionGate";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";

export function DataComparePage() {
  return (
    <DataSectionGate>
      <div className="admin-page">
        <PageHeader
          eyebrow="Data / Compare"
          title="Data comparison"
          description="Whether what the product serves matches what the pipeline landed — a verdict per provider, the evidence behind it, and the specific records that diverge."
        />
        <EmptyState
          eyebrow="Not built yet"
          title="This surface is not available yet."
          description="Parity verdicts and reconciliation arrive with the comparison tasks. The section, its permission, and its routes are in place."
        />
      </div>
    </DataSectionGate>
  );
}

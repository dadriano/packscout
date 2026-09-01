import { promotionJobMonitoringIdSchema } from "@packscout/contracts";
import { Link, useParams } from "react-router-dom";
import { PromotionJobDetail } from "../components/promotion-jobs/PromotionJobDetail";
import { PageHeader } from "../components/PageHeader";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { usePromotionJobDetail } from "../hooks/promotion-jobs/usePromotionJobs";

function ValidPromotionJobDetailPage({ monitoringId }: { monitoringId: string }) {
  const detail = usePromotionJobDetail(monitoringId);
  return (
    <div className="admin-page promotion-page">
      <PageHeader
        eyebrow="Data pipeline / Promotion jobs / Detail"
        title="Promotion job detail"
        description="Bounded, read-only attempt and operation evidence for one promotion invocation."
        actions={<Link className="admin-button admin-button-secondary" to="/promotion-jobs">Back to promotion jobs</Link>}
      />
      {detail.loading && detail.data === null ? (
        <div className="ops-loading" aria-live="polite" aria-busy="true">Loading promotion job evidence…</div>
      ) : null}
      {detail.error ? (
        <div className="ops-error" role="alert">
          <p>
            {detail.error}
            {detail.stale ? " Last safe evidence for this exact job remains below and is marked stale." : ""}
          </p>
          <button type="button" className="admin-button admin-button-secondary" onClick={detail.reload}>Try again</button>
        </div>
      ) : null}
      {detail.refreshing ? <span className="promotion-refreshing" role="status">Refreshing…</span> : null}
      {detail.data ? <PromotionJobDetail detail={detail.data} /> : null}
    </div>
  );
}

export function PromotionJobDetailPage() {
  useDocumentTitle("Convex Promotion Jobs");
  const { monitoringId = "" } = useParams();
  const parsed = promotionJobMonitoringIdSchema.safeParse(monitoringId);
  if (!parsed.success) {
    return (
      <div className="admin-page promotion-page">
        <PageHeader
          eyebrow="Data pipeline / Promotion jobs / Detail"
          title="Promotion job detail"
          description="Bounded, read-only attempt and operation evidence for one promotion invocation."
        />
        <div className="ops-error" role="alert">
          <p>This promotion job link is invalid. No monitoring request was sent.</p>
          <Link className="admin-button admin-button-secondary" to="/promotion-jobs">Back to promotion jobs</Link>
        </div>
      </div>
    );
  }
  return <ValidPromotionJobDetailPage monitoringId={parsed.data} />;
}

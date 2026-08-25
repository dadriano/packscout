import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type {
  CanonicalEntityDetail,
  CanonicalEntityRow,
  CanonicalProviderRow,
  CanonicalProviderSummary,
} from "@packscout/contracts";
import { AdminApiError } from "../api/client";
import {
  getCanonicalSummary,
  listCanonicalEntities,
  listCanonicalProviders,
  readCanonicalEntity,
} from "../api/data-inspection";
import { CanonicalSummary, kindLabel } from "../components/data-inspection/CanonicalSummary";
import {
  DataFilters,
  type AppliedDataFilters,
} from "../components/data-inspection/DataFilters";
import { DataSectionGate } from "../components/data-inspection/DataSectionGate";
import {
  DataGrid,
  GridPagination,
  type DataGridColumn,
  type GridSortDirection,
} from "../components/data-inspection/DataGrid";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

/**
 * What the pipeline landed for one provider.
 *
 * Read-only throughout. The page's job is to be honest about three things an
 * operator will otherwise get wrong: a bounded count is a floor and says so, a
 * failed refresh leaves the previous reading on screen rather than blanking it,
 * and an empty result is distinguished from a failed one.
 *
 * Provider, kind, search, and page position live in the URL so a view can be
 * sent to a colleague and survives a reload.
 */

const DEFAULT_KIND = "pack";
/** Page size the server also defaults to; used to place the range label. */
const PAGE_SIZE = 25;

const COLUMNS: readonly DataGridColumn<CanonicalEntityRow>[] = [
  {
    key: "externalId",
    label: "External identifier",
    sortable: true,
    render: (row) => (
      <span className="grid-table__identifier">{row.externalId}</span>
    ),
  },
  {
    key: "recordKind",
    label: "Kind",
    render: (row) => kindLabel(row.recordKind),
  },
  {
    key: "revision",
    label: "Rev",
    numeric: true,
    render: (row) => row.revisionNumber ?? "—",
  },
  {
    key: "sourceUpdatedAt",
    label: "Provider reported",
    numeric: true,
    render: (row) => dateText(row.sourceUpdatedAt),
  },
  {
    key: "sourceCollectedAt",
    label: "Collected",
    numeric: true,
    render: (row) => dateText(row.sourceCollectedAt),
  },
  {
    key: "acceptedAt",
    label: "Accepted",
    numeric: true,
    render: (row) => dateText(row.acceptedAt),
  },
];

function dateText(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toISOString().replace("T", " ").slice(0, 16);
}

function messageFor(reason: unknown, fallback: string): string {
  if (reason instanceof AdminApiError && reason.status === 403) {
    return "Your operator account no longer includes permission to inspect pipeline data.";
  }
  if (reason instanceof AdminApiError && reason.status === 404) {
    return "That provider is not configured in this workspace.";
  }
  return fallback;
}

function CanonicalDataView() {
  const [params, setParams] = useSearchParams();
  const platformKey = params.get("provider");
  const recordKind = params.get("kind") ?? DEFAULT_KIND;
  const search = params.get("q") ?? "";
  /**
   * The whole trail of page positions, not just the current one.
   *
   * Holding the predecessors in component state meant a shared or reloaded
   * later-page URL came back claiming to be page one with no way back. The
   * trail lives in the URL so a deep link restores the position *and* the
   * ability to walk back from it. Cursors are base64url, so a comma cannot
   * occur inside one and is safe as the separator.
   */
  const cursorTrail = (params.get("cursors") ?? "")
    .split(",")
    .filter((value) => value.length > 0);
  const cursor = cursorTrail.at(-1);
  const direction: GridSortDirection =
    params.get("dir") === "desc" ? "desc" : "asc";

  const trailParam = (trail: readonly string[]): string | undefined =>
    trail.length > 0 ? trail.join(",") : undefined;

  const [providers, setProviders] = useState<CanonicalProviderRow[]>([]);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [providersLoaded, setProvidersLoaded] = useState(false);

  const [summary, setSummary] = useState<CanonicalProviderSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  /**
   * The page and the scope it belongs to travel together.
   *
   * Tracking them separately let a settled page outlive its scope: switching
   * provider or kind left the old rows rendered under the new heading, and if
   * the new request failed they stayed there indefinitely, readable as records
   * belonging to a provider they do not belong to. Binding the rows to the key
   * that produced them makes that state unrepresentable.
   */
  const requestKey = `${platformKey ?? ""}|${recordKind}|${search}|${cursor ?? ""}|${direction}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    rows: CanonicalEntityRow[];
    nextCursor: string | null;
  } | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const current = loaded?.key === requestKey ? loaded : null;
  const rows = current?.rows ?? [];
  const nextCursor = current?.nextCursor ?? null;
  // Loading is derived rather than set on the way into the effect: a
  // synchronous set there schedules a second render before the first paints.
  const listLoading = platformKey !== null && current === null && !listError;
  const listLoaded = current !== null;

  const [detail, setDetail] = useState<CanonicalEntityDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const updateParams = useCallback(
    (next: Record<string, string | undefined>) => {
      setParams((current) => {
        const draft = new URLSearchParams(current);
        for (const [key, value] of Object.entries(next)) {
          if (value === undefined || value === "") draft.delete(key);
          else draft.set(key, value);
        }
        return draft;
      });
    },
    [setParams],
  );

  useEffect(() => {
    const controller = new AbortController();
    listCanonicalProviders(controller.signal)
      .then((result) => {
        setProviders(result.providers);
        setProviderError(null);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setProviderError(
          messageFor(reason, "The provider list is temporarily unavailable."),
        );
      })
      .finally(() => setProvidersLoaded(true));
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!platformKey) return;
    const controller = new AbortController();
    getCanonicalSummary(platformKey, controller.signal)
      .then((result) => {
        setSummary(result);
        setSummaryError(null);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        // The previous reading stays on screen; only the notice changes.
        setSummaryError(
          messageFor(reason, "The record summary could not be refreshed."),
        );
      });
    return () => controller.abort();
  }, [platformKey]);

  useEffect(() => {
    if (!platformKey) return;
    const controller = new AbortController();
    listCanonicalEntities(
      { platformKey, recordKind, search: search || undefined, cursor, direction },
      controller.signal,
    )
      .then((page) => {
        setLoaded({
          key: requestKey,
          rows: [...page.items],
          nextCursor: page.nextCursor,
        });
        setListError(null);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        // Drop whatever was loaded for the previous scope. Leaving it would
        // present another provider's records under this provider's heading.
        setLoaded(null);
        setListError(
          messageFor(reason, "These records could not be loaded."),
        );
      })
    return () => controller.abort();
  }, [platformKey, recordKind, search, cursor, direction, requestKey]);

  const kindSummary = summary?.kinds.find(
    (entry) => entry.recordKind === recordKind,
  );
  const kindTotal = kindSummary?.count ?? null;
  const kindTotalIsFloor = kindSummary?.precision === "at_least";
  const pageStart = cursorTrail.length * PAGE_SIZE + 1;

  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.platformKey === platformKey),
    [providers, platformKey],
  );

  function openRecord(row: CanonicalEntityRow) {
    setDetail(null);
    setDetailError(null);
    readCanonicalEntity({
      platformKey: row.platformKey,
      recordKind: row.recordKind,
      externalId: row.externalId,
    })
      .then(setDetail)
      .catch((reason: unknown) => {
        setDetailError(messageFor(reason, "That record could not be read."));
      });
  }

  return (
    <div className="admin-page">
      <PageHeader
        eyebrow="Data / Canonical"
        title="Canonical data"
        description="What the pipeline landed in PostgreSQL for each provider: per-kind counts, freshness, the records themselves, and one record's current canonical content. Read-only."
      />

      {providerError ? (
        <p className="admin-notice" role="alert">
          {providerError}
        </p>
      ) : null}

      {providersLoaded && providers.length === 0 && !providerError ? (
        <EmptyState
          title="No providers are configured yet."
          description="Configure a provider before there is canonical data to inspect."
        />
      ) : null}

      {providers.length > 0 ? (
        <DataFilters
          providers={providers}
          summary={summary}
          pending={listLoading}
          applied={{
            platformKey: platformKey ?? "",
            recordKind,
            search,
          }}
          onApply={(next: AppliedDataFilters) => {
            setDetail(null);
            updateParams({
              provider: next.platformKey,
              kind: next.recordKind,
              q: next.search.trim(),
              cursors: undefined,
            });
          }}
          onReset={() => {
            setDetail(null);
            updateParams({ q: undefined, cursors: undefined });
          }}
        />
      ) : null}

      {!platformKey && providers.length > 0 ? (
        <EmptyState
          eyebrow="Nothing selected"
          title="Choose a provider to inspect."
          description="Its record counts, freshness, and the records themselves appear here."
        />
      ) : null}

      {platformKey && summaryError ? (
        <p className="admin-notice" data-tone="warning" role="alert">
          {summaryError}
        </p>
      ) : null}

      {platformKey && Array.isArray(summary?.kinds) ? (
        <CanonicalSummary summary={summary} selectedKind={recordKind} />
      ) : null}

      {platformKey ? (
        <>
          {listError ? (
            <p className="admin-notice" role="alert">
              {listError}
            </p>
          ) : null}

          {listLoading && !listLoaded ? (
            <p aria-live="polite" aria-busy="true">
              Loading records…
            </p>
          ) : null}

          {listLoaded && rows.length === 0 && !listError ? (
            <EmptyState
              eyebrow={search ? "No matches" : "Nothing landed"}
              title={
                search
                  ? "No record matches that identifier."
                  : `No ${kindLabel(recordKind).toLowerCase()} for this provider.`
              }
              description={
                search
                  ? "Check the identifier, or reset the filters to page through every record of this kind."
                  : "The pipeline has not landed a record of this kind for this provider yet."
              }
            />
          ) : null}

          {rows.length > 0 ? (
            <>
              <DataGrid
                eyebrow={selectedProvider?.displayName ?? platformKey}
                title={kindLabel(recordKind)}
                columns={COLUMNS}
                rows={rows}
                rowKey={(row) => row.entityId}
                sortedKey="externalId"
                direction={direction}
                onSort={(_key, next) =>
                  updateParams({
                    dir: next === "desc" ? "desc" : undefined,
                    cursors: undefined,
                  })
                }
                selectedKey={detail?.entityId ?? null}
                onSelect={openRecord}
                orderStatus={`Ordered by identifier, ${
                  direction === "asc" ? "ascending" : "descending"
                }`}
              />
              <GridPagination
                start={pageStart}
                end={pageStart + rows.length - 1}
                total={kindTotal}
                totalIsFloor={kindTotalIsFloor}
                hasPrevious={cursorTrail.length > 0}
                hasNext={Boolean(nextCursor)}
                pending={listLoading}
                onPrevious={() =>
                  updateParams({ cursors: trailParam(cursorTrail.slice(0, -1)) })
                }
                onNext={() => {
                  if (!nextCursor) return;
                  updateParams({
                    cursors: trailParam([...cursorTrail, nextCursor]),
                  });
                }}
              />
            </>
          ) : null}
        </>
      ) : null}

      {detailError ? (
        <p className="admin-notice" role="alert">
          {detailError}
        </p>
      ) : null}

      {detail ? (
        <section className="inspect-detail" aria-labelledby="canonical-detail-title">
          <header className="admin-section-header">
            <div>
              <span className="admin-kicker">Current revision</span>
              <h2 id="canonical-detail-title">{detail.externalId}</h2>
            </div>
            <button
              type="button"
              className="admin-button admin-button-secondary"
              onClick={() => setDetail(null)}
            >
              Close
            </button>
          </header>
          <dl className="inspect-detail__facts">
            <div>
              <dt>Revision</dt>
              <dd>{detail.revisionNumber ?? "—"}</dd>
            </div>
            <div>
              <dt>Content hash</dt>
              <dd className="inspect-detail__hash">{detail.contentHash ?? "—"}</dd>
            </div>
            <div>
              <dt>Provenance hash</dt>
              <dd className="inspect-detail__hash">
                {detail.provenanceHash ?? "—"}
              </dd>
            </div>
            <div>
              <dt>Provider reported</dt>
              <dd>{dateText(detail.sourceUpdatedAt)}</dd>
            </div>
            <div>
              <dt>Collected</dt>
              <dd>{dateText(detail.sourceCollectedAt)}</dd>
            </div>
            <div>
              <dt>Accepted</dt>
              <dd>{dateText(detail.acceptedAt)}</dd>
            </div>
          </dl>

          {detail.provenance ? (
            <div className="inspect-detail__provenance">
              <h3>Where it came from</h3>
              <dl>
                <div>
                  <dt>Source record</dt>
                  <dd>{detail.provenance.sourceRecordId ?? "—"}</dd>
                </div>
                <div>
                  <dt>Import run</dt>
                  <dd>{detail.provenance.importRunId ?? "—"}</dd>
                </div>
                <div>
                  <dt>Mapper</dt>
                  <dd>
                    {detail.provenance.mapperKey ?? "—"}
                    {detail.provenance.mapperVersion
                      ? ` v${detail.provenance.mapperVersion}`
                      : ""}
                  </dd>
                </div>
                <div>
                  <dt>Adapter</dt>
                  <dd>{detail.provenance.adapterKey ?? "—"}</dd>
                </div>
              </dl>
            </div>
          ) : null}

          <h3>Canonical content</h3>
          <pre className="inspect-detail__content">
            {JSON.stringify(detail.content, null, 2)}
          </pre>

          <h3>Declared relationships</h3>
          {detail.relationships.length === 0 ? (
            <p>This record declares no relationships.</p>
          ) : (
            <ul className="inspect-detail__edges">
              {detail.relationships.map((edge) => (
                <li
                  key={`${edge.relationshipKind}:${edge.targetPlatformKey}:${edge.targetExternalId ?? ""}`}
                >
                  <strong>{edge.relationshipKind}</strong> →{" "}
                  {edge.targetPlatformKey}/{edge.targetRecordKind}/
                  {edge.targetExternalId ?? "—"}{" "}
                  <span>{edge.resolved ? "resolved" : "unresolved"}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}

export function CanonicalDataPage() {
  useDocumentTitle("Canonical Data");
  return (
    <DataSectionGate>
      <CanonicalDataView />
    </DataSectionGate>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type {
  CanonicalProviderRow,
  PublishedActiveRelease,
  PublishedEntityRow,
  PublishedInspectableEntityKind,
  PublishedProviderChaseReconciliation,
  PublishedProviderDocument,
  PublishedProviderEntityPage,
} from "@packscout/contracts";
import { publishedInspectableEntityKinds } from "@packscout/contracts";
import { AdminApiError } from "../api/client";
import {
  getPublishedActiveRelease,
  listCanonicalProviders,
  listPublishedEntities,
  readPublishedChaseReconciliation,
  readPublishedDocument,
} from "../api/data-inspection";
import { DataSectionGate } from "../components/data-inspection/DataSectionGate";
import { DataGrid, type DataGridColumn } from "../components/data-inspection/DataGrid";
import { ProviderPicker } from "../components/data-inspection/ProviderPicker";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

const DEFAULT_KIND: PublishedInspectableEntityKind = "repacks";
const PAGE_SIZE = 50;

const KIND_LABELS: Readonly<Record<PublishedInspectableEntityKind, string>> = {
  vendors: "Vendors",
  categories: "Categories",
  repacks: "Repacks",
  collectibles: "Collectibles",
};

type ReadFailure = Readonly<{
  kind: "forbidden" | "invalid_cursor" | "missing_provider" | "unavailable";
  message: string;
}>;

function readFailure(
  reason: unknown,
  fallback: string,
  invalidCursorExpected = false,
): ReadFailure {
  if (reason instanceof AdminApiError && reason.status === 403) {
    return {
      kind: "forbidden",
      message:
        "Your operator account no longer includes permission to inspect published data.",
    };
  }
  if (reason instanceof AdminApiError && reason.status === 404) {
    return {
      kind: "missing_provider",
      message: "That provider is not configured in this workspace.",
    };
  }
  if (
    invalidCursorExpected &&
    reason instanceof AdminApiError &&
    reason.status === 400
  ) {
    return {
      kind: "invalid_cursor",
      message:
        "This published page cursor is invalid or no longer belongs to the active release.",
    };
  }
  return { kind: "unavailable", message: fallback };
}

function dateText(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toISOString();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstText(
  record: Record<string, unknown> | null,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function rowIdentity(row: PublishedEntityRow): string {
  const detail = asRecord(row.detail);
  return (
    firstText(detail, ["displayName", "name", "label", "title"]) ??
    "Published document"
  );
}

function rowContext(row: PublishedEntityRow): string {
  const detail = asRecord(row.detail);
  const values = [
    firstText(detail, ["vendorKey", "vendorDisplayName", "collectibleType"]),
    firstText(detail, ["availability", "state", "slug"]),
  ].filter((value): value is string => value !== null);
  return values.length > 0 ? values.join(" · ") : "—";
}

const PUBLISHED_COLUMNS: readonly DataGridColumn<PublishedEntityRow>[] = [
  {
    key: "publicEntityId",
    label: "Public identifier",
    render: (row) => (
      <span className="grid-table__identifier">{row.publicEntityId}</span>
    ),
  },
  { key: "identity", label: "Identity", render: rowIdentity },
  { key: "context", label: "Published context", render: rowContext },
];

function lifecycleClass(lifecycle: string): string {
  if (lifecycle === "complete") return "admin-pill admin-pill-success";
  if (lifecycle === "failed") return "admin-pill admin-pill-danger";
  return "admin-pill admin-pill-warning";
}

function ReleaseFacts({
  release,
}: {
  release: Extract<PublishedActiveRelease, { status: "active" }>;
}) {
  const facts = release.release;
  const counts = facts.counts;
  const countCards = [
    ["Vendors", counts.vendors],
    ["Categories", counts.categories],
    ["Repacks", counts.repacks],
    ["Collectibles", counts.collectibles],
    ["Chase edges", counts.repackChases],
    ["Search shards", counts.searchShards],
  ] as const;

  return (
    <section
      className="admin-surface admin-panel published-release"
      aria-labelledby="published-release-title"
    >
      <header className="published-release__header">
        <div>
          <span className="admin-kicker">Active manifest selection</span>
          <h2 id="published-release-title">Provider release</h2>
        </div>
        <span className={lifecycleClass(facts.lifecycle)}>{facts.lifecycle}</span>
      </header>

      {facts.lifecycle !== "complete" ? (
        <aside className="admin-note admin-note-warning" role="note">
          The active manifest references a {facts.lifecycle} release. Its records
          remain inspectable evidence, but this page does not present them as a
          completed publication.
        </aside>
      ) : null}

      <dl className="published-release__facts">
        <div><dt>Platform</dt><dd>{facts.platformKey}</dd></div>
        <div><dt>Provider release</dt><dd className="published-mono">{facts.publicProviderReleaseId}</dd></div>
        <div><dt>Catalog manifest</dt><dd className="published-mono">{release.manifestPublicReleaseId}</dd></div>
        <div><dt>Data as of</dt><dd>{dateText(facts.dataAsOf)}</dd></div>
        <div><dt>Created</dt><dd>{dateText(facts.createdAt)}</dd></div>
        <div><dt>Completed</dt><dd>{dateText(facts.completedAt)}</dd></div>
        <div><dt>Batches</dt><dd>{facts.batchCount.toLocaleString("en-US")}</dd></div>
        <div><dt>Completion operation</dt><dd className="published-mono">{facts.completionOperationId ?? "—"}</dd></div>
      </dl>

      <div
        className="published-release__hashes"
        aria-label="Release fingerprints and hashes"
      >
        <div><span>Manifest reference fingerprint</span><code>{release.referenceFingerprint}</code></div>
        <div><span>Provider release fingerprint</span><code>{facts.providerReleaseFingerprint}</code></div>
        <div><span>Content hash</span><code>{facts.contentHash}</code></div>
        <div><span>Batch chain hash</span><code>{facts.batchChainHash}</code></div>
        {Object.entries(facts.entityHashes).map(([kind, hash]) => (
          <div key={kind}>
            <span>{kind.replaceAll("_", " ")} hash</span>
            <code>{hash}</code>
          </div>
        ))}
      </div>

      <div className="published-counts" aria-label="Published release counts">
        {countCards.map(([label, count]) => (
          <article className="published-count" key={label}>
            <span>{label}</span>
            <strong>{count.toLocaleString("en-US")}</strong>
          </article>
        ))}
      </div>
    </section>
  );
}

function PublishedAbsence({
  result,
  providerName,
}: {
  result: Exclude<PublishedActiveRelease, { status: "active" }>;
  providerName: string;
}) {
  if (result.status === "no_active_manifest") {
    return (
      <EmptyState
        eyebrow="No active manifest"
        title="The product has no active catalog manifest."
        description="No provider can truthfully be shown as published until a catalog manifest is activated. This is not a zero-record release."
      />
    );
  }
  if (result.status === "platform_not_referenced") {
    return (
      <EmptyState
        eyebrow="Platform absent"
        title={`Nothing is published for ${providerName}.`}
        description={`Active manifest ${result.manifestPublicReleaseId} does not reference this platform. The pipeline may not have promoted it yet; no zero counts are inferred.`}
      />
    );
  }
  return (
    <EmptyState
      eyebrow="Release missing"
      title="The manifest points to a release the backend cannot read."
      description={`Manifest ${result.manifestPublicReleaseId} names provider release ${result.publicProviderReleaseId}. Treat this as an inconsistent published state, not an empty release.`}
    />
  );
}

function DocumentDetail({
  row,
  document,
  documentError,
  chase,
  chaseError,
  showChase,
}: {
  row: PublishedEntityRow;
  document: PublishedProviderDocument | null;
  documentError: string | null;
  chase: PublishedProviderChaseReconciliation | null;
  chaseError: string | null;
  showChase: boolean;
}) {
  return (
    <div className="published-document">
      <section aria-labelledby={`published-document-${row.publicEntityId}`}>
        <h3 id={`published-document-${row.publicEntityId}`}>
          Stored published document
        </h3>
        {documentError ? (
          <p className="admin-note admin-note-danger" role="alert">
            {documentError}
          </p>
        ) : null}
        {!document && !documentError ? (
          <p aria-live="polite" aria-busy="true">Loading document…</p>
        ) : null}
        {document?.status === "ok" ? (
          <pre className="record-detail__content">
            {JSON.stringify(document.detail, null, 2)}
          </pre>
        ) : null}
        {document?.status === "not_present" ? (
          <p>
            This public identifier is not present in the release selected by
            the active manifest.
          </p>
        ) : null}
        {document &&
        document.status !== "ok" &&
        document.status !== "not_present" ? (
          <p>
            The active published release changed while this document was being
            read. Close the row and open it again.
          </p>
        ) : null}
      </section>

      {showChase ? (
        <section aria-labelledby={`published-chases-${row.publicEntityId}`}>
          <h3 id={`published-chases-${row.publicEntityId}`}>
            Chase reconciliation
          </h3>
          <p>
            Chases are release edges, not synthetic standalone entities. This
            is the publication record for their parent repack.
          </p>
          {chaseError ? (
            <p className="admin-note admin-note-danger" role="alert">
              {chaseError}
            </p>
          ) : null}
          {!chase && !chaseError ? (
            <p aria-live="polite" aria-busy="true">
              Loading chase reconciliation…
            </p>
          ) : null}
          {chase?.status === "ok" ? (
            <dl className="published-chase-facts">
              <div><dt>Expected</dt><dd>{chase.expectedChaseCount.toLocaleString("en-US")}</dd></div>
              <div><dt>Accepted</dt><dd>{chase.acceptedChaseCount.toLocaleString("en-US")}</dd></div>
              <div>
                <dt>Result</dt>
                <dd>
                  <span className={chase.complete ? "admin-pill admin-pill-success" : "admin-pill admin-pill-warning"}>
                    {chase.complete ? "complete" : "incomplete"}
                  </span>
                </dd>
              </div>
            </dl>
          ) : null}
          {chase?.status === "not_present" ? (
            <p>No chase reconciliation was recorded for this repack.</p>
          ) : null}
          {chase && chase.status !== "ok" && chase.status !== "not_present" ? (
            <p>The active release changed before chase reconciliation completed.</p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function PublishedDataView() {
  const [params, setParams] = useSearchParams();
  const platformKey = params.get("provider");
  const rawKind = params.get("kind") ?? DEFAULT_KIND;
  const kindValid = publishedInspectableEntityKinds.includes(
    rawKind as PublishedInspectableEntityKind,
  );
  const entityKind = kindValid
    ? (rawKind as PublishedInspectableEntityKind)
    : DEFAULT_KIND;
  const requestedCursor = params.get("cursor");
  const rawPage = Number(params.get("page") ?? "1");
  const normalizedCursor = requestedCursor?.trim() ? requestedCursor : null;
  const hasPagedCursor = Boolean(
    normalizedCursor && Number.isSafeInteger(rawPage) && rawPage > 1,
  );
  const cursor = hasPagedCursor ? normalizedCursor : null;
  const page = hasPagedCursor ? rawPage : 1;

  const [providers, setProviders] = useState<readonly CanonicalProviderRow[]>([]);
  const [providersLoaded, setProvidersLoaded] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const providerAllowed = providers.some(
    (provider) => provider.platformKey === platformKey,
  );
  const selectedProvider = providers.find(
    (provider) => provider.platformKey === platformKey,
  );

  const [refreshVersion, setRefreshVersion] = useState(0);
  const releaseKey = platformKey ?? "";
  const [releaseLoaded, setReleaseLoaded] = useState<{
    key: string;
    value: PublishedActiveRelease;
  } | null>(null);
  const [releaseFailed, setReleaseFailed] = useState<{
    key: string;
    failure: ReadFailure;
  } | null>(null);
  const release =
    releaseLoaded?.key === releaseKey ? releaseLoaded.value : null;
  const releaseFailure =
    releaseFailed?.key === releaseKey ? releaseFailed.failure : null;
  const releaseLoading = Boolean(
    platformKey && providerAllowed && !release && !releaseFailure,
  );

  const activeRelease = release?.status === "active" ? release : null;
  const activeProviderReleaseId =
    activeRelease?.release.publicProviderReleaseId ?? null;
  const entityScope = activeProviderReleaseId
    ? `${platformKey}|${activeProviderReleaseId}|${entityKind}|${cursor ?? ""}|${page}`
    : "";
  const [entityLoaded, setEntityLoaded] = useState<{
    key: string;
    value: PublishedProviderEntityPage;
  } | null>(null);
  const [entityFailed, setEntityFailed] = useState<{
    key: string;
    failure: ReadFailure;
  } | null>(null);
  const entityPage =
    entityLoaded?.key === entityScope ? entityLoaded.value : null;
  const entityFailure =
    entityFailed?.key === entityScope ? entityFailed.failure : null;
  const entityLoading = Boolean(
    activeProviderReleaseId && kindValid && !entityPage && !entityFailure,
  );

  const [expanded, setExpanded] = useState<{
    scope: string;
    id: string;
  } | null>(null);
  const expandedId = expanded?.scope === entityScope ? expanded.id : null;
  const [documentLoaded, setDocumentLoaded] = useState<{
    key: string;
    value: PublishedProviderDocument;
  } | null>(null);
  const [documentFailed, setDocumentFailed] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const [chaseLoaded, setChaseLoaded] = useState<{
    key: string;
    value: PublishedProviderChaseReconciliation;
  } | null>(null);
  const [chaseFailed, setChaseFailed] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const detailRequest = useRef<AbortController | null>(null);
  const [cursorsByPage, setCursorsByPage] = useState<
    ReadonlyMap<string, string | null>
  >(() => new Map());

  useEffect(
    () => () => {
      detailRequest.current?.abort();
      detailRequest.current = null;
    },
    [entityScope],
  );

  const updateParams = useCallback(
    (next: Record<string, string | undefined>) => {
      setParams((current) => {
        const draft = new URLSearchParams(current);
        for (const [key, value] of Object.entries(next)) {
          if (!value) draft.delete(key);
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
          readFailure(
            reason,
            "The shared provider roster is temporarily unavailable.",
          ).message,
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setProvidersLoaded(true);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!platformKey || !providerAllowed) return;
    const controller = new AbortController();
    getPublishedActiveRelease(platformKey, controller.signal)
      .then((value) => {
        setReleaseLoaded({ key: platformKey, value });
        setReleaseFailed((current) =>
          current?.key === platformKey ? null : current,
        );
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setReleaseFailed({
          key: platformKey,
          failure: readFailure(
            reason,
            "The product backend is temporarily unreachable. Prior safe results remain visible when available.",
          ),
        });
      });
    return () => controller.abort();
  }, [platformKey, providerAllowed, refreshVersion]);

  useEffect(() => {
    if (!activeProviderReleaseId || !platformKey || !kindValid) return;
    const requestKey = entityScope;
    const controller = new AbortController();
    listPublishedEntities(
      {
        platformKey,
        publicProviderReleaseId: activeProviderReleaseId,
        entityKind,
        limit: PAGE_SIZE,
        cursor,
      },
      controller.signal,
    )
      .then((value) => {
        setCursorsByPage((current) => {
          const next = new Map(current);
          next.set(
            `${platformKey}|${activeProviderReleaseId}|${entityKind}|${page}`,
            cursor,
          );
          return next;
        });
        setEntityLoaded({ key: requestKey, value });
        setEntityFailed((current) =>
          current?.key === requestKey ? null : current,
        );
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setEntityFailed({
          key: requestKey,
          failure: readFailure(
            reason,
            "Published documents could not be refreshed. Prior safe results remain visible when available.",
            true,
          ),
        });
      });
    return () => controller.abort();
  }, [
    activeProviderReleaseId,
    platformKey,
    entityKind,
    cursor,
    page,
    entityScope,
    kindValid,
    refreshVersion,
  ]);

  function openDocument(row: PublishedEntityRow) {
    if (!platformKey || !activeProviderReleaseId) return;
    if (expandedId === row.publicEntityId) {
      detailRequest.current?.abort();
      detailRequest.current = null;
      setExpanded(null);
      return;
    }
    detailRequest.current?.abort();
    const controller = new AbortController();
    detailRequest.current = controller;
    setExpanded({ scope: entityScope, id: row.publicEntityId });
    const requestKey = `${entityScope}|${row.publicEntityId}`;
    readPublishedDocument(
      {
        platformKey,
        publicProviderReleaseId: activeProviderReleaseId,
        entityKind,
        publicEntityId: row.publicEntityId,
      },
      controller.signal,
    )
      .then((value) => {
        if (controller.signal.aborted) return;
        setDocumentLoaded({ key: requestKey, value });
        setDocumentFailed((current) =>
          current?.key === requestKey ? null : current,
        );
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setDocumentFailed({
          key: requestKey,
          message: readFailure(
            reason,
            "That published document could not be read.",
          ).message,
        });
      });
    if (entityKind === "repacks") {
      readPublishedChaseReconciliation(
        {
          platformKey,
          publicProviderReleaseId: activeProviderReleaseId,
          publicRepackId: row.publicEntityId,
        },
        controller.signal,
      )
        .then((value) => {
          if (controller.signal.aborted) return;
          setChaseLoaded({ key: requestKey, value });
          setChaseFailed((current) =>
            current?.key === requestKey ? null : current,
          );
        })
        .catch((reason: unknown) => {
          if (controller.signal.aborted) return;
          setChaseFailed({
            key: requestKey,
            message: readFailure(
              reason,
              "Chase reconciliation could not be read.",
            ).message,
          });
        });
    }
  }

  const rows = entityPage?.status === "ok" ? entityPage.items : [];
  function movePage(nextPage: number) {
    if (nextPage <= 1) {
      updateParams({ cursor: undefined, page: undefined });
      return;
    }
    if (
      nextPage === page + 1 &&
      entityPage?.status === "ok" &&
      !entityPage.isDone &&
      entityPage.continueCursor.length > 0
    ) {
      updateParams({
        cursor: entityPage.continueCursor,
        page: String(nextPage),
      });
      return;
    }
    const previousCursor = cursorsByPage.get(
      `${platformKey}|${activeProviderReleaseId}|${entityKind}|${nextPage}`,
    );
    if (previousCursor === undefined) {
      updateParams({ cursor: undefined, page: undefined });
      return;
    }
    updateParams({
      cursor: previousCursor ?? undefined,
      page: nextPage > 1 ? String(nextPage) : undefined,
    });
  }

  return (
    <div className="admin-page">
      <PageHeader
        eyebrow="Data / Published"
        title="Published data"
        description="What the product actually serves for each provider: the active manifest selection, release evidence, and stored published documents. Read-only."
        actions={
          platformKey ? (
            <button
              className="admin-button admin-button-secondary"
              disabled={releaseLoading || entityLoading}
              onClick={() => setRefreshVersion((value) => value + 1)}
              type="button"
            >
              Refresh read
            </button>
          ) : undefined
        }
      />

      <aside className="admin-note published-scope" role="note">
        <strong>Published scope.</strong> Vendors, categories, repacks,
        collectibles, and repack-to-collectible chase edges reach the product
        backend. Pulls, market events and sales, EV inputs, estimated-EV records,
        and quarantine stay pipeline-only. Chase edges have no standalone public
        identity; their release count and per-repack reconciliation are shown
        without inventing one.
      </aside>

      {providerError ? (
        <p className="admin-note admin-note-danger" role="alert">
          {providerError}
        </p>
      ) : null}
      {providersLoaded && providers.length === 0 && !providerError ? (
        <EmptyState
          title="No providers are configured yet."
          description="Configure a provider before there is published data to inspect."
        />
      ) : null}
      {providers.length > 0 ? (
        <ProviderPicker
          providers={providers}
          selected={providerAllowed ? platformKey : null}
          onSelect={(nextPlatformKey) =>
            updateParams({
              provider: nextPlatformKey,
              cursor: undefined,
              page: undefined,
            })
          }
        />
      ) : null}

      {providersLoaded && !providerError && platformKey && !providerAllowed ? (
        <EmptyState
          eyebrow="Provider unavailable"
          title="That provider is not in this workspace roster."
          description="Choose a provider from the shared Data roster. Published reads are tenant-scoped and will not inspect an arbitrary platform key."
        />
      ) : null}
      {!platformKey && providers.length > 0 ? (
        <EmptyState
          eyebrow="Nothing selected"
          title="Choose a provider to inspect."
          description="The active manifest selection, release hashes, counts, and documents appear here."
        />
      ) : null}

      {releaseFailure ? (
        <aside
          className={
            releaseFailure.kind === "forbidden"
              ? "admin-note admin-note-danger"
              : "admin-note admin-note-warning"
          }
          role="alert"
        >
          {releaseFailure.message}
        </aside>
      ) : null}
      {releaseLoading ? (
        <p aria-live="polite" aria-busy="true">
          Reading the active published release…
        </p>
      ) : null}
      {release && release.status !== "active" ? (
        <PublishedAbsence
          result={release}
          providerName={selectedProvider?.displayName ?? platformKey ?? "this provider"}
        />
      ) : null}

      {activeRelease ? (
        <>
          <ReleaseFacts release={activeRelease} />

          {!kindValid ? (
            <EmptyState
              eyebrow="Invalid entity kind"
              title="This published catalog link cannot be applied."
              description="Choose vendors, categories, repacks, or collectibles. Chase edges are reconciled through their parent repack."
              action={
                <button
                  className="admin-button admin-button-secondary"
                  onClick={() =>
                    updateParams({
                      kind: DEFAULT_KIND,
                      cursor: undefined,
                      page: undefined,
                    })
                  }
                  type="button"
                >
                  Browse repacks
                </button>
              }
            />
          ) : (
            <section
              className="published-browser"
              aria-labelledby="published-browser-title"
            >
              <header className="published-browser__toolbar">
                <div>
                  <span className="admin-kicker">Release contents</span>
                  <h2 id="published-browser-title">
                    Browse published documents
                  </h2>
                </div>
                <label
                  className="published-browser__kind"
                  htmlFor="published-kind"
                >
                  <span>Entity kind</span>
                  <select
                    id="published-kind"
                    value={entityKind}
                    onChange={(event) =>
                      updateParams({
                        kind: event.target.value,
                        cursor: undefined,
                        page: undefined,
                      })
                    }
                  >
                    {publishedInspectableEntityKinds.map((kind) => (
                      <option key={kind} value={kind}>
                        {KIND_LABELS[kind]}
                      </option>
                    ))}
                  </select>
                </label>
              </header>

              {entityFailure ? (
                <aside
                  className={
                    entityFailure.kind === "forbidden"
                      ? "admin-note admin-note-danger"
                      : "admin-note admin-note-warning"
                  }
                  role="alert"
                >
                  {entityFailure.message}
                  {entityFailure.kind === "invalid_cursor" ? (
                    <button
                      className="admin-button admin-button-secondary admin-button-sm"
                      onClick={() => movePage(1)}
                      type="button"
                    >
                      Return to first page
                    </button>
                  ) : null}
                </aside>
              ) : null}
              {entityLoading ? (
                <p aria-live="polite" aria-busy="true">
                  Loading {KIND_LABELS[entityKind].toLowerCase()}…
                </p>
              ) : null}
              {entityPage && entityPage.status !== "ok" ? (
                <p className="admin-note admin-note-warning" role="alert">
                  The active manifest selection changed while this page was
                  loading. Refresh the published read before continuing.
                </p>
              ) : null}
              {entityPage?.status === "ok" && rows.length === 0 ? (
                <EmptyState
                  eyebrow="Empty published kind"
                  title={`This release contains no ${KIND_LABELS[entityKind].toLowerCase()}.`}
                  description="The backend reported an empty kind for this release. This is distinct from an unavailable read."
                />
              ) : null}
              {rows.length > 0 ? (
                <>
                  <DataGrid
                    eyebrow={`${selectedProvider?.displayName ?? platformKey} · page ${page.toLocaleString("en-US")}`}
                    title={KIND_LABELS[entityKind]}
                    columns={PUBLISHED_COLUMNS}
                    rows={rows}
                    rowKey={(row) => row.publicEntityId}
                    expandedKey={expandedId}
                    onToggleExpand={openDocument}
                    renderExpanded={(row) => {
                      const key = `${entityScope}|${row.publicEntityId}`;
                      const document =
                        documentLoaded?.key === key
                          ? documentLoaded.value
                          : null;
                      const documentError =
                        documentFailed?.key === key
                          ? documentFailed.message
                          : null;
                      const chase =
                        chaseLoaded?.key === key ? chaseLoaded.value : null;
                      const chaseError =
                        chaseFailed?.key === key
                          ? chaseFailed.message
                          : null;
                      return (
                        <DocumentDetail
                          row={row}
                          document={document}
                          documentError={documentError}
                          chase={chase}
                          chaseError={chaseError}
                          showChase={entityKind === "repacks"}
                        />
                      );
                    }}
                    orderStatus="Ordered by public identifier, ascending"
                    minWidth="52rem"
                  />
                  <nav
                    className="published-pagination"
                    aria-label="Published entity pages"
                  >
                    <p aria-live="polite">
                      Page {page.toLocaleString("en-US")} ·{" "}
                      {rows.length.toLocaleString("en-US")} records on this page
                    </p>
                    <div>
                      <button
                        className="admin-button admin-button-secondary"
                        disabled={page <= 1 || entityLoading}
                        onClick={() => movePage(1)}
                        type="button"
                      >
                        « First
                      </button>
                      <button
                        className="admin-button admin-button-secondary"
                        disabled={
                          page <= 1 ||
                          entityLoading ||
                          !cursorsByPage.has(
                            `${platformKey}|${activeProviderReleaseId}|${entityKind}|${page - 1}`,
                          )
                        }
                        onClick={() => movePage(page - 1)}
                        type="button"
                      >
                        ← Previous
                      </button>
                      <button
                        className="admin-button admin-button-secondary"
                        disabled={
                          entityPage?.status !== "ok" ||
                          entityPage.isDone ||
                          entityPage.continueCursor.length === 0 ||
                          entityLoading
                        }
                        onClick={() => movePage(page + 1)}
                        type="button"
                      >
                        Next →
                      </button>
                    </div>
                  </nav>
                </>
              ) : null}
            </section>
          )}
        </>
      ) : null}
    </div>
  );
}

export function PublishedDataPage() {
  useDocumentTitle("Published Data");
  return (
    <DataSectionGate>
      <PublishedDataView />
    </DataSectionGate>
  );
}

import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import type {
  CreateProviderRequest,
  ProviderConfigurationSummary,
  ReplaceProviderRevisionRequest,
} from "@packscout/contracts";
import { AdminApiError } from "../api/client";
import { createProvider, getProvider, replaceProviderRevision } from "../api/providers";
import { PageHeader } from "../components/PageHeader";
import { ProviderForm } from "../components/providers/ProviderForm";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useSession } from "../providers/session";
import { useToast } from "../providers/toast";

function errorMessage(error: unknown): string {
  if (error instanceof AdminApiError) {
    if (error.code === "CONFIG_REVISION_CONFLICT") {
      return "A newer revision was saved by another administrator. Your entries are still here. Reload the current configuration before saving again.";
    }
    return error.message;
  }
  return "The provider could not be saved. Your entries are still here.";
}

export function ProviderFormPage() {
  const { providerId } = useParams();
  const editing = Boolean(providerId);
  useDocumentTitle(editing ? "Revise Provider" : "Add Provider");
  const navigate = useNavigate();
  const { showToast } = useToast();
  const { status } = useSession();
  const canManage = status.phase === "authenticated" && status.session.permissions.includes("providers:manage");
  const [provider, setProvider] = useState<ProviderConfigurationSummary | null>(null);
  const [loading, setLoading] = useState(editing);
  const [pending, setPending] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  useEffect(() => {
    if (!providerId) return;
    let active = true;
    void getProvider(providerId)
      .then((result) => { if (active) setProvider(result.provider); })
      .catch((reason: unknown) => { if (active) setError(errorMessage(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [providerId]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  if (!canManage) return <Navigate to="/providers" replace />;

  async function save(value: CreateProviderRequest | ReplaceProviderRevisionRequest): Promise<void> {
    setPending(true);
    setError(null);
    setConflict(false);
    try {
      const result = providerId
        ? await replaceProviderRevision(providerId, value as ReplaceProviderRevisionRequest)
        : await createProvider(value as CreateProviderRequest);
      setDirty(false);
      showToast(providerId ? `Revision ${result.provider.latestRevision.version} saved.` : `${result.provider.displayName} created as a draft.`);
      navigate(`/providers/${result.provider.id}`, { replace: true });
    } catch (reason) {
      setError(errorMessage(reason));
      setConflict(reason instanceof AdminApiError && reason.code === "CONFIG_REVISION_CONFLICT");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="admin-page">
      <PageHeader
        eyebrow={editing ? "Data providers / New revision" : "Data providers / New draft"}
        title={editing ? `Revise ${provider?.displayName ?? "provider"}` : "Add a data provider"}
        description={editing ? "Saving creates a new immutable revision. Active imports keep using the enabled revision until the new one is tested and enabled." : "Create a draft first. Test the saved revision before enabling imports."}
        actions={<Link className="admin-button admin-button-secondary" to={providerId ? `/providers/${providerId}` : "/providers"}>Cancel</Link>}
      />
      {loading ? <div className="provider-loading" aria-busy="true">Loading masked configuration…</div> : null}
      {!loading && editing && !provider && error ? (
        <div className="ops-error" role="alert">
          <p>{error}</p>
          <Link className="admin-button admin-button-secondary" to="/providers">Return to providers</Link>
        </div>
      ) : null}
      {!loading && (!editing || provider) ? <ProviderForm provider={provider ?? undefined} pending={pending} error={error} onDirtyChange={setDirty} onSubmit={save} /> : null}
      {conflict ? <button type="button" className="admin-button admin-button-secondary provider-conflict-reload" onClick={() => window.location.reload()}>Reload current configuration</button> : null}
    </div>
  );
}

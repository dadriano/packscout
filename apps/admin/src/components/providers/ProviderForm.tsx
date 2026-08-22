import { useEffect, useState, type FormEvent } from "react";
import type {
  CreateProviderRequest,
  ProviderConfigurationSummary,
  ReplaceProviderRevisionRequest,
} from "@packscout/contracts";

type ProviderFormValue = CreateProviderRequest | ReplaceProviderRevisionRequest;

interface ProviderFormProps {
  provider?: ProviderConfigurationSummary;
  pending: boolean;
  error: string | null;
  onDirtyChange?: (dirty: boolean) => void;
  onSubmit: (value: ProviderFormValue) => Promise<void>;
}

function minutes(seconds: number): string {
  return String(seconds / 60);
}

export function ProviderForm({
  provider,
  pending,
  error,
  onDirtyChange,
  onSubmit,
}: ProviderFormProps) {
  const revision = provider?.latestRevision;
  const [displayName, setDisplayName] = useState(provider?.displayName ?? "");
  const [platformKey, setPlatformKey] = useState(provider?.platformKey ?? "");
  const [adapterKey, setAdapterKey] = useState(revision?.adapterKey ?? "");
  const [endpoint, setEndpoint] = useState(revision?.endpoint ?? "");
  const [authMode, setAuthMode] = useState<"none" | "bearer">(revision?.authMode ?? "none");
  const [bearerSecret, setBearerSecret] = useState("");
  const [removeSecretAcknowledged, setRemoveSecretAcknowledged] = useState(false);
  const [scheduleMinutes, setScheduleMinutes] = useState(revision ? minutes(revision.scheduleSeconds) : "5");
  const [staleMinutes, setStaleMinutes] = useState(revision ? minutes(revision.staleAfterSeconds) : "15");
  const [dirty, setDirty] = useState(false);

  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

  function change(update: () => void): void {
    update();
    setDirty(true);
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const common = {
      displayName,
      adapterKey,
      endpoint,
      scheduleSeconds: Number(scheduleMinutes) * 60,
      staleAfterSeconds: Number(staleMinutes) * 60,
    };
    let value: ProviderFormValue;
    if (provider) {
      const auth: ReplaceProviderRevisionRequest["auth"] = authMode === "none"
        ? { mode: "none" }
        : bearerSecret
          ? { mode: "bearer", bearerSecret }
          : { mode: "bearer", reuseExistingSecret: true };
      value = { ...common, expectedRevisionId: provider.latestRevision.id, auth };
    } else {
      const auth: CreateProviderRequest["auth"] = authMode === "bearer"
        ? { mode: "bearer", bearerSecret }
        : { mode: "none" };
      value = { ...common, platformKey, auth };
    }
    await onSubmit(value);
    setBearerSecret("");
    setDirty(false);
  }

  return (
    <form className="provider-form" aria-label={provider ? "Revise data provider" : "Create data provider"} onSubmit={(event) => void submit(event)}>
      {error ? <div className="provider-form__error" role="alert" tabIndex={-1}>{error}</div> : null}

      <fieldset>
        <legend><span>01</span> Source identity</legend>
        <div className="provider-form__grid">
          <div className="admin-field provider-form__wide">
            <label htmlFor="provider-name">Provider name</label>
            <input id="provider-name" required maxLength={120} value={displayName} onChange={(event) => change(() => setDisplayName(event.target.value))} />
          </div>
          <div className="admin-field">
            <label htmlFor="provider-platform">Platform key</label>
            <input id="provider-platform" required maxLength={128} pattern="[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?" disabled={Boolean(provider)} value={platformKey} onChange={(event) => change(() => setPlatformKey(event.target.value))} aria-describedby="provider-platform-help" />
            <small id="provider-platform-help">Lowercase letters, numbers, hyphens, or underscores. Fixed after creation.</small>
          </div>
          <div className="admin-field">
            <label htmlFor="provider-adapter">Adapter key</label>
            <input id="provider-adapter" required maxLength={128} pattern="[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?" value={adapterKey} onChange={(event) => change(() => setAdapterKey(event.target.value))} />
          </div>
          <div className="admin-field provider-form__wide">
            <label htmlFor="provider-endpoint">Endpoint</label>
            <input id="provider-endpoint" required type="url" maxLength={2048} value={endpoint} onChange={(event) => change(() => setEndpoint(event.target.value))} />
          </div>
        </div>
      </fieldset>

      <fieldset>
        <legend><span>02</span> Authentication</legend>
        <div className="provider-form__grid">
          <div className="admin-field">
            <label htmlFor="provider-auth-mode">Authentication mode</label>
            <select id="provider-auth-mode" value={authMode} onChange={(event) => change(() => setAuthMode(event.target.value as "none" | "bearer"))}>
              <option value="none">No authentication</option>
              <option value="bearer">Bearer token</option>
            </select>
          </div>
          {authMode === "bearer" ? (
            <div className="admin-field provider-form__wide">
              <label htmlFor="provider-token">{revision?.hasBearerSecret ? "Replace bearer token" : "Bearer token"}</label>
              <input id="provider-token" type="password" autoComplete="new-password" required={!revision?.hasBearerSecret} value={bearerSecret} onChange={(event) => change(() => setBearerSecret(event.target.value))} aria-describedby="provider-token-help" />
              <small id="provider-token-help">{revision?.hasBearerSecret ? "Leave blank to preserve the stored credential. The current token cannot be viewed." : "Stored securely and never shown again."}</small>
            </div>
          ) : revision?.hasBearerSecret ? (
            <div className="provider-form__credential-warning">
              <label><input type="checkbox" required checked={removeSecretAcknowledged} onChange={(event) => change(() => setRemoveSecretAcknowledged(event.target.checked))} /> Remove the stored bearer token when this revision is saved</label>
              <p>No future request will use the stored credential.</p>
            </div>
          ) : null}
        </div>
      </fieldset>

      <fieldset>
        <legend><span>03</span> Timing</legend>
        <div className="provider-form__grid">
          <div className="admin-field">
            <label htmlFor="provider-schedule">Import schedule (minutes)</label>
            <input id="provider-schedule" required type="number" min="1" max="1440" step="1" value={scheduleMinutes} onChange={(event) => change(() => setScheduleMinutes(event.target.value))} />
          </div>
          <div className="admin-field">
            <label htmlFor="provider-stale">Stale after (minutes)</label>
            <input id="provider-stale" required type="number" min="1" max="10080" step="1" value={staleMinutes} onChange={(event) => change(() => setStaleMinutes(event.target.value))} />
          </div>
        </div>
      </fieldset>

      <footer className="provider-form__footer">
        <p aria-live="polite">{dirty ? "Unsaved changes" : "No unsaved changes"}</p>
        <button type="submit" className="admin-button admin-button-primary" disabled={pending}>
          {pending ? "Saving…" : provider ? "Save new revision" : "Create draft"}
        </button>
      </footer>
    </form>
  );
}

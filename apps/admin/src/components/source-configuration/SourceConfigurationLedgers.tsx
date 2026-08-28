import { useState, type FormEvent } from "react";
import {
  DATAFORREST_EVENTS_V1_ENDPOINT,
  type CreateProviderSourceRequest,
  type CreateSourceConnectionProfileRequest,
  type ProviderSourceAdminCatalog,
  type ProviderSourceAdminSummary,
  type SourceConnectionProfileAdminSummary,
} from "@packscout/contracts";
import { StatusBadge, type StatusTone } from "../StatusBadge";
import {
  DEFAULT_RECORDS_PER_REQUEST,
  RECORDS_PER_REQUEST_ERROR,
  RECORDS_PER_REQUEST_HELP,
  parseRecordsPerRequest,
  recordsPerRequestDisplay,
} from "./records-per-request";

function label(value: string): string {
  return value.replaceAll("_", " ").replace(/^./u, (letter) => letter.toUpperCase());
}

function tone(value: string): StatusTone {
  if (["active", "paused", "succeeded", "success"].includes(value)) return "ready";
  if (["draft", "candidate", "pending", "running", "queued"].includes(value)) {
    return "pending";
  }
  if (["disabled", "revoked", "failed", "fenced"].includes(value)) return "danger";
  return "neutral";
}

interface ConnectionLedgerProps {
  readonly connections: readonly SourceConnectionProfileAdminSummary[];
  readonly canManage: boolean;
  readonly canManageSecrets: boolean;
  readonly pendingKey: string | null;
  readonly onCreate: (request: CreateSourceConnectionProfileRequest) => Promise<boolean>;
  readonly onRotate: (
    connection: SourceConnectionProfileAdminSummary,
    bearerCredential: string,
  ) => Promise<boolean>;
  readonly onRecover: (
    connection: SourceConnectionProfileAdminSummary,
    bearerCredential: string,
  ) => Promise<boolean>;
  readonly onCommand: (
    action: "test" | "activate" | "revoke" | "recovery-test" | "recovery-activate",
    connection: SourceConnectionProfileAdminSummary,
  ) => void;
}

export function SourceConnectionLedger({
  connections,
  canManage,
  canManageSecrets,
  pendingKey,
  onCreate,
  onRotate,
  onRecover,
  onCommand,
}: ConnectionLedgerProps) {
  const [name, setName] = useState("");
  const [bearer, setBearer] = useState("");

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const saved = await onCreate({
      sourceTypeKey: "dataforrest-events-v1",
      displayName: name,
      endpoint: DATAFORREST_EVENTS_V1_ENDPOINT,
      bearerCredential: bearer,
      requestLimit: 2,
    });
    if (saved) {
      setName("");
      setBearer("");
    }
  }

  return (
    <section className="source-config-ledger" aria-labelledby="connection-ledger-title">
      <header className="admin-section-header">
        <div>
          <span className="admin-kicker">Shared transport</span>
          <h2 className="admin-section-title" id="connection-ledger-title">DataForrest connection</h2>
        </div>
        <span className="admin-section-count">{connections.length} configured</span>
      </header>

      {canManageSecrets ? (
        <details className="source-config-editor">
          <summary>Add connection profile</summary>
          <form className="source-config-form" onSubmit={(event) => void create(event)}>
            <div className="admin-field">
              <label htmlFor="source-connection-name">Profile name</label>
              <input
                id="source-connection-name"
                value={name}
                maxLength={120}
                required
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="admin-field source-config-form__wide">
              <label htmlFor="source-connection-endpoint">Endpoint</label>
              <input
                id="source-connection-endpoint"
                value={DATAFORREST_EVENTS_V1_ENDPOINT}
                readOnly
              />
            </div>
            <div className="admin-field">
              <label htmlFor="source-connection-bearer">Bearer credential</label>
              <input
                id="source-connection-bearer"
                type="password"
                value={bearer}
                maxLength={4_096}
                required
                autoComplete="new-password"
                onChange={(event) => setBearer(event.target.value)}
              />
            </div>
            <button
              type="submit"
              className="admin-button admin-button-primary"
              disabled={pendingKey !== null}
            >
              {pendingKey === "connection:create" ? "Saving…" : "Save inactive profile"}
            </button>
          </form>
        </details>
      ) : null}

      <div className="source-config-ledger__rows">
        {connections.map((connection) => {
          const revision = connection.latestRevision;
          const hasCurrentSuccessfulTest = revision.test.state === "succeeded" &&
            revision.test.outcome === "success" && revision.test.current;
          const canActivate = hasCurrentSuccessfulTest &&
            revision.state === "candidate";
          const recovery = connection.recoveryFence;
          const latestRevisionCanRecover = recovery !== null &&
            revision.state === "candidate";
          const canActivateRecovery = latestRevisionCanRecover &&
            hasCurrentSuccessfulTest;
          const canTestSameRevisionRecovery = recovery !== null &&
            recovery.blockedRevisionId === revision.id &&
            revision.state === "active";
          return (
            <article key={connection.id}>
              <div className="source-config-ledger__identity">
                <strong>{connection.displayName}</strong>
                <span>{connection.sourceTypeKey} · {revision.endpointHost}</span>
              </div>
              <div className="source-config-ledger__badges">
                <StatusBadge label={label(connection.state)} tone={tone(connection.state)} />
                <StatusBadge label={`Revision ${revision.revisionNumber}`} />
                <StatusBadge label={label(revision.test.state)} tone={tone(revision.test.state)} />
              </div>
              <dl className="source-config-ledger__facts">
                <div><dt>Credential</dt><dd>{revision.credentialMask} configured</dd></div>
                <div><dt>Adapter</dt><dd>{revision.sourceAdapterVersion}</dd></div>
                <div><dt>Request cap</dt><dd>{connection.requestLimit} per platform</dd></div>
                <div><dt>Revision state</dt><dd>{label(revision.state)}</dd></div>
              </dl>
              {canManage ? (
                <div className="source-config-ledger__actions">
                  <button
                    type="button"
                    className="admin-button admin-button-secondary"
                    disabled={pendingKey !== null || recovery !== null || revision.state === "revoked"}
                    onClick={() => onCommand("test", connection)}
                  >Test</button>
                  <button
                    type="button"
                    className="admin-button admin-button-secondary"
                    disabled={pendingKey !== null || recovery !== null || !canActivate}
                    onClick={() => onCommand("activate", connection)}
                  >Activate revision</button>
                  {latestRevisionCanRecover ? (
                    <>
                      <button
                        type="button"
                        className="admin-button admin-button-secondary"
                        disabled={pendingKey !== null}
                        onClick={() => onCommand("recovery-test", connection)}
                      >Test recovery</button>
                      <button
                        type="button"
                        className="admin-button admin-button-primary"
                        disabled={pendingKey !== null || !canActivateRecovery}
                        onClick={() => onCommand("recovery-activate", connection)}
                      >Activate recovery</button>
                    </>
                  ) : null}
                  {canTestSameRevisionRecovery ? (
                    <button
                      type="button"
                      className="admin-button admin-button-primary"
                      disabled={pendingKey !== null}
                      onClick={() => onCommand("recovery-test", connection)}
                    >Test same-revision recovery</button>
                  ) : null}
                  {canManageSecrets ? (
                    <button
                      type="button"
                      className="admin-button admin-button-danger"
                      disabled={pendingKey !== null || revision.state === "revoked"}
                      onClick={() => onCommand("revoke", connection)}
                    >Revoke</button>
                  ) : null}
                </div>
              ) : null}
              {canManageSecrets && !recovery ? (
                <details className="source-config-rotate">
                  <summary>Rotate credential on the same endpoint</summary>
                  <form onSubmit={(event) => {
                    event.preventDefault();
                    const input = event.currentTarget.elements.namedItem("bearerCredential");
                    if (!(input instanceof HTMLInputElement)) return;
                    void onRotate(connection, input.value).then((saved) => {
                      if (saved) input.value = "";
                    });
                  }}>
                    <div className="admin-field">
                      <label htmlFor={`rotate-${connection.id}`}>New bearer credential</label>
                      <input
                        id={`rotate-${connection.id}`}
                        name="bearerCredential"
                        type="password"
                        required
                        maxLength={4_096}
                        autoComplete="new-password"
                      />
                    </div>
                    <button className="admin-button admin-button-secondary" type="submit"
                      disabled={pendingKey !== null}>Save candidate revision</button>
                  </form>
                </details>
              ) : null}
              {canManageSecrets && recovery && revision.state !== "candidate" ? (
                <details className="source-config-rotate">
                  <summary>Recover with a new credential revision</summary>
                  <form onSubmit={(event) => {
                    event.preventDefault();
                    const input = event.currentTarget.elements.namedItem("recoveryCredential");
                    if (!(input instanceof HTMLInputElement)) return;
                    void onRecover(connection, input.value).then((saved) => {
                      if (saved) input.value = "";
                    });
                  }}>
                    <div className="admin-field">
                      <label htmlFor={`recover-${connection.id}`}>Recovery bearer credential</label>
                      <input id={`recover-${connection.id}`} name="recoveryCredential"
                        type="password" required maxLength={4_096}
                        autoComplete="new-password" />
                    </div>
                    <button className="admin-button admin-button-primary" type="submit"
                      disabled={pendingKey !== null}>Save recovery candidate</button>
                  </form>
                </details>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
interface SourceLedgerProps {
  readonly catalog: ProviderSourceAdminCatalog;
  readonly canManage: boolean;
  readonly pendingKey: string | null;
  readonly onCreate: (request: CreateProviderSourceRequest) => Promise<boolean>;
  readonly onCommand: (
    action: "test" | "activate" | "pause" | "resume" | "disable" | "reset",
    source: ProviderSourceAdminSummary,
  ) => void;
  readonly onInterval: (
    source: ProviderSourceAdminSummary,
    intervalSeconds: number,
  ) => Promise<boolean>;
}

export function ProviderSourceLedger({
  catalog,
  canManage,
  pendingKey,
  onCreate,
  onCommand,
  onInterval,
}: SourceLedgerProps) {
  const [providerId, setProviderId] = useState("");
  const [profileId, setProfileId] = useState("");
  const [intervalSeconds, setIntervalSeconds] = useState("60");
  const [recordsPerRequest, setRecordsPerRequest] = useState(
    String(DEFAULT_RECORDS_PER_REQUEST),
  );
  const [recordsPerRequestError, setRecordsPerRequestError] = useState<
    string | null
  >(null);
  const provider = catalog.providers.find((item) => item.id === providerId);
  const profile = catalog.connections.find((item) => item.id === profileId);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!provider || !profile) return;
    const parsedRecordsPerRequest = parseRecordsPerRequest(recordsPerRequest);
    if (parsedRecordsPerRequest === null) {
      setRecordsPerRequestError(RECORDS_PER_REQUEST_ERROR);
      return;
    }
    setRecordsPerRequestError(null);
    const base: CreateProviderSourceRequest = {
      providerId: provider.id,
      connectionProfileId: profile.id,
      sourceTypeKey: provider.sourceRegistration.sourceTypeKey,
      mapperKey: provider.sourceRegistration.mapperKey,
      mapperVersion: provider.sourceRegistration.mapperVersion,
      intervalSeconds: Number(intervalSeconds),
      recordsPerRequest: parsedRecordsPerRequest,
    };
    const saved = await onCreate(base);
    if (saved) {
      setProviderId("");
      setProfileId("");
      setIntervalSeconds("60");
      setRecordsPerRequest(String(DEFAULT_RECORDS_PER_REQUEST));
    }
  }

  return (
    <section className="source-config-ledger" aria-labelledby="source-ledger-title">
      <header className="admin-section-header">
        <div>
          <span className="admin-kicker">Provider isolation</span>
          <h2 className="admin-section-title" id="source-ledger-title">Platform sources</h2>
        </div>
        <span className="admin-section-count">{catalog.sources.length} sources</span>
      </header>

      {canManage ? (
        <details className="source-config-editor">
          <summary>Create a source</summary>
          <form className="source-config-form" onSubmit={(event) => void create(event)}>
            <div className="admin-field">
              <label htmlFor="source-provider">Provider</label>
              <select id="source-provider" required value={providerId}
                onChange={(event) => {
                  setProviderId(event.target.value);
                  setProfileId("");
                }}>
                <option value="">Select provider</option>
                {catalog.providers.map((item) => (
                  <option key={item.id} value={item.id}>{label(item.provider)}</option>
                ))}
              </select>
            </div>
            <div className="admin-field">
              <label htmlFor="source-profile">Connection profile</label>
              <select id="source-profile" required value={profileId}
                onChange={(event) => setProfileId(event.target.value)}>
                <option value="">Select profile</option>
                {catalog.connections.filter((item) =>
                  item.state !== "disabled" &&
                  (!provider ||
                    item.sourceTypeKey === provider.sourceRegistration.sourceTypeKey)
                ).map((item) => (
                  <option key={item.id} value={item.id}>{item.displayName}</option>
                ))}
              </select>
            </div>
            <div className="admin-field">
              <label htmlFor="source-interval">Interval seconds</label>
              <input id="source-interval" type="number" min="60" max="86400" required
                value={intervalSeconds}
                onChange={(event) => setIntervalSeconds(event.target.value)} />
            </div>
            <div className="admin-field source-config-form__records">
              <label htmlFor="source-records-per-request">
                Maximum records per request
              </label>
              <input
                id="source-records-per-request"
                type="number"
                min="1"
                max="5000"
                step="1"
                required
                value={recordsPerRequest}
                aria-describedby={recordsPerRequestError
                  ? "source-records-per-request-help source-records-per-request-error"
                  : "source-records-per-request-help"}
                aria-invalid={recordsPerRequestError !== null}
                onInvalid={(event) => {
                  event.preventDefault();
                  setRecordsPerRequestError(RECORDS_PER_REQUEST_ERROR);
                }}
                onChange={(event) => {
                  setRecordsPerRequest(event.target.value);
                  setRecordsPerRequestError(null);
                }}
              />
              <p
                className="source-config-field-help"
                id="source-records-per-request-help"
              >
                {RECORDS_PER_REQUEST_HELP}
              </p>
              {recordsPerRequestError ? (
                <p
                  className="admin-form-error source-config-field-error"
                  id="source-records-per-request-error"
                  role="alert"
                >
                  {recordsPerRequestError}
                </p>
              ) : null}
            </div>
            <p className="source-config-form__evidence" aria-live="polite">
              {provider
                ? `Adapter: ${provider.sourceRegistration.sourceAdapterVersion} · Observation: ${provider.sourceRegistration.normalizedContractVersion} · Mapper: ${provider.sourceRegistration.mapperKey} @ ${provider.sourceRegistration.mapperVersion}`
                : "Select a provider to pin its approved mapper."}
            </p>
            <button type="submit" className="admin-button admin-button-primary"
              disabled={pendingKey !== null}>Save inactive source</button>
          </form>
        </details>
      ) : null}

      <div className="source-config-ledger__rows">
        {catalog.sources.map((source) => {
          const connection = catalog.connections.find((candidate) =>
            candidate.id === source.connectionProfileId &&
            candidate.activeRevisionId === source.connectionRevisionId &&
            candidate.latestRevision.id === source.connectionRevisionId
          );
          const connectionTestIsCurrent = connection?.latestRevision.state === "active" &&
            connection.latestRevision.test.state === "succeeded" &&
            connection.latestRevision.test.outcome === "success" &&
            connection.latestRevision.test.current;
          const canActivate = source.connectionRevisionId !== null &&
            connectionTestIsCurrent === true &&
            source.test.state === "succeeded" && source.test.outcome === "success" &&
            source.test.current &&
            ["draft", "disabled"].includes(source.state);
          return (
            <article key={source.sourceInstanceId}>
              <div className="source-config-ledger__identity">
                <strong>{label(source.provider)}</strong>
                <span>{source.sourceTypeKey} · {source.mapperKey} @ {source.mapperVersion}</span>
              </div>
              <div className="source-config-ledger__badges">
                <StatusBadge label={source.pauseRequested ? "Pause requested" : label(source.state)}
                  tone={tone(source.pauseRequested ? "pending" : source.state)} />
                <StatusBadge label={label(source.test.state)} tone={tone(source.test.state)} />
              </div>
              <dl className="source-config-ledger__facts">
                <div><dt>Adapter</dt><dd>{source.sourceAdapterVersion}</dd></div>
                <div><dt>Observation</dt><dd>{source.normalizedContractVersion}</dd></div>
                <div><dt>Interval / grace</dt><dd>{source.intervalSeconds}s / 15m</dd></div>
                <div>
                  <dt>Maximum records per request</dt>
                  <dd>{recordsPerRequestDisplay(
                    source.recordsPerRequest,
                    source.activeRunRecordsPerRequest,
                  )}</dd>
                </div>
                <div><dt>Cursor</dt><dd>{source.cursor.resumeLabel}</dd></div>
                <div className="source-config-ledger__fingerprint"><dt>Fingerprint</dt><dd>{source.cursor.fingerprint ?? "None"}</dd></div>
                <div><dt>Generation</dt><dd>{source.cursor.generation}</dd></div>
              </dl>
              {canManage ? (
                <div className="source-config-ledger__actions">
                  {(["draft", "disabled"].includes(source.state)) ? (
                    <button type="button" className="admin-button admin-button-secondary"
                      disabled={pendingKey !== null}
                      onClick={() => onCommand("test", source)}>Test</button>
                  ) : null}
                  <button type="button" className="admin-button admin-button-secondary"
                    disabled={pendingKey !== null || !canActivate}
                    onClick={() => onCommand("activate", source)}>Activate paused</button>
                  {source.state === "paused" ? (
                    <button type="button" className="admin-button admin-button-primary"
                      disabled={pendingKey !== null}
                      onClick={() => onCommand("resume", source)}>Resume from {source.cursor.resumeLabel}</button>
                  ) : null}
                  {source.state === "active" ? (
                    <button type="button" className="admin-button admin-button-secondary"
                      disabled={pendingKey !== null || source.pauseRequested}
                      onClick={() => onCommand("pause", source)}>Pause after page</button>
                  ) : null}
                  {!(["disabled", "replaced"].includes(source.state)) ? (
                    <button type="button" className="admin-button admin-button-danger"
                      disabled={pendingKey !== null}
                      onClick={() => onCommand("disable", source)}>Disable</button>
                  ) : null}
                  {(["paused", "disabled"].includes(source.state)) ? (
                    <button type="button" className="admin-button admin-button-danger"
                      disabled={pendingKey !== null}
                      onClick={() => onCommand("reset", source)}>Reset cursor</button>
                  ) : null}
                </div>
              ) : null}
              {canManage && ["draft", "paused", "active"].includes(source.state) ? (
                <form className="source-config-interval" onSubmit={(event) => {
                  event.preventDefault();
                  const input = event.currentTarget.elements.namedItem("intervalSeconds");
                  if (!(input instanceof HTMLInputElement)) return;
                  void onInterval(source, Number(input.value));
                }}>
                  <label htmlFor={`interval-${source.sourceInstanceId}`}>Revise interval</label>
                  <input id={`interval-${source.sourceInstanceId}`} name="intervalSeconds"
                    type="number" min="60" max="86400" defaultValue={source.intervalSeconds} />
                  <button type="submit" className="admin-button admin-button-secondary"
                    disabled={pendingKey !== null}>Save timing</button>
                </form>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

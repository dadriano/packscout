import { createHash, timingSafeEqual } from "node:crypto";
import {
  CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
  activeCatalogManifestStateV1Schema,
  canonicalJson,
  catalogManifestActivateRequestSchema,
  catalogManifestActiveStateReceiptSchema,
  catalogManifestActiveStateRequestSchema,
  catalogManifestActivationReceiptSchema,
  catalogManifestPublicationRequestDigest,
  catalogManifestReceiptDigest,
  catalogManifestReceiptSchema,
  catalogManifestSignedReceiptEnvelopeSchema,
  catalogManifestStatusNotFoundReceiptSchema,
  catalogManifestStatusRequestSchema,
  verifyGlobalCatalogManifestV1,
  type ActiveCatalogManifestStateV1,
  type CatalogManifestActivateRequest,
  type CatalogManifestActivationReceipt,
  type CatalogManifestStatusRequest,
  type GlobalCatalogManifestV1,
} from "@packscout/contracts";
import { Prisma as CentralPrisma } from
  "../prisma/generated/central/index.js";
import type {
  CentralPrismaClient,
  CentralTransactionClient,
} from "./central-database.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_LEASE_MILLISECONDS = 15 * 60_000;
const TRANSACTION = Object.freeze({
  maxWait: 5_000,
  timeout: 30_000,
  isolationLevel: CentralPrisma.TransactionIsolationLevel.Serializable,
});

export interface ManifestActivationTransactionDeadline {
  readonly deadlineAt: number;
}

function transactionOptions(
  deadline?: ManifestActivationTransactionDeadline,
) {
  if (deadline === undefined) return TRANSACTION;
  const available = Math.floor(deadline.deadlineAt - Date.now() - 50);
  const maxWait = Math.min(TRANSACTION.maxWait, Math.max(1, Math.floor(
    available / 5,
  )));
  const timeout = Math.min(TRANSACTION.timeout, available - maxWait);
  if (timeout < 1) {
    throw Object.assign(new Error("Manifest activation deadline reached."), {
      code: "PROMOTION_JOB_DEADLINE_EXCEEDED",
    });
  }
  return {
    maxWait,
    timeout,
    isolationLevel: CentralPrisma.TransactionIsolationLevel.Serializable,
  };
}

export type DistributedManifestOperation =
  | "advance"
  | "add"
  | "remove"
  | "rollback";

export type ManifestActivationRepositoryFailureCode =
  | "MANIFEST_ACTIVATION_INPUT_INVALID"
  | "MANIFEST_ACTIVATION_LEASE_HELD"
  | "MANIFEST_ACTIVATION_LEASE_LOST"
  | "MANIFEST_ACTIVATION_IDEMPOTENCY_CONFLICT"
  | "MANIFEST_ACTIVATION_REQUEST_INVALID"
  | "MANIFEST_ACTIVATION_STATE_CONFLICT"
  | "MANIFEST_ACTIVATION_RECEIPT_INVALID"
  | "MANIFEST_ACTIVATION_OPERATION_TERMINAL"
  | "MANIFEST_ACTIVATION_EVIDENCE_INVALID"
  | "MANIFEST_ACTIVATION_STATUS_INVALID"
  | "MANIFEST_ACTIVATION_RECONCILIATION_INVALID"
  | "MANIFEST_ACTIVATION_CLEAR_FORBIDDEN";

export class ManifestActivationRepositoryError extends Error {
  constructor(readonly code: ManifestActivationRepositoryFailureCode) {
    super(`Manifest activation persistence failed (${code}).`);
    this.name = "ManifestActivationRepositoryError";
  }
}

export interface ManifestActivationLease {
  readonly owner: string;
  readonly fence: bigint;
  readonly expiresAt: Date;
}

export interface ManifestActivationMirror {
  readonly generation: bigint;
  readonly activeManifest: GlobalCatalogManifestV1 | null;
  readonly activeState: ActiveCatalogManifestStateV1 | null;
  readonly previousManifest: GlobalCatalogManifestV1 | null;
  readonly lastReceiptId: string | null;
  readonly rowVersion: bigint;
  readonly updatedAt: Date;
}

export interface ExactManifestActivationIntentInput {
  readonly providerId: string;
  readonly operation: DistributedManifestOperation;
  readonly targetProviderReleaseId: string | null;
  readonly targetCatalogVersionId: string | null;
  readonly targetManifest: GlobalCatalogManifestV1;
  readonly canonicalRequestBody: string;
  readonly requestDigest: string;
  readonly requestedByOperatorId?: string | null;
  readonly requestedAt: Date;
}

export interface ExactManifestActivationReceiptEvidence {
  readonly canonicalReceiptBody: string;
  readonly receiptSha256: string;
  readonly exactResponseBody: string;
  readonly exactResponseSha256: string;
}

export interface SignedManifestActiveStateEvidence
  extends ExactManifestActivationReceiptEvidence {
  readonly activeManifest: GlobalCatalogManifestV1 | null;
  readonly previousManifest: GlobalCatalogManifestV1 | null;
}

export interface ManifestActivationStatusObservation {
  readonly operationId: string;
  readonly resultKind: "not_found" | "terminal";
  readonly requestDigest: string;
  readonly responseDigest: string;
  readonly observedAt: Date;
}

export interface ManifestActivationIntent {
  readonly id: string;
  readonly providerId: string;
  readonly operation: DistributedManifestOperation;
  readonly expectedManifestId: string | null;
  readonly targetProviderReleaseId: string | null;
  readonly targetCatalogVersionId: string | null;
  readonly targetManifest: GlobalCatalogManifestV1;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly canonicalRequestBody: string;
  readonly leaseFence: bigint;
  readonly state: "pending" | "accepted" | "ambiguous" | "failed";
  readonly attemptCount: number;
  readonly lastAttemptedAt: Date | null;
  readonly completionLeaseFence: bigint | null;
  readonly canonicalReceiptBody: string | null;
  readonly receiptSha256: string | null;
  readonly exactResponseBody: string | null;
  readonly exactResponseSha256: string | null;
  readonly failureCode: string | null;
  readonly requestedAt: Date;
  readonly completedAt: Date | null;
}

type MutationRequest = CatalogManifestActivateRequest;
type MutationReceipt = CatalogManifestActivationReceipt;

interface StateRow {
  readonly activeGeneration: bigint;
  readonly activeManifestId: string | null;
  readonly activeManifestFingerprint: string | null;
  readonly activeManifestBytes: Uint8Array | null;
  readonly activeManifestBytesHash: string | null;
  readonly activeStateBytes: Uint8Array | null;
  readonly activeStateHash: string | null;
  readonly previousManifestId: string | null;
  readonly previousManifestFingerprint: string | null;
  readonly previousManifestBytes: Uint8Array | null;
  readonly previousManifestBytesHash: string | null;
  readonly leaseOwner: string | null;
  readonly leaseFence: bigint;
  readonly leaseExpiresAt: Date | null;
  readonly lastReceiptId: string | null;
  readonly rowVersion: bigint;
  readonly updatedAt: Date;
  readonly databaseNow?: Date;
}

interface OperationRow {
  readonly id: string;
  readonly providerId: string;
  readonly operation: DistributedManifestOperation;
  readonly expectedManifestId: string | null;
  readonly targetProviderReleaseId: string | null;
  readonly targetCatalogVersionId: string | null;
  readonly newManifestId: string;
  readonly newManifestFingerprint: string;
  readonly newManifestBytes: Uint8Array;
  readonly newManifestBytesHash: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly requestBytes: Uint8Array;
  readonly leaseFence: bigint;
  readonly state: "pending" | "accepted" | "ambiguous" | "failed";
  readonly attemptCount: number;
  readonly lastAttemptedAt: Date | null;
  readonly completionLeaseFence: bigint | null;
  readonly convexReceiptId: string | null;
  readonly receiptHash: string | null;
  readonly receiptBytes: Uint8Array | null;
  readonly responseDigest: string | null;
  readonly responseBytes: Uint8Array | null;
  readonly failureCode: string | null;
  readonly requestedAt: Date;
  readonly completedAt: Date | null;
}

const stateProjection = CentralPrisma.sql`
  active_generation as "activeGeneration",
  active_manifest_id as "activeManifestId",
  active_manifest_fingerprint as "activeManifestFingerprint",
  active_manifest_bytes as "activeManifestBytes",
  active_manifest_bytes_hash as "activeManifestBytesHash",
  active_state_bytes as "activeStateBytes",
  active_state_hash as "activeStateHash",
  previous_manifest_id as "previousManifestId",
  previous_manifest_fingerprint as "previousManifestFingerprint",
  previous_manifest_bytes as "previousManifestBytes",
  previous_manifest_bytes_hash as "previousManifestBytesHash",
  lease_owner as "leaseOwner",
  lease_fence as "leaseFence",
  lease_expires_at as "leaseExpiresAt",
  last_receipt_id as "lastReceiptId",
  row_version as "rowVersion",
  updated_at as "updatedAt"
`;

const operationProjection = CentralPrisma.sql`
  id::text,
  provider_id::text as "providerId",
  operation::text,
  expected_manifest_id as "expectedManifestId",
  target_provider_release_id::text as "targetProviderReleaseId",
  target_catalog_version_id::text as "targetCatalogVersionId",
  new_manifest_id as "newManifestId",
  new_manifest_fingerprint as "newManifestFingerprint",
  new_manifest_bytes as "newManifestBytes",
  new_manifest_bytes_hash as "newManifestBytesHash",
  idempotency_key as "idempotencyKey",
  request_digest as "requestDigest",
  request_bytes as "requestBytes",
  lease_fence as "leaseFence",
  state::text,
  attempt_count as "attemptCount",
  last_attempted_at as "lastAttemptedAt",
  completion_lease_fence as "completionLeaseFence",
  convex_receipt_id as "convexReceiptId",
  receipt_hash as "receiptHash",
  receipt_bytes as "receiptBytes",
  response_digest as "responseDigest",
  response_bytes as "responseBytes",
  failure_code as "failureCode",
  requested_at as "requestedAt",
  completed_at as "completedAt"
`;

function failure(code: ManifestActivationRepositoryFailureCode): never {
  throw new ManifestActivationRepositoryError(code);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactBytes(left: string, right: Uint8Array): boolean {
  const expected = Buffer.from(left, "utf8");
  const actual = Buffer.from(right);
  return expected.byteLength === actual.byteLength &&
    timingSafeEqual(expected, actual);
}

function text(value: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    failure("MANIFEST_ACTIVATION_EVIDENCE_INVALID");
  }
}

const ACTIVE_STATE_REQUEST = catalogManifestActiveStateRequestSchema.parse({
  schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
  operationId: "catalog-manifest-active-state",
});
const ACTIVE_STATE_REQUEST_BODY = canonicalJson(ACTIVE_STATE_REQUEST);

function exactSignedEnvelope(
  evidence: ExactManifestActivationReceiptEvidence,
): ReturnType<typeof catalogManifestSignedReceiptEnvelopeSchema.parse> {
  if (
    !SHA256_PATTERN.test(evidence.receiptSha256) ||
    !SHA256_PATTERN.test(evidence.exactResponseSha256) ||
    sha256(evidence.canonicalReceiptBody) !== evidence.receiptSha256 ||
    sha256(evidence.exactResponseBody) !== evidence.exactResponseSha256
  ) failure("MANIFEST_ACTIVATION_EVIDENCE_INVALID");
  let receipt: unknown;
  let response: unknown;
  try {
    receipt = JSON.parse(evidence.canonicalReceiptBody) as unknown;
    response = JSON.parse(evidence.exactResponseBody) as unknown;
  } catch {
    failure("MANIFEST_ACTIVATION_EVIDENCE_INVALID");
  }
  const envelope = catalogManifestSignedReceiptEnvelopeSchema.safeParse(
    response,
  );
  if (
    !envelope.success ||
    canonicalJson(receipt) !== evidence.canonicalReceiptBody ||
    canonicalJson(envelope.data.receipt) !== evidence.canonicalReceiptBody
  ) failure("MANIFEST_ACTIVATION_EVIDENCE_INVALID");
  return envelope.data;
}

async function assertSignedEnvelopeDigest(
  envelope: ReturnType<typeof catalogManifestSignedReceiptEnvelopeSchema.parse>,
): Promise<void> {
  if (
    await catalogManifestReceiptDigest(envelope.receipt) !==
      envelope.responseAuth.receiptDigest
  ) failure("MANIFEST_ACTIVATION_EVIDENCE_INVALID");
}

function assertStateManifestBinding(input: Readonly<{
  state: ActiveCatalogManifestStateV1;
  activeManifest: GlobalCatalogManifestV1 | null;
  previousManifest: GlobalCatalogManifestV1 | null;
}>): void {
  const active = input.state.activeManifest;
  const previous = input.state.previousManifest;
  if (active === null) {
    if (
      input.state.generation !== 0 || input.state.observation !== null ||
      input.state.terminalReceiptSha256 !== null ||
      previous !== null || input.activeManifest !== null ||
      input.previousManifest !== null
    ) failure("MANIFEST_ACTIVATION_CLEAR_FORBIDDEN");
    return;
  }
  const manifest = input.activeManifest;
  const observation = input.state.observation;
  if (
    manifest === null || observation === null ||
    manifest.publicReleaseId !== active.publicReleaseId ||
    manifest.manifestFingerprint !== active.manifestFingerprint ||
    canonicalJson({
      sharedConfigurationEpoch: manifest.sharedConfigurationEpoch,
      providerReferenceSetHash: manifest.providerReferenceSetHash,
    }) !== canonicalJson({
      sharedConfigurationEpoch: active.sharedConfigurationEpoch,
      providerReferenceSetHash: active.providerReferenceSetHash,
    }) ||
    observation.publicReleaseId !== manifest.publicReleaseId ||
    observation.providerReferenceSetHash !== manifest.providerReferenceSetHash ||
    observation.providerSelections.length !== manifest.providerReferences.length
  ) failure("MANIFEST_ACTIVATION_RECONCILIATION_INVALID");
  for (const [index, reference] of manifest.providerReferences.entries()) {
    const selected = observation.providerSelections[index];
    if (
      selected === undefined ||
      selected.platformKey !== reference.platformKey ||
      selected.publicProviderReleaseId !== reference.publicProviderReleaseId
    ) failure("MANIFEST_ACTIVATION_RECONCILIATION_INVALID");
  }
  if (previous === null) {
    if (input.previousManifest !== null) {
      failure("MANIFEST_ACTIVATION_RECONCILIATION_INVALID");
    }
  } else if (
    input.previousManifest === null ||
    input.previousManifest.publicReleaseId !== previous.publicReleaseId ||
    input.previousManifest.manifestFingerprint !== previous.manifestFingerprint
  ) failure("MANIFEST_ACTIVATION_RECONCILIATION_INVALID");
}

function validDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

function assertUuid(value: string): void {
  if (!UUID_PATTERN.test(value)) {
    failure("MANIFEST_ACTIVATION_INPUT_INVALID");
  }
}

function assertLeaseInput(owner: string, leaseMilliseconds: number): void {
  if (
    !OWNER_PATTERN.test(owner) ||
    !Number.isSafeInteger(leaseMilliseconds) ||
    leaseMilliseconds < 1_000 ||
    leaseMilliseconds > MAX_LEASE_MILLISECONDS
  ) failure("MANIFEST_ACTIVATION_INPUT_INVALID");
}

/**
 * The persisted `operation` is the central one-provider audit semantic. Every
 * resulting manifest, including a per-provider rollback hybrid, is a newly
 * composed full manifest and therefore uses Convex `activateManifest`.
 */
function parseRequest(
  canonicalRequestBody: string,
): MutationRequest {
  let value: unknown;
  try {
    value = JSON.parse(canonicalRequestBody) as unknown;
  } catch {
    failure("MANIFEST_ACTIVATION_REQUEST_INVALID");
  }
  const parsed = catalogManifestActivateRequestSchema.safeParse(value);
  if (
    !parsed.success ||
    canonicalJson(parsed.data) !== canonicalRequestBody
  ) failure("MANIFEST_ACTIVATION_REQUEST_INVALID");
  return parsed.data;
}

function expectedState(request: MutationRequest): ActiveCatalogManifestStateV1 {
  return request.expectedActiveState;
}

function requestTarget(request: MutationRequest): Readonly<{
  publicReleaseId: string;
  manifestFingerprint: string;
}> {
  return request.manifest;
}

async function parseTargetManifest(
  bytes: Uint8Array,
  expectedHash: string,
): Promise<GlobalCatalogManifestV1> {
  const body = text(bytes);
  if (sha256(bytes) !== expectedHash) {
    failure("MANIFEST_ACTIVATION_EVIDENCE_INVALID");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    failure("MANIFEST_ACTIVATION_EVIDENCE_INVALID");
  }
  try {
    const manifest = await verifyGlobalCatalogManifestV1(parsed);
    if (canonicalJson(manifest) !== body) {
      failure("MANIFEST_ACTIVATION_EVIDENCE_INVALID");
    }
    return manifest;
  } catch (error) {
    if (error instanceof ManifestActivationRepositoryError) throw error;
    failure("MANIFEST_ACTIVATION_EVIDENCE_INVALID");
  }
}

async function mapState(row: StateRow): Promise<ManifestActivationMirror> {
  const allActiveNull = row.activeManifestId === null &&
    row.activeManifestFingerprint === null &&
    row.activeManifestBytes === null &&
    row.activeManifestBytesHash === null &&
    row.activeStateBytes === null &&
    row.activeStateHash === null;
  let activeManifest: GlobalCatalogManifestV1 | null = null;
  let activeState: ActiveCatalogManifestStateV1 | null = null;
  if (!allActiveNull) {
    if (
      row.activeManifestId === null ||
      row.activeManifestFingerprint === null ||
      row.activeManifestBytes === null ||
      row.activeManifestBytesHash === null ||
      row.activeStateBytes === null ||
      row.activeStateHash === null ||
      sha256(row.activeStateBytes) !== row.activeStateHash
    ) failure("MANIFEST_ACTIVATION_EVIDENCE_INVALID");
    activeManifest = await parseTargetManifest(
      row.activeManifestBytes,
      row.activeManifestBytesHash,
    );
    let value: unknown;
    try {
      value = JSON.parse(text(row.activeStateBytes)) as unknown;
    } catch {
      failure("MANIFEST_ACTIVATION_EVIDENCE_INVALID");
    }
    const parsedState = activeCatalogManifestStateV1Schema.safeParse(value);
    if (
      !parsedState.success ||
      canonicalJson(parsedState.data) !== text(row.activeStateBytes) ||
      BigInt(parsedState.data.generation) !== row.activeGeneration ||
      parsedState.data.activeManifest?.publicReleaseId !== row.activeManifestId ||
      parsedState.data.activeManifest?.manifestFingerprint !==
        row.activeManifestFingerprint
    ) failure("MANIFEST_ACTIVATION_EVIDENCE_INVALID");
    activeState = parsedState.data;
  } else if (row.activeGeneration !== 0n) {
    failure("MANIFEST_ACTIVATION_EVIDENCE_INVALID");
  }

  const allPreviousNull = row.previousManifestId === null &&
    row.previousManifestFingerprint === null &&
    row.previousManifestBytes === null &&
    row.previousManifestBytesHash === null;
  let previousManifest: GlobalCatalogManifestV1 | null = null;
  if (!allPreviousNull) {
    if (
      row.previousManifestId === null ||
      row.previousManifestFingerprint === null ||
      row.previousManifestBytes === null ||
      row.previousManifestBytesHash === null
    ) failure("MANIFEST_ACTIVATION_EVIDENCE_INVALID");
    previousManifest = await parseTargetManifest(
      row.previousManifestBytes,
      row.previousManifestBytesHash,
    );
    if (
      previousManifest.publicReleaseId !== row.previousManifestId ||
      previousManifest.manifestFingerprint !== row.previousManifestFingerprint
    ) failure("MANIFEST_ACTIVATION_EVIDENCE_INVALID");
  }
  return {
    generation: row.activeGeneration,
    activeManifest,
    activeState,
    previousManifest,
    lastReceiptId: row.lastReceiptId,
    rowVersion: row.rowVersion,
    updatedAt: row.updatedAt,
  };
}

async function mapOperation(row: OperationRow): Promise<ManifestActivationIntent> {
  const targetManifest = await parseTargetManifest(
    row.newManifestBytes,
    row.newManifestBytesHash,
  );
  if (
    targetManifest.publicReleaseId !== row.newManifestId ||
    targetManifest.manifestFingerprint !== row.newManifestFingerprint ||
    sha256(row.requestBytes) !== row.requestDigest
  ) failure("MANIFEST_ACTIVATION_EVIDENCE_INVALID");
  const canonicalRequestBody = text(row.requestBytes);
  parseRequest(canonicalRequestBody);
  return {
    id: row.id.toLowerCase(),
    providerId: row.providerId.toLowerCase(),
    operation: row.operation,
    expectedManifestId: row.expectedManifestId,
    targetProviderReleaseId: row.targetProviderReleaseId?.toLowerCase() ?? null,
    targetCatalogVersionId: row.targetCatalogVersionId?.toLowerCase() ?? null,
    targetManifest,
    idempotencyKey: row.idempotencyKey,
    requestDigest: row.requestDigest,
    canonicalRequestBody,
    leaseFence: row.leaseFence,
    state: row.state,
    attemptCount: row.attemptCount,
    lastAttemptedAt: row.lastAttemptedAt,
    completionLeaseFence: row.completionLeaseFence,
    canonicalReceiptBody: row.receiptBytes === null
      ? null
      : text(row.receiptBytes),
    receiptSha256: row.receiptHash,
    exactResponseBody: row.responseBytes === null
      ? null
      : text(row.responseBytes),
    exactResponseSha256: row.responseDigest,
    failureCode: row.failureCode,
    requestedAt: row.requestedAt,
    completedAt: row.completedAt,
  };
}

async function lockState(
  transaction: CentralTransactionClient,
): Promise<StateRow> {
  const [row] = await transaction.$queryRaw<StateRow[]>(CentralPrisma.sql`
    select ${stateProjection}, clock_timestamp() as "databaseNow"
    from manifest_activation_state
    where singleton_key
    for update
  `);
  if (!row) throw new Error("Manifest activation singleton is missing.");
  return row;
}

function requireLease(row: StateRow, lease: ManifestActivationLease): Date {
  const databaseNow = row.databaseNow;
  if (
    databaseNow === undefined ||
    row.leaseOwner !== lease.owner ||
    row.leaseFence !== lease.fence ||
    row.leaseExpiresAt === null ||
    row.leaseExpiresAt <= databaseNow ||
    row.leaseExpiresAt.getTime() !== lease.expiresAt.getTime()
  ) failure("MANIFEST_ACTIVATION_LEASE_LOST");
  return databaseNow;
}

async function operationById(
  transaction: CentralTransactionClient,
  operationId: string,
  lock: boolean,
): Promise<OperationRow | null> {
  assertUuid(operationId);
  const rows = await transaction.$queryRaw<OperationRow[]>(CentralPrisma.sql`
    select ${operationProjection}
    from manifest_activation_operations
    where id = ${operationId}::uuid
    ${lock ? CentralPrisma.sql`for update` : CentralPrisma.empty}
  `);
  return rows[0] ?? null;
}

function assertExactExisting(
  row: OperationRow,
  input: Readonly<{
    providerId: string;
    operation: DistributedManifestOperation;
    targetProviderReleaseId: string | null;
    targetCatalogVersionId: string | null;
    targetManifestBody: string;
    targetManifestHash: string;
    request: MutationRequest;
    canonicalRequestBody: string;
    requestDigest: string;
  }>,
): void {
  const target = requestTarget(input.request);
  if (
    row.providerId.toLowerCase() !== input.providerId.toLowerCase() ||
    row.operation !== input.operation ||
    row.expectedManifestId !==
      (input.request.expectedActiveState.activeManifest?.publicReleaseId ?? null) ||
    row.targetProviderReleaseId?.toLowerCase() !==
      input.targetProviderReleaseId?.toLowerCase() ||
    row.targetCatalogVersionId?.toLowerCase() !==
      input.targetCatalogVersionId?.toLowerCase() ||
    row.newManifestId !== target.publicReleaseId ||
    row.newManifestFingerprint !== target.manifestFingerprint ||
    row.newManifestBytesHash !== input.targetManifestHash ||
    !exactBytes(input.targetManifestBody, row.newManifestBytes) ||
    row.requestDigest !== input.requestDigest ||
    !exactBytes(input.canonicalRequestBody, row.requestBytes)
  ) failure("MANIFEST_ACTIVATION_IDEMPOTENCY_CONFLICT");
}

function stateBody(row: StateRow): string {
  return row.activeStateBytes === null
    ? canonicalJson({
      generation: 0,
      activeManifest: null,
      previousManifest: null,
      observation: null,
      terminalReceiptSha256: null,
    })
    : text(row.activeStateBytes);
}

function assertRequestMatchesState(
  request: MutationRequest,
  state: StateRow,
): void {
  if (canonicalJson(expectedState(request)) !== stateBody(state)) {
    failure("MANIFEST_ACTIVATION_STATE_CONFLICT");
  }
}

async function assertOneProviderTarget(
  transaction: CentralTransactionClient,
  state: StateRow,
  input: Readonly<{
    providerId: string;
    operation: DistributedManifestOperation;
    targetCatalogVersionId: string | null;
    targetManifest: GlobalCatalogManifestV1;
  }>,
): Promise<void> {
  const provider = await transaction.providers.findUnique({
    where: { id: input.providerId },
    select: { provider_key: true },
  });
  if (!provider) failure("MANIFEST_ACTIVATION_REQUEST_INVALID");
  const currentManifest = state.activeManifestBytes === null ||
      state.activeManifestBytesHash === null
    ? null
    : await parseTargetManifest(
      state.activeManifestBytes,
      state.activeManifestBytesHash,
    );
  const before = new Map(
    currentManifest?.providerReferences.map((reference) => [
      reference.platformKey,
      reference,
    ]) ?? [],
  );
  const after = new Map(input.targetManifest.providerReferences.map(
    (reference) => [reference.platformKey, reference],
  ));
  const added = [...after.keys()].filter((key) => !before.has(key));
  const removed = [...before.keys()].filter((key) => !after.has(key));
  const changed = [...after.keys()].filter((key) => {
    const prior = before.get(key);
    return prior !== undefined &&
      canonicalJson(prior) !== canonicalJson(after.get(key));
  });
  const only = (values: readonly string[]) =>
    values.length === 1 && values[0] === provider.provider_key;
  const semanticMatch = input.operation === "add"
    ? only(added) && removed.length === 0 && changed.length === 0
    : input.operation === "remove"
      ? only(removed) && added.length === 0 && changed.length === 0
      : only(changed) && added.length === 0 && removed.length === 0;
  if (!semanticMatch) failure("MANIFEST_ACTIVATION_REQUEST_INVALID");
  for (const [providerKey, reference] of before) {
    if (providerKey === provider.provider_key) continue;
    const selected = after.get(providerKey);
    if (selected === undefined || canonicalJson(selected) !== canonicalJson(reference)) {
      failure("MANIFEST_ACTIVATION_REQUEST_INVALID");
    }
  }
  if (input.operation === "remove") return;
  const selected = after.get(provider.provider_key);
  const catalogVersionId = input.targetCatalogVersionId;
  if (
    selected === undefined ||
    catalogVersionId === null ||
    selected.sharedConfigurationEpoch.configurationKey !==
      `catalog-version:${catalogVersionId.toLowerCase()}`
  ) failure("MANIFEST_ACTIVATION_REQUEST_INVALID");
  const catalog = await transaction.catalog_versions.findUnique({
    where: { id: catalogVersionId },
    select: { lifecycle: true },
  });
  if (catalog?.lifecycle !== "complete") {
    failure("MANIFEST_ACTIVATION_REQUEST_INVALID");
  }
}

async function receiptFor(
  request: MutationRequest,
  evidence: ExactManifestActivationReceiptEvidence,
): Promise<MutationReceipt> {
  if (
    !SHA256_PATTERN.test(evidence.receiptSha256) ||
    !SHA256_PATTERN.test(evidence.exactResponseSha256) ||
    sha256(evidence.canonicalReceiptBody) !== evidence.receiptSha256 ||
    sha256(evidence.exactResponseBody) !== evidence.exactResponseSha256
  ) failure("MANIFEST_ACTIVATION_RECEIPT_INVALID");
  let receiptValue: unknown;
  let responseValue: unknown;
  try {
    receiptValue = JSON.parse(evidence.canonicalReceiptBody) as unknown;
    responseValue = JSON.parse(evidence.exactResponseBody) as unknown;
  } catch {
    failure("MANIFEST_ACTIVATION_RECEIPT_INVALID");
  }
  const parsed = catalogManifestActivationReceiptSchema.safeParse(receiptValue);
  const response = catalogManifestSignedReceiptEnvelopeSchema.safeParse(
    responseValue,
  );
  const target = requestTarget(request);
  if (
    !parsed.success ||
    !response.success ||
    canonicalJson(parsed.data) !== evidence.canonicalReceiptBody ||
    canonicalJson(response.data.receipt) !== evidence.canonicalReceiptBody ||
    await catalogManifestReceiptDigest(parsed.data) !==
      parsed.data.receiptDigest ||
    parsed.data.operationId !== request.operationId ||
    parsed.data.idempotencyKey !== request.idempotencyKey ||
    parsed.data.requestDigest !== sha256(canonicalJson(request)) ||
    parsed.data.publicReleaseId !== target.publicReleaseId ||
    parsed.data.manifestFingerprint !== target.manifestFingerprint ||
    canonicalJson(parsed.data.details.expectedActiveState) !==
      canonicalJson(request.expectedActiveState) ||
    parsed.data.operationKind !== "activateManifest"
  ) failure("MANIFEST_ACTIVATION_RECEIPT_INVALID");
  return parsed.data;
}

/** Central-only exact manifest activation ledger and coordination mirror. */
export class PrismaManifestActivationRepository {
  constructor(private readonly central: CentralPrismaClient) {}

  async loadMirror(
    deadline?: ManifestActivationTransactionDeadline,
  ): Promise<ManifestActivationMirror> {
    const [row] = await this.central.$transaction(
      (transaction) => transaction.$queryRaw<StateRow[]>(CentralPrisma.sql`
        select ${stateProjection}
        from manifest_activation_state
        where singleton_key
      `),
      transactionOptions(deadline),
    );
    if (!row) throw new Error("Manifest activation singleton is missing.");
    return mapState(row);
  }

  async loadOperation(operationId: string): Promise<ManifestActivationIntent | null> {
    assertUuid(operationId);
    const [row] = await this.central.$queryRaw<OperationRow[]>(CentralPrisma.sql`
      select ${operationProjection}
      from manifest_activation_operations
      where id = ${operationId}::uuid
    `);
    return row ? mapOperation(row) : null;
  }

  async claimLease(
    owner: string,
    leaseMilliseconds: number,
    deadline?: ManifestActivationTransactionDeadline,
  ): Promise<ManifestActivationLease> {
    assertLeaseInput(owner, leaseMilliseconds);
    return this.central.$transaction(async (transaction) => {
      const state = await lockState(transaction);
      const databaseNow = state.databaseNow!;
      if (
        state.leaseOwner !== null &&
        state.leaseExpiresAt !== null &&
        state.leaseExpiresAt > databaseNow
      ) failure("MANIFEST_ACTIVATION_LEASE_HELD");
      const [claimed] = await transaction.$queryRaw<Array<{
        readonly leaseFence: bigint;
        readonly leaseExpiresAt: Date;
      }>>(CentralPrisma.sql`
        update manifest_activation_state
        set lease_owner = ${owner},
            lease_fence = lease_fence + 1,
            lease_expires_at = ${databaseNow}
              + ${leaseMilliseconds} * interval '1 millisecond',
            row_version = row_version + 1,
            updated_at = greatest(
              updated_at + interval '1 microsecond', ${databaseNow}
            )
        where singleton_key
        returning lease_fence as "leaseFence",
                  lease_expires_at as "leaseExpiresAt"
      `);
      if (!claimed) failure("MANIFEST_ACTIVATION_LEASE_LOST");
      return {
        owner,
        fence: claimed.leaseFence,
        expiresAt: claimed.leaseExpiresAt,
      };
    }, transactionOptions(deadline));
  }

  async renewLease(
    lease: ManifestActivationLease,
    leaseMilliseconds: number,
  ): Promise<ManifestActivationLease> {
    assertLeaseInput(lease.owner, leaseMilliseconds);
    return this.central.$transaction(async (transaction) => {
      const state = await lockState(transaction);
      const databaseNow = requireLease(state, lease);
      const [renewed] = await transaction.$queryRaw<Array<{
        readonly leaseExpiresAt: Date;
      }>>(CentralPrisma.sql`
        update manifest_activation_state
        set lease_expires_at = ${databaseNow}
              + ${leaseMilliseconds} * interval '1 millisecond',
            row_version = row_version + 1,
            updated_at = greatest(
              updated_at + interval '1 microsecond', ${databaseNow}
            )
        where singleton_key
          and lease_owner = ${lease.owner}
          and lease_fence = ${lease.fence}
        returning lease_expires_at as "leaseExpiresAt"
      `);
      if (!renewed) failure("MANIFEST_ACTIVATION_LEASE_LOST");
      return { ...lease, expiresAt: renewed.leaseExpiresAt };
    }, TRANSACTION);
  }

  async releaseLease(
    lease: ManifestActivationLease,
    deadline?: ManifestActivationTransactionDeadline,
  ): Promise<boolean> {
    return this.central.$transaction(async (transaction) => {
      const state = await lockState(transaction);
      requireLease(state, lease);
      const changed = await transaction.$executeRaw(CentralPrisma.sql`
        update manifest_activation_state
        set lease_owner = null,
            lease_expires_at = null,
            row_version = row_version + 1,
            updated_at = greatest(
              updated_at + interval '1 microsecond', ${state.databaseNow!}
            )
        where singleton_key
          and lease_owner = ${lease.owner}
          and lease_fence = ${lease.fence}
      `);
      return changed === 1;
    }, transactionOptions(deadline));
  }

  async persistIntent(
    lease: ManifestActivationLease,
    input: ExactManifestActivationIntentInput,
    deadline?: ManifestActivationTransactionDeadline,
  ): Promise<ManifestActivationIntent> {
    assertUuid(input.providerId);
    if (input.requestedByOperatorId !== undefined &&
        input.requestedByOperatorId !== null) {
      assertUuid(input.requestedByOperatorId);
    }
    if (!validDate(input.requestedAt) || !SHA256_PATTERN.test(input.requestDigest)) {
      failure("MANIFEST_ACTIVATION_INPUT_INVALID");
    }
    const targetPairRequired = input.operation !== "remove";
    if (
      targetPairRequired !== (input.targetProviderReleaseId !== null) ||
      targetPairRequired !== (input.targetCatalogVersionId !== null)
    ) failure("MANIFEST_ACTIVATION_INPUT_INVALID");
    if (input.targetProviderReleaseId !== null) {
      assertUuid(input.targetProviderReleaseId);
    }
    if (input.targetCatalogVersionId !== null) {
      assertUuid(input.targetCatalogVersionId);
    }
    let targetManifest: GlobalCatalogManifestV1;
    try {
      targetManifest = await verifyGlobalCatalogManifestV1(input.targetManifest);
    } catch {
      failure("MANIFEST_ACTIVATION_INPUT_INVALID");
    }
    const targetManifestBody = canonicalJson(targetManifest);
    const targetManifestHash = sha256(targetManifestBody);
    const request = parseRequest(input.canonicalRequestBody);
    const target = requestTarget(request);
    if (
      sha256(input.canonicalRequestBody) !== input.requestDigest ||
      target.publicReleaseId !== targetManifest.publicReleaseId ||
      target.manifestFingerprint !== targetManifest.manifestFingerprint ||
      canonicalJson(request.manifest) !== targetManifestBody
    ) failure("MANIFEST_ACTIVATION_REQUEST_INVALID");

    return this.central.$transaction(async (transaction) => {
      const state = await lockState(transaction);
      requireLease(state, lease);
      const existing = await transaction.$queryRaw<OperationRow[]>(CentralPrisma.sql`
        select ${operationProjection}
        from manifest_activation_operations
        where idempotency_key = ${request.idempotencyKey}
        for update
      `);
      if (existing[0]) {
        assertExactExisting(existing[0], {
          providerId: input.providerId,
          operation: input.operation,
          targetProviderReleaseId: input.targetProviderReleaseId,
          targetCatalogVersionId: input.targetCatalogVersionId,
          targetManifestBody,
          targetManifestHash,
          request,
          canonicalRequestBody: input.canonicalRequestBody,
          requestDigest: input.requestDigest,
        });
        return mapOperation(existing[0]);
      }
      assertRequestMatchesState(request, state);
      await assertOneProviderTarget(transaction, state, {
        providerId: input.providerId,
        operation: input.operation,
        targetCatalogVersionId: input.targetCatalogVersionId,
        targetManifest,
      });
      const [row] = await transaction.$queryRaw<OperationRow[]>(CentralPrisma.sql`
        insert into manifest_activation_operations (
          provider_id, operation, expected_manifest_id,
          target_provider_release_id, target_catalog_version_id,
          new_manifest_id, new_manifest_fingerprint,
          new_manifest_bytes, new_manifest_bytes_hash,
          idempotency_key, request_digest, request_bytes, lease_fence,
          requested_by_operator_id, requested_at
        ) values (
          ${input.providerId}::uuid, ${input.operation}::manifest_operation,
          ${request.expectedActiveState.activeManifest?.publicReleaseId ?? null},
          ${input.targetProviderReleaseId}::uuid,
          ${input.targetCatalogVersionId}::uuid,
          ${targetManifest.publicReleaseId},
          ${targetManifest.manifestFingerprint},
          ${Buffer.from(targetManifestBody, "utf8")}, ${targetManifestHash},
          ${request.idempotencyKey}, ${input.requestDigest},
          ${Buffer.from(input.canonicalRequestBody, "utf8")}, ${lease.fence},
          ${input.requestedByOperatorId ?? null}::uuid, ${input.requestedAt}
        )
        returning ${operationProjection}
      `);
      if (!row) failure("MANIFEST_ACTIVATION_EVIDENCE_INVALID");
      return mapOperation(row);
    }, transactionOptions(deadline));
  }

  async recordAttempt(input: Readonly<{
    lease: ManifestActivationLease;
    operationId: string;
    attemptedAt: Date;
  }>, deadline?: ManifestActivationTransactionDeadline): Promise<ManifestActivationIntent> {
    if (!validDate(input.attemptedAt)) {
      failure("MANIFEST_ACTIVATION_INPUT_INVALID");
    }
    return this.central.$transaction(async (transaction) => {
      const state = await lockState(transaction);
      requireLease(state, input.lease);
      const current = await operationById(transaction, input.operationId, true);
      if (!current) failure("MANIFEST_ACTIVATION_INPUT_INVALID");
      if (current.state === "accepted" || current.state === "failed") {
        return mapOperation(current);
      }
      const [row] = await transaction.$queryRaw<OperationRow[]>(CentralPrisma.sql`
        update manifest_activation_operations
        set attempt_count = attempt_count + 1,
            last_attempted_at = ${input.attemptedAt},
            completion_lease_fence = ${input.lease.fence}
        where id = ${input.operationId}::uuid
        returning ${operationProjection}
      `);
      if (!row) failure("MANIFEST_ACTIVATION_LEASE_LOST");
      return mapOperation(row);
    }, transactionOptions(deadline));
  }

  async recordAmbiguous(input: Readonly<{
    lease: ManifestActivationLease;
    operationId: string;
    failureCode: string;
    observedAt: Date;
  }>, deadline?: ManifestActivationTransactionDeadline): Promise<ManifestActivationIntent> {
    return this.#recordNonAccepted("ambiguous", input, deadline);
  }

  async recordFailed(input: Readonly<{
    lease: ManifestActivationLease;
    operationId: string;
    failureCode: string;
    observedAt: Date;
  }>, deadline?: ManifestActivationTransactionDeadline): Promise<ManifestActivationIntent> {
    return this.#recordNonAccepted("failed", input, deadline);
  }

  /** Persists every exact signed status response before recovery dispatch or
   * acknowledgement. A not-found probe is durable evidence, not an in-memory
   * branch. */
  async recordStatusObservation(input: Readonly<{
    lease: ManifestActivationLease;
    operationId: string;
    evidence: ExactManifestActivationReceiptEvidence;
    observedAt: Date;
  }>, deadline?: ManifestActivationTransactionDeadline): Promise<ManifestActivationStatusObservation> {
    assertUuid(input.operationId);
    if (!validDate(input.observedAt)) {
      failure("MANIFEST_ACTIVATION_INPUT_INVALID");
    }
    const envelope = exactSignedEnvelope(input.evidence);
    await assertSignedEnvelopeDigest(envelope);
    return this.central.$transaction(async (transaction) => {
      const state = await lockState(transaction);
      requireLease(state, input.lease);
      const current = await operationById(transaction, input.operationId, true);
      if (!current || current.state === "failed") {
        failure("MANIFEST_ACTIVATION_STATUS_INVALID");
      }
      const intent = await mapOperation(current);
      const request = this.statusRequest(intent);
      const requestBody = canonicalJson(request);
      const requestDigest = sha256(requestBody);
      let resultKind: ManifestActivationStatusObservation["resultKind"];
      const notFound = catalogManifestStatusNotFoundReceiptSchema.safeParse(
        envelope.receipt,
      );
      if (notFound.success) {
        if (
          canonicalJson(notFound.data.target) !==
            canonicalJson(request.target) ||
          notFound.data.requestDigest !== intent.requestDigest
        ) failure("MANIFEST_ACTIVATION_STATUS_INVALID");
        resultKind = "not_found";
      } else {
        const found = catalogManifestReceiptSchema.safeParse(envelope.receipt);
        if (!found.success || found.data.operationKind === "activeState") {
          failure("MANIFEST_ACTIVATION_STATUS_INVALID");
        }
        await receiptFor(
          parseRequest(text(current.requestBytes)),
          input.evidence,
        );
        resultKind = "terminal";
      }
      const inserted = await transaction.$executeRaw(CentralPrisma.sql`
        insert into manifest_activation_status_observations (
          operation_id, lease_fence, result_kind,
          request_digest, request_bytes, receipt_hash, receipt_bytes,
          response_digest, response_bytes, observed_at
        ) values (
          ${input.operationId}::uuid, ${input.lease.fence}, ${resultKind},
          ${requestDigest}, ${Buffer.from(requestBody, "utf8")},
          ${input.evidence.receiptSha256},
          ${Buffer.from(input.evidence.canonicalReceiptBody, "utf8")},
          ${input.evidence.exactResponseSha256},
          ${Buffer.from(input.evidence.exactResponseBody, "utf8")},
          ${input.observedAt}
        ) on conflict (operation_id, response_digest) do nothing
      `);
      if (inserted === 0) {
        const [existing] = await transaction.$queryRaw<Array<{
          resultKind: string;
          requestDigest: string;
          requestBytes: Uint8Array;
          receiptHash: string;
          receiptBytes: Uint8Array;
          responseBytes: Uint8Array;
        }>>(CentralPrisma.sql`
          select result_kind as "resultKind",
                 request_digest as "requestDigest",
                 request_bytes as "requestBytes",
                 receipt_hash as "receiptHash",
                 receipt_bytes as "receiptBytes",
                 response_bytes as "responseBytes"
          from manifest_activation_status_observations
          where operation_id = ${input.operationId}::uuid
            and response_digest = ${input.evidence.exactResponseSha256}
        `);
        if (
          !existing || existing.resultKind !== resultKind ||
          existing.requestDigest !== requestDigest ||
          existing.receiptHash !== input.evidence.receiptSha256 ||
          !exactBytes(requestBody, existing.requestBytes) ||
          !exactBytes(input.evidence.canonicalReceiptBody, existing.receiptBytes) ||
          !exactBytes(input.evidence.exactResponseBody, existing.responseBytes)
        ) failure("MANIFEST_ACTIVATION_STATUS_INVALID");
      }
      return {
        operationId: input.operationId,
        resultKind,
        requestDigest,
        responseDigest: input.evidence.exactResponseSha256,
        observedAt: input.observedAt,
      };
    }, transactionOptions(deadline));
  }

  /** Adopts an already-active signed Convex state or reconciles a later signed
   * observation. This never sends a mutation and explicitly refuses a cleared
   * state. Exact active and previous manifest bytes must be supplied. */
  async reconcileSignedActiveState(input: Readonly<{
    lease: ManifestActivationLease;
    observationKind: "bootstrap" | "reconciliation";
    evidence: SignedManifestActiveStateEvidence;
    observedAt: Date;
  }>, deadline?: ManifestActivationTransactionDeadline): Promise<ManifestActivationMirror> {
    if (!validDate(input.observedAt)) {
      failure("MANIFEST_ACTIVATION_INPUT_INVALID");
    }
    const envelope = exactSignedEnvelope(input.evidence);
    await assertSignedEnvelopeDigest(envelope);
    const parsedReceipt = catalogManifestActiveStateReceiptSchema.safeParse(
      envelope.receipt,
    );
    const expectedRequestDigest = await catalogManifestPublicationRequestDigest(
      ACTIVE_STATE_REQUEST,
    );
    if (
      !parsedReceipt.success ||
      parsedReceipt.data.operationId !== ACTIVE_STATE_REQUEST.operationId ||
      parsedReceipt.data.requestDigest !== expectedRequestDigest ||
      parsedReceipt.data.receiptDigest !==
        await catalogManifestReceiptDigest(parsedReceipt.data)
    ) failure("MANIFEST_ACTIVATION_RECONCILIATION_INVALID");
    let activeManifest: GlobalCatalogManifestV1 | null = null;
    let previousManifest: GlobalCatalogManifestV1 | null = null;
    try {
      activeManifest = input.evidence.activeManifest === null
        ? null
        : await verifyGlobalCatalogManifestV1(input.evidence.activeManifest);
      previousManifest = input.evidence.previousManifest === null
        ? null
        : await verifyGlobalCatalogManifestV1(input.evidence.previousManifest);
    } catch {
      failure("MANIFEST_ACTIVATION_RECONCILIATION_INVALID");
    }
    const observedState = parsedReceipt.data.details.activeState;
    assertStateManifestBinding({
      state: observedState,
      activeManifest,
      previousManifest,
    });
    const activeBody = activeManifest === null
      ? null
      : canonicalJson(activeManifest);
    const previousBody = previousManifest === null
      ? null
      : canonicalJson(previousManifest);
    const stateBody = canonicalJson(observedState);
    return this.central.$transaction(async (transaction) => {
      const current = await lockState(transaction);
      requireLease(current, input.lease);
      if (
        input.observationKind === "bootstrap" &&
        (current.activeGeneration !== 0n || current.activeManifestId !== null)
      ) failure("MANIFEST_ACTIVATION_RECONCILIATION_INVALID");
      const observedGeneration = BigInt(observedState.generation);
      if (observedGeneration < current.activeGeneration) {
        failure("MANIFEST_ACTIVATION_RECONCILIATION_INVALID");
      }
      const sameGeneration = observedGeneration === current.activeGeneration;
      if (
        sameGeneration && current.activeManifestId !== null &&
        (
          activeBody === null || current.activeManifestBytes === null ||
          current.activeStateBytes === null ||
          !exactBytes(activeBody, current.activeManifestBytes) ||
          !exactBytes(stateBody, current.activeStateBytes)
        )
      ) failure("MANIFEST_ACTIVATION_RECONCILIATION_INVALID");

      await transaction.$executeRaw(CentralPrisma.sql`
        insert into manifest_activation_state_observations (
          observation_kind, lease_fence, active_generation,
          active_manifest_id, active_manifest_fingerprint,
          active_manifest_bytes, active_manifest_bytes_hash,
          previous_manifest_id, previous_manifest_fingerprint,
          previous_manifest_bytes, previous_manifest_bytes_hash,
          active_state_bytes, active_state_hash,
          request_digest, request_bytes, convex_receipt_id,
          receipt_hash, receipt_bytes, response_digest, response_bytes,
          observed_at
        ) values (
          ${input.observationKind}, ${input.lease.fence}, ${observedGeneration},
          ${activeManifest?.publicReleaseId ?? null},
          ${activeManifest?.manifestFingerprint ?? null},
          ${activeBody === null ? null : Buffer.from(activeBody, "utf8")},
          ${activeBody === null ? null : sha256(activeBody)},
          ${previousManifest?.publicReleaseId ?? null},
          ${previousManifest?.manifestFingerprint ?? null},
          ${previousBody === null ? null : Buffer.from(previousBody, "utf8")},
          ${previousBody === null ? null : sha256(previousBody)},
          ${Buffer.from(stateBody, "utf8")}, ${sha256(stateBody)},
          ${expectedRequestDigest},
          ${Buffer.from(ACTIVE_STATE_REQUEST_BODY, "utf8")},
          ${parsedReceipt.data.receiptDigest},
          ${input.evidence.receiptSha256},
          ${Buffer.from(input.evidence.canonicalReceiptBody, "utf8")},
          ${input.evidence.exactResponseSha256},
          ${Buffer.from(input.evidence.exactResponseBody, "utf8")},
          ${input.observedAt}
        ) on conflict (response_digest, lease_fence) do nothing
      `);

      if (activeManifest === null) {
        if (current.activeManifestId !== null) {
          failure("MANIFEST_ACTIVATION_CLEAR_FORBIDDEN");
        }
        return mapState(current);
      }
      if (sameGeneration) return mapState(current);
      const [updated] = await transaction.$queryRaw<StateRow[]>(CentralPrisma.sql`
        update manifest_activation_state
        set active_generation = ${observedGeneration},
            active_manifest_id = ${activeManifest.publicReleaseId},
            active_manifest_fingerprint = ${activeManifest.manifestFingerprint},
            active_manifest_bytes = ${Buffer.from(activeBody!, "utf8")},
            active_manifest_bytes_hash = ${sha256(activeBody!)},
            active_state_bytes = ${Buffer.from(stateBody, "utf8")},
            active_state_hash = ${sha256(stateBody)},
            previous_manifest_id = ${previousManifest?.publicReleaseId ?? null},
            previous_manifest_fingerprint = ${previousManifest?.manifestFingerprint ?? null},
            previous_manifest_bytes = ${previousBody === null
              ? null
              : Buffer.from(previousBody, "utf8")},
            previous_manifest_bytes_hash = ${previousBody === null
              ? null
              : sha256(previousBody)},
            last_receipt_id = ${parsedReceipt.data.receiptDigest},
            row_version = row_version + 1,
            updated_at = greatest(
              updated_at + interval '1 microsecond', ${input.observedAt}
            )
        where singleton_key
          and lease_owner = ${input.lease.owner}
          and lease_fence = ${input.lease.fence}
        returning ${stateProjection}
      `);
      if (!updated) failure("MANIFEST_ACTIVATION_LEASE_LOST");
      return mapState(updated);
    }, transactionOptions(deadline));
  }

  async accept(input: Readonly<{
    lease: ManifestActivationLease;
    operationId: string;
    evidence: ExactManifestActivationReceiptEvidence;
    receivedAt: Date;
  }>, deadline?: ManifestActivationTransactionDeadline): Promise<Readonly<{
    operation: ManifestActivationIntent;
    mirror: ManifestActivationMirror;
  }>> {
    if (!validDate(input.receivedAt)) {
      failure("MANIFEST_ACTIVATION_INPUT_INVALID");
    }
    return this.central.$transaction(async (transaction) => {
      const state = await lockState(transaction);
      requireLease(state, input.lease);
      const current = await operationById(transaction, input.operationId, true);
      if (!current) failure("MANIFEST_ACTIVATION_INPUT_INVALID");
      if (current.state === "failed") {
        failure("MANIFEST_ACTIVATION_OPERATION_TERMINAL");
      }
      if (current.state === "accepted") {
        if (
          current.receiptHash !== input.evidence.receiptSha256 ||
          current.responseDigest !== input.evidence.exactResponseSha256 ||
          current.receiptBytes === null ||
          current.responseBytes === null ||
          !exactBytes(input.evidence.canonicalReceiptBody, current.receiptBytes) ||
          !exactBytes(input.evidence.exactResponseBody, current.responseBytes) ||
          state.lastReceiptId !== current.convexReceiptId
        ) failure("MANIFEST_ACTIVATION_RECEIPT_INVALID");
        return {
          operation: await mapOperation(current),
          mirror: await mapState(state),
        };
      }
      if (current.attemptCount < 1) {
        failure("MANIFEST_ACTIVATION_RECEIPT_INVALID");
      }
      const request = parseRequest(text(current.requestBytes));
      assertRequestMatchesState(request, state);
      const receipt = await receiptFor(request, input.evidence);
      const resultState = receipt.details.activeState;
      const activePointer = resultState.activeManifest;
      if (
        activePointer === null ||
        activePointer.publicReleaseId !== current.newManifestId ||
        activePointer.manifestFingerprint !== current.newManifestFingerprint
      ) failure("MANIFEST_ACTIVATION_RECEIPT_INVALID");
      const previousPointer = resultState.previousManifest;
      let previousManifestBytes: Uint8Array | null = null;
      let previousManifestBytesHash: string | null = null;
      if (previousPointer !== null) {
        if (
          previousPointer.publicReleaseId !== state.activeManifestId ||
          previousPointer.manifestFingerprint !== state.activeManifestFingerprint ||
          state.activeManifestBytes === null ||
          state.activeManifestBytesHash === null
        ) failure("MANIFEST_ACTIVATION_RECEIPT_INVALID");
        previousManifestBytes = state.activeManifestBytes;
        previousManifestBytesHash = state.activeManifestBytesHash;
      }
      const activeStateBody = canonicalJson({
        ...resultState,
        terminalReceiptSha256: input.evidence.receiptSha256,
      });
      const receiptId = receipt.receiptDigest;
      const [operation] = await transaction.$queryRaw<OperationRow[]>(CentralPrisma.sql`
        update manifest_activation_operations
        set state = 'accepted',
            completion_lease_fence = ${input.lease.fence},
            convex_receipt_id = ${receiptId},
            receipt_hash = ${input.evidence.receiptSha256},
            receipt = ${JSON.stringify(receipt)}::jsonb,
            receipt_bytes = ${Buffer.from(input.evidence.canonicalReceiptBody, "utf8")},
            response_digest = ${input.evidence.exactResponseSha256},
            response_bytes = ${Buffer.from(input.evidence.exactResponseBody, "utf8")},
            failure_code = null,
            completed_at = ${input.receivedAt}
        where id = ${input.operationId}::uuid
        returning ${operationProjection}
      `);
      if (!operation) failure("MANIFEST_ACTIVATION_LEASE_LOST");
      const [updated] = await transaction.$queryRaw<StateRow[]>(CentralPrisma.sql`
        update manifest_activation_state
        set active_generation = ${BigInt(resultState.generation)},
            active_manifest_id = ${current.newManifestId},
            active_manifest_fingerprint = ${current.newManifestFingerprint},
            active_manifest_bytes = ${Buffer.from(current.newManifestBytes)},
            active_manifest_bytes_hash = ${current.newManifestBytesHash},
            active_state_bytes = ${Buffer.from(activeStateBody, "utf8")},
            active_state_hash = ${sha256(activeStateBody)},
            previous_manifest_id = ${previousPointer?.publicReleaseId ?? null},
            previous_manifest_fingerprint = ${previousPointer?.manifestFingerprint ?? null},
            previous_manifest_bytes = ${previousManifestBytes === null
              ? null
              : Buffer.from(previousManifestBytes)},
            previous_manifest_bytes_hash = ${previousManifestBytesHash},
            last_receipt_id = ${receiptId},
            row_version = row_version + 1,
            updated_at = greatest(
              updated_at + interval '1 microsecond', ${input.receivedAt}
            )
        where singleton_key
          and lease_owner = ${input.lease.owner}
          and lease_fence = ${input.lease.fence}
        returning ${stateProjection}
      `);
      if (!updated) failure("MANIFEST_ACTIVATION_LEASE_LOST");
      return {
        operation: await mapOperation(operation),
        mirror: await mapState(updated),
      };
    }, transactionOptions(deadline));
  }

  statusRequest(intent: ManifestActivationIntent): CatalogManifestStatusRequest {
    const request = parseRequest(intent.canonicalRequestBody);
    const target = requestTarget(request);
    return catalogManifestStatusRequestSchema.parse({
      schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
      target: {
        operationKind: "activateManifest",
        operationId: request.operationId,
        idempotencyKey: request.idempotencyKey,
        requestDigest: intent.requestDigest,
        publicReleaseId: target.publicReleaseId,
        manifestFingerprint: target.manifestFingerprint,
      },
    });
  }

  async #recordNonAccepted(
    state: "ambiguous" | "failed",
    input: Readonly<{
      lease: ManifestActivationLease;
      operationId: string;
      failureCode: string;
      observedAt: Date;
    }>,
    deadline?: ManifestActivationTransactionDeadline,
  ): Promise<ManifestActivationIntent> {
    if (
      !FAILURE_CODE_PATTERN.test(input.failureCode) ||
      !validDate(input.observedAt)
    ) failure("MANIFEST_ACTIVATION_INPUT_INVALID");
    return this.central.$transaction(async (transaction) => {
      const singleton = await lockState(transaction);
      requireLease(singleton, input.lease);
      const current = await operationById(transaction, input.operationId, true);
      if (!current) failure("MANIFEST_ACTIVATION_INPUT_INVALID");
      if (current.state === "accepted" || current.state === "failed") {
        if (current.state === state && current.failureCode === input.failureCode) {
          return mapOperation(current);
        }
        failure("MANIFEST_ACTIVATION_OPERATION_TERMINAL");
      }
      if (current.state === "ambiguous") {
        if (state === "ambiguous" && current.failureCode === input.failureCode) {
          return mapOperation(current);
        }
      }
      if (current.attemptCount < 1) {
        failure("MANIFEST_ACTIVATION_INPUT_INVALID");
      }
      const [row] = await transaction.$queryRaw<OperationRow[]>(CentralPrisma.sql`
        update manifest_activation_operations
        set state = ${state}::publication_operation_state,
            completion_lease_fence = ${input.lease.fence},
            failure_code = ${input.failureCode},
            completed_at = ${input.observedAt}
        where id = ${input.operationId}::uuid
        returning ${operationProjection}
      `);
      if (!row) failure("MANIFEST_ACTIVATION_LEASE_LOST");
      return mapOperation(row);
    }, transactionOptions(deadline));
  }
}

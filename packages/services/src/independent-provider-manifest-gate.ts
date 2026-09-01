import {
  CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
  activeCatalogManifestStateV1Schema,
  buildGlobalCatalogAggregateObservationV1,
  canonicalJson,
  catalogManifestActivateRequestSchema,
  catalogManifestPublicationRequestDigest,
  catalogManifestRollbackToManifestRequestSchema,
  globalCatalogProviderActiveObservationV1Schema,
  providerReleaseCompletedHeadV1Schema,
  verifyGlobalCatalogManifestV1,
  type ActiveCatalogManifestStateV1,
  type CatalogManifestActivateRequest,
  type CatalogManifestRollbackToManifestRequest,
  type GlobalCatalogAggregateObservationV1,
  type GlobalCatalogManifestV1,
  type GlobalCatalogProviderActiveObservationV1,
  type ProviderReleaseCompletedHeadV1,
} from "@packscout/contracts";
import type {
  CatalogManifestMutationReceiptByKind,
  SignedConvexCatalogManifestPublicationClient,
} from "./convex-catalog-manifest-publication-client.ts";
import type { SignedPublicationResult } from
  "./convex-publication-http-client.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type IndependentProviderManifestGateOperation =
  | "advance"
  | "add"
  | "remove"
  | "rollback";

export type IndependentProviderManifestGateFailureCode =
  | "PROVIDER_MANIFEST_GATE_INPUT_INVALID"
  | "PROVIDER_MANIFEST_GATE_CURRENT_STATE_INVALID"
  | "PROVIDER_MANIFEST_GATE_CANDIDATE_INVALID"
  | "PROVIDER_MANIFEST_GATE_MULTI_PROVIDER_CHANGE"
  | "PROVIDER_MANIFEST_GATE_OPERATION_MISMATCH"
  | "PROVIDER_MANIFEST_GATE_PROVIDER_MISMATCH"
  | "PROVIDER_MANIFEST_GATE_RELEASE_INCOMPLETE"
  | "PROVIDER_MANIFEST_GATE_CATALOG_MISMATCH"
  | "PROVIDER_MANIFEST_GATE_OBSERVATION_INVALID"
  | "PROVIDER_MANIFEST_GATE_CLEAR_FORBIDDEN";

export class IndependentProviderManifestGateError extends Error {
  constructor(readonly code: IndependentProviderManifestGateFailureCode) {
    super(`Independent provider manifest gate failed safely (${code}).`);
    this.name = "IndependentProviderManifestGateError";
  }
}

interface ProviderGateIdentity {
  readonly providerId: string;
  readonly providerKey: string;
}

export interface ProviderManifestCompletedTargetProof
  extends ProviderGateIdentity {
  readonly targetProviderReleaseId: string;
  readonly targetCatalogVersionId: string;
  readonly completedHead: ProviderReleaseCompletedHeadV1;
  readonly activeObservation: GlobalCatalogProviderActiveObservationV1;
}

export interface ProviderManifestRemovalTargetProof extends ProviderGateIdentity {
  readonly targetProviderReleaseId: null;
  readonly targetCatalogVersionId: null;
}

export type IndependentProviderManifestGateTarget =
  | Readonly<{
    operation: "advance" | "add" | "rollback";
    candidateManifest: GlobalCatalogManifestV1;
    proof: ProviderManifestCompletedTargetProof;
  }>
  | Readonly<{
    operation: "remove";
    candidateManifest: GlobalCatalogManifestV1;
    proof: ProviderManifestRemovalTargetProof;
  }>;

export interface IndependentProviderManifestGateCommand {
  readonly semanticOperation: IndependentProviderManifestGateOperation;
  readonly convexMutationKind: "activateManifest" | "rollback";
  readonly providerId: string;
  readonly providerKey: string;
  readonly targetProviderReleaseId: string | null;
  readonly targetCatalogVersionId: string | null;
  readonly targetManifest: GlobalCatalogManifestV1;
  readonly observation: GlobalCatalogAggregateObservationV1;
  readonly expectedActiveState: ActiveCatalogManifestStateV1;
  readonly unchangedProviderCount: number;
  readonly canonicalRequestBody: string;
  readonly requestDigest: string;
}

type ManifestRequest =
  | CatalogManifestActivateRequest
  | CatalogManifestRollbackToManifestRequest;

function fail(code: IndependentProviderManifestGateFailureCode): never {
  throw new IndependentProviderManifestGateError(code);
}

function assertUuid(value: string): void {
  if (!UUID_PATTERN.test(value)) fail("PROVIDER_MANIFEST_GATE_INPUT_INVALID");
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function manifestPointer(manifest: GlobalCatalogManifestV1) {
  return {
    publicReleaseId: manifest.publicReleaseId,
    manifestFingerprint: manifest.manifestFingerprint,
    sharedConfigurationEpoch: manifest.sharedConfigurationEpoch,
    providerReferenceSetHash: manifest.providerReferenceSetHash,
  };
}

function assertCurrentBinding(
  currentManifest: GlobalCatalogManifestV1 | null,
  activeState: ActiveCatalogManifestStateV1,
): void {
  if (currentManifest === null) {
    if (activeState.activeManifest !== null || activeState.observation !== null) {
      fail("PROVIDER_MANIFEST_GATE_CURRENT_STATE_INVALID");
    }
    return;
  }
  if (
    activeState.activeManifest === null ||
    activeState.observation === null ||
    !same(manifestPointer(currentManifest), {
      publicReleaseId: activeState.activeManifest.publicReleaseId,
      manifestFingerprint: activeState.activeManifest.manifestFingerprint,
      sharedConfigurationEpoch:
        activeState.activeManifest.sharedConfigurationEpoch,
      providerReferenceSetHash:
        activeState.activeManifest.providerReferenceSetHash,
    }) ||
    activeState.observation.publicReleaseId !== currentManifest.publicReleaseId ||
    activeState.observation.providerReferenceSetHash !==
      currentManifest.providerReferenceSetHash
  ) fail("PROVIDER_MANIFEST_GATE_CURRENT_STATE_INVALID");
  for (const [index, reference] of currentManifest.providerReferences.entries()) {
    const observation = activeState.observation.providerSelections[index];
    if (
      observation === undefined ||
      observation.platformKey !== reference.platformKey ||
      observation.publicProviderReleaseId !== reference.publicProviderReleaseId
    ) fail("PROVIDER_MANIFEST_GATE_CURRENT_STATE_INVALID");
  }
}

function changedProviderKeys(
  current: GlobalCatalogManifestV1 | null,
  candidate: GlobalCatalogManifestV1,
): Readonly<{
  added: readonly string[];
  removed: readonly string[];
  changed: readonly string[];
}> {
  const before = new Map(
    current?.providerReferences.map((reference) => [
      reference.platformKey,
      reference,
    ]) ?? [],
  );
  const after = new Map(candidate.providerReferences.map((reference) => [
    reference.platformKey,
    reference,
  ]));
  return {
    added: [...after.keys()].filter((key) => !before.has(key)).sort(),
    removed: [...before.keys()].filter((key) => !after.has(key)).sort(),
    changed: [...after.keys()].filter((key) => {
      const prior = before.get(key);
      return prior !== undefined && !same(prior, after.get(key));
    }).sort(),
  };
}

function assertOneProviderOperation(
  operation: IndependentProviderManifestGateOperation,
  providerKey: string,
  current: GlobalCatalogManifestV1 | null,
  candidate: GlobalCatalogManifestV1,
): number {
  const changes = changedProviderKeys(current, candidate);
  const exact = (values: readonly string[], expected: readonly string[]) =>
    same(values, expected);
  const valid = operation === "add"
    ? exact(changes.added, [providerKey]) &&
      changes.removed.length === 0 && changes.changed.length === 0
    : operation === "remove"
      ? exact(changes.removed, [providerKey]) &&
        changes.added.length === 0 && changes.changed.length === 0
      : exact(changes.changed, [providerKey]) &&
        changes.added.length === 0 && changes.removed.length === 0;
  if (!valid) {
    const total = changes.added.length + changes.removed.length +
      changes.changed.length;
    fail(total > 1
      ? "PROVIDER_MANIFEST_GATE_MULTI_PROVIDER_CHANGE"
      : "PROVIDER_MANIFEST_GATE_OPERATION_MISMATCH");
  }
  if (operation === "remove" && candidate.providerReferences.length === 0) {
    fail("PROVIDER_MANIFEST_GATE_CLEAR_FORBIDDEN");
  }
  if (current === null) return 0;
  return operation === "add"
    ? current.providerReferences.length
    : current.providerReferences.length - 1;
}

function assertUnrelatedReferencesPreserved(
  providerKey: string,
  current: GlobalCatalogManifestV1 | null,
  candidate: GlobalCatalogManifestV1,
): void {
  if (current === null) return;
  const candidateByKey = new Map(candidate.providerReferences.map(
    (reference) => [reference.platformKey, reference],
  ));
  for (const reference of current.providerReferences) {
    if (reference.platformKey === providerKey) continue;
    const candidateReference = candidateByKey.get(reference.platformKey);
    if (candidateReference === undefined || !same(reference, candidateReference)) {
      fail("PROVIDER_MANIFEST_GATE_MULTI_PROVIDER_CHANGE");
    }
  }
}

function assertCompletedTarget(
  candidate: GlobalCatalogManifestV1,
  proof: ProviderManifestCompletedTargetProof,
): Readonly<{
  completedHead: ProviderReleaseCompletedHeadV1;
  activeObservation: GlobalCatalogProviderActiveObservationV1;
}> {
  assertUuid(proof.providerId);
  assertUuid(proof.targetProviderReleaseId);
  assertUuid(proof.targetCatalogVersionId);
  const completed = providerReleaseCompletedHeadV1Schema.safeParse(
    proof.completedHead,
  );
  const observation = globalCatalogProviderActiveObservationV1Schema.safeParse(
    proof.activeObservation,
  );
  if (!completed.success) fail("PROVIDER_MANIFEST_GATE_RELEASE_INCOMPLETE");
  if (!observation.success) fail("PROVIDER_MANIFEST_GATE_OBSERVATION_INVALID");
  const reference = candidate.providerReferences.find(
    ({ platformKey }) => platformKey === proof.providerKey,
  );
  if (
    completed.data.platformKey !== proof.providerKey ||
    completed.data.release.platformKey !== proof.providerKey ||
    reference === undefined ||
    !same(reference, completed.data.release)
  ) fail("PROVIDER_MANIFEST_GATE_PROVIDER_MISMATCH");
  if (
    completed.data.release.sharedConfigurationEpoch.configurationKey !==
      `catalog-version:${proof.targetCatalogVersionId.toLowerCase()}`
  ) fail("PROVIDER_MANIFEST_GATE_CATALOG_MISMATCH");
  if (
    observation.data.platformKey !== proof.providerKey ||
    observation.data.publicProviderReleaseId !==
      completed.data.release.publicProviderReleaseId ||
    observation.data.terminalReceiptSha256 !==
      completed.data.terminalReceiptSha256 ||
    observation.data.selectedDataAsOf !== completed.data.release.dataAsOf ||
    !same(
      observation.data.selectedProviderCheckpoint,
      completed.data.providerCheckpoint,
    ) ||
    observation.data.latestAffectedSourceHeadSequence !==
      completed.data.observation.sourceHeadSequence ||
    observation.data.lastSuccessfulObservationAt !==
      completed.data.observation.lastSuccessfulObservationAt ||
    observation.data.staleAt !== completed.data.observation.staleAt ||
    observation.data.settledSourceFreshness !==
      completed.data.observation.freshness ||
    !observation.data.initialBackfillComplete ||
    !observation.data.affectedDerivationsSettled
  ) fail("PROVIDER_MANIFEST_GATE_OBSERVATION_INVALID");
  return {
    completedHead: completed.data,
    activeObservation: observation.data,
  };
}

function nextProviderSelections(input: Readonly<{
  operation: IndependentProviderManifestGateOperation;
  providerKey: string;
  currentState: ActiveCatalogManifestStateV1;
  targetObservation: GlobalCatalogProviderActiveObservationV1 | null;
}>): readonly GlobalCatalogProviderActiveObservationV1[] {
  const current = input.currentState.observation?.providerSelections ?? [];
  const remaining = current.filter(
    ({ platformKey }) => platformKey !== input.providerKey,
  );
  const selections = input.operation === "remove"
    ? remaining
    : [...remaining, input.targetObservation!];
  return selections.sort((left, right) =>
    codeUnitCompare(left.platformKey, right.platformKey));
}

function buildRequest(input: Readonly<{
  operation: IndependentProviderManifestGateOperation;
  operationId: string;
  idempotencyKey: string;
  manifest: GlobalCatalogManifestV1;
  observation: GlobalCatalogAggregateObservationV1;
  expectedActiveState: ActiveCatalogManifestStateV1;
}>): Readonly<{
  kind: "activateManifest" | "rollback";
  request: ManifestRequest;
}> {
  if (input.operation === "rollback") {
    return {
      kind: "rollback",
      request: catalogManifestRollbackToManifestRequestSchema.parse({
        schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
        operationId: input.operationId,
        idempotencyKey: input.idempotencyKey,
        rollbackKind: "manifest",
        targetManifest: manifestPointer(input.manifest),
        observation: input.observation,
        expectedActiveState: input.expectedActiveState,
      }),
    };
  }
  return {
    kind: "activateManifest",
    request: catalogManifestActivateRequestSchema.parse({
      schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
      operationId: input.operationId,
      idempotencyKey: input.idempotencyKey,
      manifest: input.manifest,
      observation: input.observation,
      expectedActiveState: input.expectedActiveState,
    }),
  };
}

/**
 * Builds one exact Convex command from an exact active snapshot and one target
 * provider proof. The candidate carries the already-recomputed aggregate
 * proofs; this boundary verifies them and proves that every unrelated provider
 * reference remains byte-identical before any request can be signed.
 */
export async function composeIndependentProviderManifestGate(
  input: Readonly<{
    operationId: string;
    idempotencyKey: string;
    currentManifest: GlobalCatalogManifestV1 | null;
    currentActiveState: ActiveCatalogManifestStateV1;
    target: IndependentProviderManifestGateTarget;
  }>,
): Promise<IndependentProviderManifestGateCommand> {
  let activeState: ActiveCatalogManifestStateV1;
  let currentManifest: GlobalCatalogManifestV1 | null;
  let candidateManifest: GlobalCatalogManifestV1;
  try {
    activeState = activeCatalogManifestStateV1Schema.parse(
      input.currentActiveState,
    );
    currentManifest = input.currentManifest === null
      ? null
      : await verifyGlobalCatalogManifestV1(input.currentManifest);
    candidateManifest = await verifyGlobalCatalogManifestV1(
      input.target.candidateManifest,
    );
  } catch {
    fail("PROVIDER_MANIFEST_GATE_CANDIDATE_INVALID");
  }
  assertCurrentBinding(currentManifest, activeState);
  const proof = input.target.proof;
  assertUuid(proof.providerId);
  if (proof.providerKey.trim() !== proof.providerKey || proof.providerKey === "") {
    fail("PROVIDER_MANIFEST_GATE_INPUT_INVALID");
  }
  const unchangedProviderCount = assertOneProviderOperation(
    input.target.operation,
    proof.providerKey,
    currentManifest,
    candidateManifest,
  );
  assertUnrelatedReferencesPreserved(
    proof.providerKey,
    currentManifest,
    candidateManifest,
  );

  let targetObservation: GlobalCatalogProviderActiveObservationV1 | null = null;
  if (input.target.operation === "remove") {
    if (
      proof.targetProviderReleaseId !== null ||
      proof.targetCatalogVersionId !== null
    ) fail("PROVIDER_MANIFEST_GATE_OPERATION_MISMATCH");
  } else {
    targetObservation = assertCompletedTarget(
      candidateManifest,
      input.target.proof,
    ).activeObservation;
  }
  const nextSequence = (activeState.observation?.observationSequence ?? 0) + 1;
  if (!Number.isSafeInteger(nextSequence) || nextSequence < 1) {
    fail("PROVIDER_MANIFEST_GATE_OBSERVATION_INVALID");
  }
  const observation = buildGlobalCatalogAggregateObservationV1({
    observationSequence: nextSequence,
    publicReleaseId: candidateManifest.publicReleaseId,
    providerReferenceSetHash: candidateManifest.providerReferenceSetHash,
    providerSelections: nextProviderSelections({
      operation: input.target.operation,
      providerKey: proof.providerKey,
      currentState: activeState,
      targetObservation,
    }),
  });
  const prepared = buildRequest({
    operation: input.target.operation,
    operationId: input.operationId,
    idempotencyKey: input.idempotencyKey,
    manifest: candidateManifest,
    observation,
    expectedActiveState: activeState,
  });
  const canonicalRequestBody = canonicalJson(prepared.request);
  return {
    semanticOperation: input.target.operation,
    convexMutationKind: prepared.kind,
    providerId: proof.providerId.toLowerCase(),
    providerKey: proof.providerKey,
    targetProviderReleaseId: proof.targetProviderReleaseId?.toLowerCase() ?? null,
    targetCatalogVersionId: proof.targetCatalogVersionId?.toLowerCase() ?? null,
    targetManifest: candidateManifest,
    observation,
    expectedActiveState: activeState,
    unchangedProviderCount,
    canonicalRequestBody,
    requestDigest: await catalogManifestPublicationRequestDigest(
      prepared.request,
    ),
  };
}

/** Sends only the exact bytes returned by the pure gate composer. */
export function sendIndependentProviderManifestGate(
  client: Pick<SignedConvexCatalogManifestPublicationClient, "sendExact">,
  command: IndependentProviderManifestGateCommand,
  signal?: AbortSignal,
): Promise<SignedPublicationResult<
  CatalogManifestMutationReceiptByKind["activateManifest" | "rollback"]
>> {
  return client.sendExact({
    kind: command.convexMutationKind,
    canonicalRequestBody: command.canonicalRequestBody,
  }, signal);
}

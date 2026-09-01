import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { link, lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import { register } from "node:module";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const PORT = 47_432;
const HOST = "127.0.0.1";
const MAX_POLICY_BYTES = 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const SAFE_ENVIRONMENT_KEYS = ["HOME", "NODE_ENV", "PATH", "TMPDIR"];
const MACOS_INJECTED_ENVIRONMENT_KEY = "__CF_USER_TEXT_ENCODING";

function refuse() { throw new Error("CLUTCHPACKS_RECOVERY_PUBLISH_SHIM_REFUSED"); }
function absolute(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && path.isAbsolute(value) &&
    path.resolve(value) === value && !/[\r\n\0]/u.test(value);
}
function object(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse();
  return value;
}
function exactKeys(value, keys) {
  if (Object.keys(value).sort().join("\n") !== [...keys].sort().join("\n")) refuse();
}
function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = object(value);
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function readRegular(file, maximum = 256 * 1024 * 1024, minimum = 1, privateFile = false) {
  if (!absolute(file)) refuse();
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat(), outsideBefore = await lstat(file);
    if (!before.isFile() || before.size < minimum || before.size > maximum ||
      before.uid !== process.getuid?.() || (before.mode & 0o022) !== 0 ||
      (privateFile && ((before.mode & 0o777) !== 0o600 || before.nlink !== 1)) ||
      outsideBefore.isSymbolicLink() || outsideBefore.dev !== before.dev || outsideBefore.ino !== before.ino ||
      outsideBefore.uid !== before.uid || outsideBefore.gid !== before.gid || outsideBefore.mode !== before.mode ||
      outsideBefore.nlink !== before.nlink || outsideBefore.size !== before.size ||
      outsideBefore.mtimeMs !== before.mtimeMs || outsideBefore.ctimeMs !== before.ctimeMs ||
      await realpath(file) !== file) refuse();
    const bytes = await handle.readFile();
    const after = await handle.stat(), outsideAfter = await lstat(file);
    if (bytes.length !== before.size || after.dev !== before.dev || after.ino !== before.ino || after.uid !== before.uid ||
      after.gid !== before.gid || after.mode !== before.mode || after.size !== before.size ||
      after.nlink !== before.nlink || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
      outsideAfter.isSymbolicLink() || outsideAfter.dev !== before.dev || outsideAfter.ino !== before.ino ||
      outsideAfter.uid !== before.uid || outsideAfter.gid !== before.gid || outsideAfter.mode !== before.mode ||
      outsideAfter.nlink !== before.nlink || outsideAfter.size !== before.size ||
      outsideAfter.mtimeMs !== before.mtimeMs || outsideAfter.ctimeMs !== before.ctimeMs) refuse();
    return bytes;
  } finally { await handle.close(); }
}
async function verifyPin(rawPin, expectedPath, maximum) {
  const pin = object(rawPin);
  exactKeys(pin, ["path", "sha256"]);
  if (pin.path !== expectedPath || !absolute(pin.path) || typeof pin.sha256 !== "string" || !HASH.test(pin.sha256)) refuse();
  if (sha256(await readRegular(pin.path, maximum)) !== pin.sha256) refuse();
  return Object.freeze({ path: pin.path, sha256: pin.sha256 });
}
async function verifyPrivatePin(rawPin, expectedPath, maximum) {
  const pin = object(rawPin); exactKeys(pin, ["path", "sha256"]);
  if (pin.path !== expectedPath || !absolute(pin.path) || typeof pin.sha256 !== "string" || !HASH.test(pin.sha256) ||
    sha256(await readRegular(pin.path, maximum, 1, true)) !== pin.sha256) refuse();
  return Object.freeze({ path: pin.path, sha256: pin.sha256 });
}
async function installPrivateExact(file, bytes) {
  if (!absolute(file)) refuse();
  const temporary = path.join(path.dirname(file), `.clutchpacks-recovery-shim-${randomUUID()}.tmp`);
  const handle = await open(temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(bytes); await handle.sync(); await handle.close();
    await link(temporary, file); await syncDirectory(path.dirname(file));
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    await syncDirectory(path.dirname(file)).catch(() => undefined);
  }
}
async function exists(file) {
  try { await readRegular(file, 1024 * 1024, 1, true); return true; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}
function same(left, right) { return canonical(left) === canonical(right); }
function normalizeSealedEnvironment(source, expected,
  platform = process.platform, uid = process.getuid?.()) {
  const environment = Object.fromEntries(Object.entries(object(source)));
  if (Object.hasOwn(environment, MACOS_INJECTED_ENVIRONMENT_KEY)) {
    if (platform !== "darwin" || !Number.isSafeInteger(uid) || uid < 0 ||
      environment[MACOS_INJECTED_ENVIRONMENT_KEY] !== `0x${uid.toString(16).toUpperCase()}:0x0:0x0`) refuse();
    delete environment[MACOS_INJECTED_ENVIRONMENT_KEY];
  }
  exactKeys(environment, SAFE_ENVIRONMENT_KEYS);
  if (expected !== undefined && !same(environment, expected)) refuse();
  return Object.freeze(Object.fromEntries(SAFE_ENVIRONMENT_KEYS.map(key => [key, environment[key]])));
}
function validateIncidentManifestDocument(value, rawPin, policy) {
  const manifest = object(value);
  exactKeys(manifest, ["schemaVersion", "createdAt", "incidentId", "ledgerPath", "recordsPath",
    "ledgerSchemaSha256", "head", "freshnessCutoff", "old", "oldRootInventorySha256", "publisher",
    "executor", "sourceReader", "roots", "manifestSha256"]);
  const { manifestSha256, ...manifestCore } = manifest;
  if (manifest.schemaVersion !== "clutchpacks_production_post_head_successor_recovery_manifest_v1" ||
    typeof manifestSha256 !== "string" || !HASH.test(manifestSha256) ||
    sha256(canonical(manifestCore)) !== manifestSha256 || manifest.ledgerPath !== policy.ledgerPath ||
    manifest.recordsPath !== path.join(policy.ledgerPath, "records") || !same(manifest.roots, policy.roots) ||
    !same(manifest.publisher, policy.publisher) || !same(manifest.executor, policy.executor) ||
    !same(manifest.sourceReader, policy.sourceReader) || rawPin.path !== path.join(policy.ledgerPath, "incident-manifest.json")) {
    refuse();
  }
  return manifest;
}
function validateLedgerManifestDomain(record, manifest, rawPin) {
  if (record.manifestSha256 !== manifest.manifestSha256 || record.incidentId !== manifest.incidentId ||
    record.ledgerSchemaSha256 !== manifest.ledgerSchemaSha256 || rawPin.sha256 === manifest.manifestSha256) refuse();
}
function validIso(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function validUuid(value) { return typeof value === "string" && UUID.test(value); }
function validHash(value) { return typeof value === "string" && HASH.test(value); }
function safeInteger(value, minimum = 0) { return Number.isSafeInteger(value) && value >= minimum; }
function validateFilePinShape(value) {
  const pin = object(value); exactKeys(pin, ["path", "sha256"]);
  if (!absolute(pin.path) || !validHash(pin.sha256)) refuse(); return pin;
}
function validateHeadSnapshot(value) {
  const head = object(value); exactKeys(head, ["providerId", "configId", "configNumber", "runId", "checkpointHash",
    "generation", "runtimeRowVersion", "headFinishedAt", "authorityDigest"]);
  if (!validUuid(head.providerId) || !validUuid(head.configId) || !validUuid(head.runId) ||
    typeof head.configNumber !== "string" || typeof head.generation !== "string" ||
    typeof head.runtimeRowVersion !== "string" || !validHash(head.checkpointHash) ||
    !validHash(head.authorityDigest) || !validIso(head.headFinishedAt)) refuse();
  return head;
}
function validateSourceProof(value) {
  const proof = object(value); exactKeys(proof, ["startedAt", "completedAt", "snapshot"]);
  const snapshot = object(proof.snapshot); exactKeys(snapshot, ["providerId", "configId", "configNumber", "runId",
    "checkpointHash", "generation", "runtimeRowVersion", "headFinishedAt", "authorityDigest", "runtimeState",
    "disposition", "importLeaseOwned", "assertionProvenance"]);
  validateHeadSnapshot(Object.fromEntries(Object.entries(snapshot).filter(([key]) =>
    !["runtimeState", "disposition", "importLeaseOwned", "assertionProvenance"].includes(key))));
  const provenance = object(snapshot.assertionProvenance);
  exactKeys(provenance, ["headAndImportLease", "noActiveOrActionableWork"]);
  if (snapshot.runtimeState !== "idle" || snapshot.disposition !== "due" || snapshot.importLeaseOwned !== false ||
    provenance.headAndImportLease !== "clutchpacks_poller_check_only_v1" ||
    provenance.noActiveOrActionableWork !== "continuous_decision_due_v1" ||
    !validIso(proof.startedAt) || !validIso(proof.completedAt) || proof.completedAt < proof.startedAt) refuse();
  return proof;
}
function validateQuietProof(value) {
  const proof = object(value); exactKeys(proof, ["startedAt", "completedAt", "snapshot"]);
  const snapshot = object(proof.snapshot); exactKeys(snapshot, ["providerId", "configId", "configNumber", "runId",
    "checkpointHash", "generation", "runtimeRowVersion", "headFinishedAt", "authorityDigest", "runtimeState",
    "importLeaseOwner", "importLeaseExpiresAt", "sourceStateDigest", "assertionProvenance"]);
  validateHeadSnapshot(Object.fromEntries(Object.entries(snapshot).filter(([key]) =>
    !["runtimeState", "importLeaseOwner", "importLeaseExpiresAt", "sourceStateDigest", "assertionProvenance"].includes(key))));
  if (snapshot.runtimeState !== "idle" || snapshot.importLeaseOwner !== null || snapshot.importLeaseExpiresAt !== null ||
    !validHash(snapshot.sourceStateDigest) || snapshot.assertionProvenance !== "production_source_state_strict_admission_v1" ||
    !validIso(proof.startedAt) || !validIso(proof.completedAt) || proof.completedAt < proof.startedAt) refuse();
  return proof;
}
function validateReleasePointer(value, generation = false) {
  const pointer = object(value); exactKeys(pointer, generation ? ["generation", "publicReleaseId", "releaseFingerprint"] :
    ["publicReleaseId", "releaseFingerprint"]);
  if (generation && !safeInteger(pointer.generation)) refuse();
  if (!validUuid(pointer.publicReleaseId) || !validHash(pointer.releaseFingerprint)) refuse(); return pointer;
}
function validateReleaseStatus(value) {
  const status = object(value); exactKeys(status, ["publicReleaseId", "releaseFingerprint", "lifecycle"]);
  validateReleasePointer({ publicReleaseId: status.publicReleaseId, releaseFingerprint: status.releaseFingerprint });
  if (!["staging", "complete", "failed"].includes(status.lifecycle)) refuse(); return status;
}
function validateTargetProof(value) {
  const proof = object(value); exactKeys(proof, ["startedAt", "completedAt", "snapshot"]);
  const snapshot = object(proof.snapshot); exactKeys(snapshot, ["active", "previous", "activeStatus", "previousStatus",
    "candidateStatus", "assertionProvenance"]);
  validateReleasePointer(snapshot.active, true);
  if (snapshot.previous !== null) validateReleasePointer(snapshot.previous);
  validateReleaseStatus(snapshot.activeStatus);
  if (snapshot.previousStatus !== null) validateReleaseStatus(snapshot.previousStatus);
  if (snapshot.candidateStatus !== null) validateReleaseStatus(snapshot.candidateStatus);
  const provenance = object(snapshot.assertionProvenance);
  exactKeys(provenance, ["activeChain", "lifecycle", "stagingExclusion"]);
  if (provenance.activeChain !== "signed_active_state_double_read_v1" ||
    provenance.lifecycle !== "signed_release_status_projection_v1" ||
    provenance.stagingExclusion !== "publisher_start_cas_v1" ||
    snapshot.activeStatus.lifecycle !== "complete" ||
    snapshot.activeStatus.publicReleaseId !== snapshot.active.publicReleaseId ||
    snapshot.activeStatus.releaseFingerprint !== snapshot.active.releaseFingerprint ||
    ((snapshot.previous === null) !== (snapshot.previousStatus === null)) ||
    (snapshot.previous !== null && (snapshot.previousStatus.lifecycle !== "complete" ||
      snapshot.previousStatus.publicReleaseId !== snapshot.previous.publicReleaseId ||
      snapshot.previousStatus.releaseFingerprint !== snapshot.previous.releaseFingerprint)) ||
    !validIso(proof.startedAt) || !validIso(proof.completedAt) || proof.completedAt < proof.startedAt) refuse();
  return proof;
}
function validateResidencyProof(value) {
  const proof = object(value); exactKeys(proof, ["label", "port", "launchdUnloaded", "residentProcessCount",
    "portBound", "acquiredAt", "checkedAt"]);
  if (proof.label !== "com.packscout.provider-import.clutchpacks" || proof.port !== 56_432 ||
    proof.launchdUnloaded !== true || proof.residentProcessCount !== 0 || proof.portBound !== true ||
    !validIso(proof.acquiredAt) || !validIso(proof.checkedAt) || proof.checkedAt < proof.acquiredAt) refuse();
  return proof;
}
function validateExecutionLock(value) {
  const proof = object(value); exactKeys(proof, ["port", "portBound", "acquiredAt"]);
  if (proof.port !== PORT || proof.portBound !== true || !validIso(proof.acquiredAt)) refuse(); return proof;
}
function validateTermination(value) {
  const proof = object(value); exactKeys(proof, ["checkedAt", "pid", "processGroupId", "processAbsent",
    "processGroupAbsent", "executionLock"]);
  const lock = validateExecutionLock(proof.executionLock);
  if (!validIso(proof.checkedAt) || proof.checkedAt < lock.acquiredAt || !safeInteger(proof.pid, 1) ||
    !safeInteger(proof.processGroupId, 1) || proof.processAbsent !== true || proof.processGroupAbsent !== true) refuse();
  return proof;
}
function validateUnboundAbsence(value) {
  const proof = object(value); exactKeys(proof, ["checkedAt", "matchingProcessIds", "matchingProcessGroupIds",
    "executionLock", "proofSha256"]);
  const { proofSha256, ...core } = proof, lock = validateExecutionLock(proof.executionLock);
  if (!validIso(proof.checkedAt) || proof.checkedAt < lock.acquiredAt || !Array.isArray(proof.matchingProcessIds) ||
    proof.matchingProcessIds.length !== 0 || !Array.isArray(proof.matchingProcessGroupIds) ||
    proof.matchingProcessGroupIds.length !== 0 || !validHash(proofSha256) || sha256(canonical(core)) !== proofSha256) refuse();
  return proof;
}
function validateInventory(value) {
  const inventory = object(value); exactKeys(inventory, ["entries", "xattrsSha256", "aclListingSha256", "inventorySha256"]);
  if (!Array.isArray(inventory.entries) || inventory.entries.length < 1 || inventory.entries.length > 20_000 ||
    !validHash(inventory.xattrsSha256) || !validHash(inventory.aclListingSha256) || !validHash(inventory.inventorySha256)) refuse();
  for (const entry of inventory.entries) {
    const item = object(entry), common = ["relativePath", "type", "dev", "ino", "uid", "gid", "mode", "nlink",
      "size", "flags", "birthtimeNs", "mtimeNs", "ctimeNs"];
    exactKeys(item, [...common, item.type === "directory" ? "listingSha256" : "sha256"]);
    if (typeof item.relativePath !== "string" || item.relativePath.length < 1 || item.relativePath.length > 4096 ||
      !["directory", "file"].includes(item.type) || !validHash(item[item.type === "directory" ? "listingSha256" : "sha256"]) ||
      !["dev", "ino", "uid", "gid", "mode", "nlink", "size", "birthtimeNs", "mtimeNs", "ctimeNs"].every(name =>
        typeof item[name] === "string" && /^(?:0|[1-9][0-9]*)$/u.test(item[name])) ||
      !(item.flags === null || typeof item.flags === "string" && /^(?:0|[1-9][0-9]*)$/u.test(item.flags))) refuse();
  }
  const { inventorySha256, ...core } = inventory;
  if (sha256(canonical(core)) !== inventorySha256) refuse(); return inventory;
}
function validateSidecars(value) {
  const sidecars = object(value); exactKeys(sidecars, ["lease", "observation", "receipt"]);
  for (const pin of Object.values(sidecars)) validateFilePinShape(pin); return sidecars;
}
function validateDispatchPayload(payload, record, manifest) {
  exactKeys(payload, ["phase", "attemptDirectory", "handshake", "sourcePreDispatch", "targetPreDispatch",
    "residencyPreDispatch"]);
  const run = path.join(record.root.artifactDirectory, manifest.incidentId);
  if (!absolute(payload.attemptDirectory) || path.dirname(payload.attemptDirectory) !== run ||
    !/^attempt-[a-f0-9-]{36}$/u.test(path.basename(payload.attemptDirectory)) ||
    !["direct", "adoption"].includes(payload.phase)) refuse();
  validateFilePinShape(payload.handshake); validateSourceProof(payload.sourcePreDispatch);
  validateTargetProof(payload.targetPreDispatch); validateResidencyProof(payload.residencyPreDispatch);
}
function validateLedgerPayload(record, manifest) {
  const payload = object(record.payload);
  if (record.event === "attempt_claimed") {
    exactKeys(payload, ["artifactRootAbsent", "proofRootAbsent"]);
    if (payload.artifactRootAbsent !== true || payload.proofRootAbsent !== true) refuse();
  } else if (record.event === "direct_dispatched" || record.event === "adoption_dispatched") {
    validateDispatchPayload(payload, record, manifest);
  } else if (record.event === "direct_verified") {
    exactKeys(payload, ["attemptDirectory", "bundle", "evidenceSha256", "sidecars", "target",
      "attemptVerified", "runVerified"]);
    if (!absolute(payload.attemptDirectory) || path.dirname(payload.attemptDirectory) !==
      path.join(record.root.artifactDirectory, manifest.incidentId) || !validHash(payload.evidenceSha256)) refuse();
    validateFilePinShape(payload.bundle); validateSidecars(payload.sidecars); validateTargetProof(payload.target);
    validateFilePinShape(payload.attemptVerified); validateFilePinShape(payload.runVerified);
  } else if (record.event === "retry_authorized") {
    if (payload.reason === "claim_interrupted") {
      exactKeys(payload, ["reason", "termination", "source", "quiet", "target", "residency",
        "abandonedArtifactRoot", "abandonedProofRoot"]);
      validateUnboundAbsence(payload.termination);
      for (const [name, expectedPath] of [["abandonedArtifactRoot", record.root.artifactDirectory],
        ["abandonedProofRoot", record.root.proofDirectory]]) {
        const abandoned = object(payload[name]);
        if (abandoned.state === "absent") {
          exactKeys(abandoned, ["state", "path", "checkedAt"]); if (abandoned.path !== expectedPath || !validIso(abandoned.checkedAt)) refuse();
        } else if (abandoned.state === "present") {
          exactKeys(abandoned, ["state", "path", "inventory"]); if (abandoned.path !== expectedPath) refuse();
          validateInventory(abandoned.inventory);
        } else refuse();
      }
    } else if (payload.reason === "no_durable_receipt" || payload.reason === "adoption_interrupted_pending") {
      exactKeys(payload, ["reason", "termination", "source", "quiet", "target", "residency",
        "abandonedArtifactInventory", "abandonedProofInventory", "interruptedAdoption"]);
      validateTermination(payload.termination); validateInventory(payload.abandonedArtifactInventory);
      validateInventory(payload.abandonedProofInventory);
      if (payload.reason === "no_durable_receipt") { if (payload.interruptedAdoption !== null) refuse(); }
      else {
        const interrupted = object(payload.interruptedAdoption);
        exactKeys(interrupted, ["pendingHead", "pendingBlocked", "attemptDirectory", "attemptFiles", "sidecarNames"]);
        validateFilePinShape(interrupted.pendingHead); validateFilePinShape(interrupted.pendingBlocked);
        if (!absolute(interrupted.attemptDirectory) || !Array.isArray(interrupted.attemptFiles) ||
          interrupted.attemptFiles.length < 4 || interrupted.attemptFiles.length > 5 ||
          !Array.isArray(interrupted.sidecarNames) || interrupted.sidecarNames.length !== 3) refuse();
        interrupted.attemptFiles.forEach(validateFilePinShape);
        if (interrupted.sidecarNames.some(name => typeof name !== "string" || name.length < 1 || name.length > 256)) refuse();
      }
    } else refuse();
    validateSourceProof(payload.source); validateQuietProof(payload.quiet); validateTargetProof(payload.target);
    validateResidencyProof(payload.residency);
  } else if (record.event === "complete") {
    exactKeys(payload, ["successorReceipt", "bundle", "firstSidecars", "reentrySidecars", "finalTarget", "sourceFinal"]);
    validateFilePinShape(payload.successorReceipt); validateFilePinShape(payload.bundle);
    validateSidecars(payload.firstSidecars); validateSidecars(payload.reentrySidecars);
    validateTargetProof(payload.finalTarget); validateSourceProof(payload.sourceFinal);
  } else if (record.event === "terminal") {
    exactKeys(payload, ["reason", "evidenceSha256"]);
    if (!["unknown_child", "source_stale_or_moved", "target_rollback_or_divergence", "lease_or_work_owned",
      "adoption_pending_retained", "evidence_invalid", "direct_retry_exhausted", "claim_retry_exhausted"].includes(payload.reason) ||
      !(payload.evidenceSha256 === null || validHash(payload.evidenceSha256))) refuse();
  } else refuse();
  return payload;
}
function validateLedgerChain(records, manifest) {
  let status = "empty", ordinal = 0, tail = null, retryUsed = false;
  for (const [index, raw] of records.entries()) {
    const record = object(raw);
    exactKeys(record, ["schemaVersion", "sequence", "previousRecordSha256", "manifestSha256",
      "ledgerSchemaSha256", "incidentId", "recordedAt", "ordinal", "root", "event", "payload", "recordSha256"]);
    const { recordSha256, ...core } = record;
    const expectedRoot = manifest.roots[record.ordinal - 1];
    if (record.schemaVersion !== "clutchpacks_production_post_head_successor_ledger_record_v1" ||
      record.sequence !== index || record.previousRecordSha256 !== (tail?.recordSha256 ?? null) ||
      typeof recordSha256 !== "string" || !HASH.test(recordSha256) || sha256(canonical(core)) !== recordSha256 ||
      record.manifestSha256 !== manifest.manifestSha256 || record.ledgerSchemaSha256 !== manifest.ledgerSchemaSha256 ||
      record.incidentId !== manifest.incidentId || !validUuid(record.incidentId) || !validIso(record.recordedAt) ||
      !safeInteger(record.sequence) || record.sequence > 15 || ![1, 2].includes(record.ordinal) ||
      !expectedRoot || !same(record.root, expectedRoot)) refuse();
    const payload = validateLedgerPayload(record, manifest);
    if (record.event === "attempt_claimed") {
      exactKeys(payload, ["artifactRootAbsent", "proofRootAbsent"]);
      const valid = status === "empty" && record.ordinal === 1 ||
        status === "retry_authorized" && ordinal === 1 && record.ordinal === 2 && !retryUsed;
      if (!valid || payload.artifactRootAbsent !== true || payload.proofRootAbsent !== true) refuse();
      if (record.ordinal === 2) retryUsed = true;
      ordinal = record.ordinal;
    } else {
      if (record.ordinal !== ordinal) refuse();
      let allowed = false;
      if (record.event === "direct_dispatched" || record.event === "adoption_dispatched") {
        exactKeys(payload, ["phase", "attemptDirectory", "handshake", "sourcePreDispatch", "targetPreDispatch",
          "residencyPreDispatch"]);
        allowed = record.event === "direct_dispatched" ? status === "attempt_claimed" && payload.phase === "direct" :
          status === "direct_verified" && payload.phase === "adoption";
      } else if (record.event === "direct_verified") {
        exactKeys(payload, ["attemptDirectory", "bundle", "evidenceSha256", "sidecars", "target",
          "attemptVerified", "runVerified"]); allowed = status === "direct_dispatched";
      } else if (record.event === "retry_authorized") {
        if (payload.reason === "claim_interrupted") exactKeys(payload, ["reason", "termination", "source", "quiet",
          "target", "residency", "abandonedArtifactRoot", "abandonedProofRoot"]);
        else if (payload.reason === "no_durable_receipt" || payload.reason === "adoption_interrupted_pending")
          exactKeys(payload, ["reason", "termination", "source", "quiet", "target", "residency",
            "abandonedArtifactInventory", "abandonedProofInventory", "interruptedAdoption"]);
        else refuse();
        allowed = ["attempt_claimed", "direct_dispatched", "adoption_dispatched"].includes(status) &&
          ordinal === 1 && !retryUsed;
      } else if (record.event === "complete") {
        exactKeys(payload, ["successorReceipt", "bundle", "firstSidecars", "reentrySidecars", "finalTarget", "sourceFinal"]);
        allowed = status === "adoption_dispatched";
      } else if (record.event === "terminal") {
        exactKeys(payload, ["reason", "evidenceSha256"]);
        allowed = ["attempt_claimed", "direct_dispatched", "direct_verified", "adoption_dispatched"].includes(status);
      } else refuse();
      if (!allowed) refuse();
    }
    status = record.event; tail = record;
  }
  return { status, ordinal, tail, retryUsed };
}
async function readAndValidateLedgerChain(policy, manifest, expectedTailPin) {
  const directory = path.join(policy.ledgerPath, "records"), names = (await readdir(directory)).sort();
  if (names.length < 1 || names.length > 16 || names.some((name, index) =>
    name !== `${String(index).padStart(6, "0")}.json`) || expectedTailPin.path !== path.join(directory, names.at(-1))) refuse();
  const records = [];
  for (const name of names) records.push(object(JSON.parse((await readRegular(
    path.join(directory, name), MAX_POLICY_BYTES, 1, true)).toString("utf8"))));
  const state = validateLedgerChain(records, manifest);
  const tailBytes = await readRegular(expectedTailPin.path, MAX_POLICY_BYTES, 1, true);
  if (sha256(tailBytes) !== expectedTailPin.sha256 || !same(state.tail, records.at(-1))) refuse();
  return state;
}
async function verifyCheckout(identity, modules, environment) {
  const run = promisify(execFile);
  const options = { cwd: identity.worktree, env: environment, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 };
  const [top, head, status, tracked] = await Promise.all([
    run("/usr/bin/git", ["rev-parse", "--show-toplevel"], options),
    run("/usr/bin/git", ["rev-parse", "HEAD"], options),
    run("/usr/bin/git", ["status", "--porcelain=v1", "--untracked-files=normal"], options),
    run("/usr/bin/git", ["ls-files", "-z"], options),
  ]);
  if (top.stdout.trim() !== identity.worktree || head.stdout.trim() !== identity.commit || status.stdout !== "") refuse();
  for (const pin of Object.values(modules)) {
    if (!absolute(pin.path) || !pin.path.startsWith(`${identity.worktree}${path.sep}`)) refuse();
    const relative = path.relative(identity.worktree, pin.path);
    const member = await run("/usr/bin/git", ["ls-files", "--error-unmatch", relative], options);
    if (member.stdout.trim() !== relative) refuse();
  }
  const core = { worktree: identity.worktree, commit: identity.commit,
    cleanStatusSha256: sha256(status.stdout), trackedFilesSha256: sha256(tracked.stdout), verifiedAt: new Date().toISOString() };
  return { ...core, proofSha256: sha256(canonical(core)) };
}

async function acquireExecutionServer() {
  const server = createServer(socket => socket.destroy());
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject); server.listen({ host: HOST, port: PORT, exclusive: true }, resolve);
    });
    const address = server.address();
    if (!server.listening || address === null || typeof address === "string" || address.address !== HOST ||
      address.port !== PORT || address.family !== "IPv4") refuse();
    return server;
  } catch (error) { await closeExecutionServer(server); throw error; }
}
async function closeExecutionServer(server) {
  if (!server?.listening) return;
  await new Promise(resolve => server.close(() => resolve()));
}

async function execute(runtime, dependencies = {}) {
  object(runtime); exactKeys(runtime, ["argv", "execArgv", "environment", "execPath", "modulePath", "pid"]);
  const environment = normalizeSealedEnvironment(runtime.environment);
  const argv = runtime.argv;
  if (!Array.isArray(argv) || !Array.isArray(runtime.execArgv) || runtime.execArgv.length !== 0 || argv.length !== 12 ||
    argv[0] !== runtime.execPath || argv[1] !== runtime.modulePath || argv[2] !== "--publish" ||
    argv[4] !== "--policy" || argv[6] !== "--policy-sha256" || argv[8] !== "--handshake" ||
    argv[10] !== "--continue" || !absolute(runtime.execPath) || !absolute(runtime.modulePath) ||
    !Number.isSafeInteger(runtime.pid) || runtime.pid < 1) refuse();
  const bundlePath = argv[3], policyPath = argv[5], expectedPolicySha256 = argv[7],
    handshakePath = argv[9], continuePath = argv[11];
  const attemptDirectory = path.dirname(handshakePath), runDirectory = path.dirname(bundlePath);
  if (!absolute(bundlePath) || !absolute(policyPath) || !HASH.test(expectedPolicySha256) || !absolute(handshakePath) ||
    !absolute(continuePath) ||
    path.basename(bundlePath) !== "bundle.json" || path.basename(handshakePath) !== "publish.lock-acquired.json" ||
    path.basename(continuePath) !== "publish.continue.json" || path.dirname(continuePath) !== attemptDirectory ||
    path.dirname(attemptDirectory) !== runDirectory || !/^attempt-[a-f0-9-]{36}$/u.test(path.basename(attemptDirectory))) refuse();

  const server = await (dependencies.acquireExecutionServer ?? acquireExecutionServer)();
  const lockAcquiredAt = (dependencies.now ?? (() => new Date().toISOString()))();
  try {
    const policyBytes = await readRegular(policyPath, MAX_POLICY_BYTES, 1, true);
    if (sha256(policyBytes) !== expectedPolicySha256) refuse();
    const policy = object(JSON.parse(policyBytes.toString("utf8")));
    exactKeys(policy, ["schemaVersion", "executor", "importedRecoveryModule", "publisher", "executable", "loader",
      "runtimeInventory", "executorRuntimeInventory", "sourceReader", "environment",
      "incidentManifest", "ledgerPath", "roots", "policySha256"]);
    if (policy.schemaVersion !== "clutchpacks_production_post_head_recovery_executor_policy_v1" ||
      !absolute(policy.ledgerPath) || !Array.isArray(policy.roots) || policy.roots.length !== 2) refuse();
    for (const [index, root] of policy.roots.entries()) {
      object(root); exactKeys(root, ["ordinal", "rootId", "artifactDirectory", "proofDirectory"]);
      if (root.ordinal !== index + 1 || !UUID.test(root.rootId) || !absolute(root.artifactDirectory) ||
        !absolute(root.proofDirectory)) refuse();
    }
    const selectedRoot = policy.roots.find(root => root.artifactDirectory === path.dirname(runDirectory));
    if (!selectedRoot) refuse();
    const { policySha256, ...policyCore } = policy;
    if (typeof policySha256 !== "string" || !HASH.test(policySha256) || sha256(canonical(policyCore)) !== policySha256) refuse();
    const policyEnvironment = object(policy.environment);
    exactKeys(policyEnvironment, SAFE_ENVIRONMENT_KEYS);
    if (!same(environment, policyEnvironment) || policyEnvironment.NODE_ENV !== "production") refuse();
    const incidentManifestPin = await verifyPrivatePin(policy.incidentManifest,
      path.join(policy.ledgerPath, "incident-manifest.json"), MAX_POLICY_BYTES);
    const incidentManifestBytes = await readRegular(incidentManifestPin.path, MAX_POLICY_BYTES, 1, true);
    if (sha256(incidentManifestBytes) !== incidentManifestPin.sha256) refuse();
    const incidentManifest = validateIncidentManifestDocument(
      JSON.parse(incidentManifestBytes.toString("utf8")), incidentManifestPin, policy);

    const executable = await verifyPin(policy.executable, runtime.execPath, 256 * 1024 * 1024);
    const executor = object(policy.executor), publisher = object(policy.publisher);
    exactKeys(executor, ["worktree", "commit", "modules"]); exactKeys(publisher, ["worktree", "commit", "modules"]);
    if (!absolute(executor.worktree) || !absolute(publisher.worktree) ||
      !/^[a-f0-9]{40}$/u.test(executor.commit) || !/^[a-f0-9]{40}$/u.test(publisher.commit)) refuse();
    const executorModules = object(executor.modules), publisherModules = object(publisher.modules);
    exactKeys(executorModules, ["recovery", "postHead", "publishShim", "runtimeInventory", "launcher"]);
    exactKeys(publisherModules, ["promoteCli", "convexRuntime", "publicationOrchestrator", "publicationPolicy",
      "genericPublisher", "sourceReader", "servicesIndex"]);
    const shimPath = runtime.modulePath;
    if (argv[1] !== shimPath || await realpath(shimPath) !== shimPath) refuse();
    const shim = await verifyPin(executorModules.publishShim, shimPath, 1024 * 1024);
    const inventoryModule = await verifyPin(executorModules.runtimeInventory,
      path.join(executor.worktree, "scripts/live/clutchpacks-production-runtime-inventory.mjs"), 1024 * 1024);
    const loader = await verifyPin(policy.loader, path.join(publisher.worktree, "node_modules/tsx/dist/loader.mjs"), 8 * 1024 * 1024);
    const cli = await verifyPin(publisherModules.promoteCli,
      path.join(publisher.worktree, "scripts/live/promote-clutchpacks-production.mts"), 8 * 1024 * 1024);
    await verifyPin(publisherModules.convexRuntime,
      path.join(publisher.worktree, "scripts/live/clutchpacks-production-convex-runtime.mts"), 8 * 1024 * 1024);
    await verifyPin(publisherModules.publicationOrchestrator,
      path.join(publisher.worktree, "scripts/live/clutchpacks-production-v3-publication.mts"), 8 * 1024 * 1024);
    await verifyPin(publisherModules.publicationPolicy,
      path.join(publisher.worktree, "scripts/live/clutchpacks-production-publication-policy.mts"), 8 * 1024 * 1024);
    await verifyPin(publisherModules.genericPublisher,
      path.join(publisher.worktree, "packages/services/src/buyback-adjusted-ev-release-publisher.ts"), 8 * 1024 * 1024);
    await verifyPin(publisherModules.sourceReader,
      path.join(publisher.worktree, "scripts/live/clutchpacks-production-source-reader.mts"), 8 * 1024 * 1024);
    await verifyPin(publisherModules.servicesIndex,
      path.join(publisher.worktree, "packages/services/src/index.ts"), 8 * 1024 * 1024);
    await verifyPin(executorModules.recovery,
      path.join(executor.worktree, "scripts/live/clutchpacks-production-post-head-recovery.mts"), 8 * 1024 * 1024);
    await verifyPin(executorModules.postHead,
      path.join(executor.worktree, "scripts/live/clutchpacks-production-post-head.mts"), 8 * 1024 * 1024);
    await verifyPin(executorModules.launcher,
      path.join(executor.worktree, "scripts/live/clutchpacks-production-post-head-successor-launcher.mjs"), 8 * 1024 * 1024);
    const loadedInventory = await (dependencies.loadRuntimeInventoryModule ??
      (file => import(pathToFileURL(file).href)))(inventoryModule.path);
    if (typeof loadedInventory.readClutchpacksProductionRuntimeInventory !== "function") refuse();
    const runtimeInventory = await loadedInventory.readClutchpacksProductionRuntimeInventory(
      path.join(publisher.worktree, "node_modules"), publisher.worktree);
    if (!same(runtimeInventory, policy.runtimeInventory)) refuse();
    const executorRuntimeInventory = await loadedInventory.readClutchpacksProductionRuntimeInventory(
      path.join(executor.worktree, "node_modules"), executor.worktree);
    if (!same(executorRuntimeInventory, policy.executorRuntimeInventory)) refuse();
    const sourceReader = object(policy.sourceReader);
    exactKeys(sourceReader, ["worktree", "commit", "script", "policy", "executable", "loader", "runtimeInventory"]);
    if (!absolute(sourceReader.worktree) || !/^[a-f0-9]{40}$/u.test(sourceReader.commit)) refuse();
    await verifyPin(sourceReader.script, sourceReader.script.path, 8 * 1024 * 1024);
    await verifyPrivatePin(sourceReader.policy, sourceReader.policy.path, 1024 * 1024);
    await verifyPin(sourceReader.executable, sourceReader.executable.path, 256 * 1024 * 1024);
    await verifyPin(sourceReader.loader, sourceReader.loader.path, 8 * 1024 * 1024);
    const sourceRuntimeInventory = await loadedInventory.readClutchpacksProductionRuntimeInventory(
      path.join(sourceReader.worktree, "node_modules"), sourceReader.worktree);
    if (!same(sourceRuntimeInventory, sourceReader.runtimeInventory)) refuse();
    const [publisherCheckout, executorCheckout, sourceCheckout] = await Promise.all([
      (dependencies.verifyCheckout ?? verifyCheckout)(publisher, publisherModules, environment),
      (dependencies.verifyCheckout ?? verifyCheckout)(executor, executorModules, environment),
      (dependencies.verifyCheckout ?? verifyCheckout)(sourceReader, { script: sourceReader.script }, environment),
    ]);
    const bundle = { path: bundlePath, sha256: sha256(await readRegular(bundlePath, 256 * 1024 * 1024, 1, true)) };
    const lockCore = { schemaVersion: "clutchpacks_production_post_head_recovery_child_lock_v1",
      acquiredAt: lockAcquiredAt, pid: runtime.pid, port: PORT, attemptDirectory, bundle,
      executorPolicy: { path: policyPath, sha256: expectedPolicySha256 }, executable, loader, shim, cli,
      runtimeInventory, executorRuntimeInventory, sourceRuntimeInventory,
      publisherCheckout, executorCheckout, sourceCheckout };
    const lockProof = { ...lockCore, lockSha256: sha256(canonical(lockCore)) };
    await installPrivateExact(handshakePath, Buffer.from(`${canonical(lockProof)}\n`));
    await dependencies.afterHandshake?.({ lockProof, handshakePath, continuePath, policy, incidentManifest });

    const clock = dependencies.milliseconds ?? Date.now;
    const sleep = dependencies.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    const deadline = clock() + 120_000;
    let proceed, proceedBytes;
    while (clock() < deadline) {
      if (await exists(continuePath)) {
        proceedBytes = await readRegular(continuePath, 1024 * 1024, 1, true);
        proceed = object(JSON.parse(proceedBytes.toString("utf8")));
        break;
      }
      await sleep(25);
    }
    if (!proceed || !proceedBytes) refuse();
    const continuePin = { path: continuePath, sha256: sha256(proceedBytes) };
    exactKeys(proceed, ["schemaVersion", "createdAt", "attemptDirectory", "bundle", "handshake", "executorPolicy",
      "sourcePreDispatch", "targetPreDispatch", "residencyPreDispatch", "ledgerRecord", "tokenSha256"]);
    const { tokenSha256, ...tokenCore } = proceed;
    if (proceed.schemaVersion !== "clutchpacks_production_post_head_recovery_continue_v1" ||
      typeof tokenSha256 !== "string" || !HASH.test(tokenSha256) || sha256(canonical(tokenCore)) !== tokenSha256 ||
      proceed.attemptDirectory !== attemptDirectory || !same(proceed.bundle, bundle) ||
      !same(proceed.handshake, { path: handshakePath, sha256: sha256(Buffer.from(`${canonical(lockProof)}\n`)) }) ||
      !same(proceed.executorPolicy, { path: policyPath, sha256: expectedPolicySha256 }) ||
      typeof proceed.createdAt !== "string" || !Number.isFinite(Date.parse(proceed.createdAt)) ||
      proceed.createdAt < lockAcquiredAt) refuse();
    const ledgerPin = await verifyPin(proceed.ledgerRecord, proceed.ledgerRecord.path, MAX_POLICY_BYTES);
    if (path.dirname(ledgerPin.path) !== path.join(policy.ledgerPath, "records") ||
      !/^\d{6}\.json$/u.test(path.basename(ledgerPin.path))) refuse();
    const ledgerRecord = object(JSON.parse((await readRegular(ledgerPin.path, MAX_POLICY_BYTES, 1, true)).toString("utf8")));
    exactKeys(ledgerRecord, ["schemaVersion", "sequence", "previousRecordSha256", "manifestSha256",
      "ledgerSchemaSha256", "incidentId", "recordedAt", "ordinal", "root", "event", "payload", "recordSha256"]);
    const { recordSha256, ...ledgerCore } = ledgerRecord;
    const payload = object(ledgerRecord.payload);
    exactKeys(payload, ["phase", "attemptDirectory", "handshake", "sourcePreDispatch", "targetPreDispatch",
      "residencyPreDispatch"]);
    validateLedgerManifestDomain(ledgerRecord, incidentManifest, incidentManifestPin);
    const ledgerState = await readAndValidateLedgerChain(policy, incidentManifest, ledgerPin);
    if (!same(ledgerState.tail, ledgerRecord)) refuse();
    if (ledgerRecord.schemaVersion !== "clutchpacks_production_post_head_successor_ledger_record_v1" ||
      typeof recordSha256 !== "string" || sha256(canonical(ledgerCore)) !== recordSha256 ||
      ledgerRecord.ordinal !== selectedRoot.ordinal ||
      !same(ledgerRecord.root, selectedRoot) || payload.attemptDirectory !== attemptDirectory ||
      !same(payload.handshake, proceed.handshake) || !same(payload.sourcePreDispatch, proceed.sourcePreDispatch) ||
      !same(payload.targetPreDispatch, proceed.targetPreDispatch) ||
      !same(payload.residencyPreDispatch, proceed.residencyPreDispatch) ||
      !((ledgerRecord.event === "direct_dispatched" && payload.phase === "direct") ||
        (ledgerRecord.event === "adoption_dispatched" && payload.phase === "adoption"))) refuse();

    const finalPublisherInventory = await loadedInventory.readClutchpacksProductionRuntimeInventory(
      path.join(publisher.worktree, "node_modules"), publisher.worktree);
    const finalExecutorInventory = await loadedInventory.readClutchpacksProductionRuntimeInventory(
      path.join(executor.worktree, "node_modules"), executor.worktree);
    const finalSourceInventory = await loadedInventory.readClutchpacksProductionRuntimeInventory(
      path.join(sourceReader.worktree, "node_modules"), sourceReader.worktree);
    if (!same(finalPublisherInventory, runtimeInventory) || !same(finalExecutorInventory, executorRuntimeInventory) ||
      !same(finalSourceInventory, sourceRuntimeInventory)) refuse();
    await dependencies.afterPrePublicationInventory?.();
    await Promise.all([
      (dependencies.verifyCheckout ?? verifyCheckout)(publisher, publisherModules, environment),
      (dependencies.verifyCheckout ?? verifyCheckout)(executor, executorModules, environment),
      (dependencies.verifyCheckout ?? verifyCheckout)(sourceReader, { script: sourceReader.script }, environment),
    ]);
    await verifyPrivatePin({ path: bundlePath, sha256: bundle.sha256 }, bundlePath, 256 * 1024 * 1024);
    await verifyPrivatePin({ path: policyPath, sha256: expectedPolicySha256 }, policyPath, MAX_POLICY_BYTES);
    await verifyPrivatePin(incidentManifestPin, incidentManifestPin.path, MAX_POLICY_BYTES);
    await verifyPrivatePin(continuePin, continuePath, MAX_POLICY_BYTES);
    await verifyPrivatePin(ledgerPin, ledgerPin.path, MAX_POLICY_BYTES);
    const finalLedgerState = await readAndValidateLedgerChain(policy, incidentManifest, ledgerPin);
    if (!same(finalLedgerState.tail, ledgerRecord)) refuse();
    await verifyPin(policy.executable, runtime.execPath, 256 * 1024 * 1024);
    const finalShim = await verifyPin(executorModules.publishShim, shimPath, 1024 * 1024);
    await verifyPin(executorModules.runtimeInventory, inventoryModule.path, 1024 * 1024);
    await verifyPin(executorModules.recovery,
      path.join(executor.worktree, "scripts/live/clutchpacks-production-post-head-recovery.mts"), 8 * 1024 * 1024);
    await verifyPin(executorModules.postHead,
      path.join(executor.worktree, "scripts/live/clutchpacks-production-post-head.mts"), 8 * 1024 * 1024);
    await verifyPin(executorModules.launcher,
      path.join(executor.worktree, "scripts/live/clutchpacks-production-post-head-successor-launcher.mjs"), 8 * 1024 * 1024);
    const finalLoader = await verifyPin(policy.loader,
      path.join(publisher.worktree, "node_modules/tsx/dist/loader.mjs"), 8 * 1024 * 1024);
    const finalCli = await verifyPin(publisherModules.promoteCli,
      path.join(publisher.worktree, "scripts/live/promote-clutchpacks-production.mts"), 8 * 1024 * 1024);
    await verifyPin(publisherModules.convexRuntime,
      path.join(publisher.worktree, "scripts/live/clutchpacks-production-convex-runtime.mts"), 8 * 1024 * 1024);
    await verifyPin(publisherModules.publicationOrchestrator,
      path.join(publisher.worktree, "scripts/live/clutchpacks-production-v3-publication.mts"), 8 * 1024 * 1024);
    await verifyPin(publisherModules.publicationPolicy,
      path.join(publisher.worktree, "scripts/live/clutchpacks-production-publication-policy.mts"), 8 * 1024 * 1024);
    await verifyPin(publisherModules.genericPublisher,
      path.join(publisher.worktree, "packages/services/src/buyback-adjusted-ev-release-publisher.ts"), 8 * 1024 * 1024);
    await verifyPin(publisherModules.sourceReader,
      path.join(publisher.worktree, "scripts/live/clutchpacks-production-source-reader.mts"), 8 * 1024 * 1024);
    await verifyPin(publisherModules.servicesIndex,
      path.join(publisher.worktree, "packages/services/src/index.ts"), 8 * 1024 * 1024);
    await verifyPin(sourceReader.script, sourceReader.script.path, 8 * 1024 * 1024);
    await verifyPin(sourceReader.policy, sourceReader.policy.path, 1024 * 1024);
    await verifyPin(sourceReader.executable, sourceReader.executable.path, 256 * 1024 * 1024);
    await verifyPin(sourceReader.loader, sourceReader.loader.path, 8 * 1024 * 1024);
    if (!same(finalShim, shim)) refuse();
    if (!same(await loadedInventory.readClutchpacksProductionRuntimeInventory(
      path.join(publisher.worktree, "node_modules"), publisher.worktree), runtimeInventory) ||
      !same(await loadedInventory.readClutchpacksProductionRuntimeInventory(
        path.join(executor.worktree, "node_modules"), executor.worktree), executorRuntimeInventory) ||
      !same(await loadedInventory.readClutchpacksProductionRuntimeInventory(
        path.join(sourceReader.worktree, "node_modules"), sourceReader.worktree), sourceRuntimeInventory)) refuse();
    await verifyPrivatePin({ path: bundlePath, sha256: bundle.sha256 }, bundlePath, 256 * 1024 * 1024);
    await verifyPrivatePin({ path: policyPath, sha256: expectedPolicySha256 }, policyPath, MAX_POLICY_BYTES);
    await verifyPrivatePin(incidentManifestPin, incidentManifestPin.path, MAX_POLICY_BYTES);
    await verifyPrivatePin(continuePin, continuePath, MAX_POLICY_BYTES);
    await verifyPrivatePin(ledgerPin, ledgerPin.path, MAX_POLICY_BYTES);
    const sealedLedgerState = await readAndValidateLedgerChain(policy, incidentManifest, ledgerPin);
    if (!same(sealedLedgerState.tail, ledgerRecord)) refuse();
    await verifyPin(executorModules.runtimeInventory, inventoryModule.path, 1024 * 1024);
    await verifyPin(executorModules.publishShim, shimPath, 1024 * 1024);
    await verifyPin(policy.executable, runtime.execPath, 256 * 1024 * 1024);
    await verifyPin(policy.loader, finalLoader.path, 8 * 1024 * 1024);
    await verifyPin(publisherModules.promoteCli, finalCli.path, 8 * 1024 * 1024);

    (dependencies.registerLoader ?? register)(pathToFileURL(finalLoader.path), import.meta.url);
    const loadedCli = await (dependencies.loadCli ?? (file => import(pathToFileURL(file).href)))(finalCli.path);
    if (typeof loadedCli.runClutchpacksProductionCli !== "function") refuse();
    const result = await loadedCli.runClutchpacksProductionCli(["--publish", bundlePath], environment);
    if (!same(await loadedInventory.readClutchpacksProductionRuntimeInventory(
      path.join(publisher.worktree, "node_modules"), publisher.worktree), runtimeInventory)) refuse();
    if (!same(await loadedInventory.readClutchpacksProductionRuntimeInventory(
      path.join(executor.worktree, "node_modules"), executor.worktree), executorRuntimeInventory)) refuse();
    if (!same(await loadedInventory.readClutchpacksProductionRuntimeInventory(
      path.join(sourceReader.worktree, "node_modules"), sourceReader.worktree), sourceRuntimeInventory)) refuse();
    await (dependencies.verifyCheckout ?? verifyCheckout)(publisher, publisherModules, environment);
    await (dependencies.verifyCheckout ?? verifyCheckout)(executor, executorModules, environment);
    await (dependencies.verifyCheckout ?? verifyCheckout)(sourceReader, { script: sourceReader.script }, environment);
    await verifyPin(policy.executable, runtime.execPath, 256 * 1024 * 1024);
    await verifyPin(policy.loader, loader.path, 8 * 1024 * 1024);
    await verifyPin(executorModules.publishShim, shim.path, 1024 * 1024);
    await verifyPin(publisherModules.promoteCli, cli.path, 8 * 1024 * 1024);
    (dependencies.writeStdout ?? (value => process.stdout.write(value)))(canonical(result));
  } finally {
    await (dependencies.closeExecutionServer ?? closeExecutionServer)(server);
  }
}

export const clutchpacksProductionRecoveryPublishShimTestHarness = process.env.NODE_ENV === "test" ? Object.freeze({
  execute, canonical, sha256, validateIncidentManifestDocument, validateLedgerManifestDomain,
  normalizeSealedEnvironment,
}) : undefined;

if (process.argv[1] === fileURLToPath(import.meta.url)) execute({ argv: process.argv, execArgv: process.execArgv,
  environment: process.env, execPath: process.execPath, modulePath: fileURLToPath(import.meta.url), pid: process.pid }).catch(() => {
  process.stderr.write('{"status":"refused","code":"CLUTCHPACKS_RECOVERY_PUBLISH_SHIM_REFUSED"}\n');
  process.exitCode = 1;
});

import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  NormalizedContinuation,
  OpaqueCheckpointEnvelope,
} from "@packscout/contracts";

export type OpaqueCheckpointGuardErrorCode =
  | "checkpoint_binding_mismatch"
  | "checkpoint_cycle_detected"
  | "checkpoint_fingerprint_key_invalid"
  | "continue_checkpoint_missing"
  | "continue_checkpoint_unchanged";

export class OpaqueCheckpointGuardError extends Error {
  readonly code: OpaqueCheckpointGuardErrorCode;

  constructor(code: OpaqueCheckpointGuardErrorCode) {
    super(`opaque_checkpoint.${code}`);
    this.name = "OpaqueCheckpointGuardError";
    this.code = code;
  }
}

const bindingFields = [
  "sourceInstanceId",
  "sourceRevisionId",
  "sourceTypeKey",
  "adapterVersion",
  "checkpointCodecKey",
  "checkpointGeneration",
] as const satisfies readonly (keyof OpaqueCheckpointEnvelope)[];

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes);
}

export interface GuardCheckpointTransitionInput {
  readonly requested: OpaqueCheckpointEnvelope;
  readonly next: OpaqueCheckpointEnvelope;
  readonly continuation: NormalizedContinuation;
  readonly committedFingerprints: ReadonlySet<string>;
}

export interface GuardedCheckpointTransition {
  readonly nextFingerprint: string;
  readonly shouldContinueImmediately: boolean;
}

export class OpaqueCheckpointGuard {
  readonly #fingerprintKey: Buffer;

  constructor(fingerprintKey: Uint8Array) {
    if (fingerprintKey.byteLength < 32) {
      throw new OpaqueCheckpointGuardError("checkpoint_fingerprint_key_invalid");
    }
    this.#fingerprintKey = Buffer.from(fingerprintKey);
  }

  fingerprint(checkpoint: OpaqueCheckpointEnvelope): string {
    const value = checkpoint.value === null
      ? "N"
      : `S\0${Buffer.byteLength(checkpoint.value, "utf8")}\0${checkpoint.value}`;
    return createHmac("sha256", this.#fingerprintKey)
      .update(checkpoint.sourceInstanceId)
      .update("\0")
      .update(String(checkpoint.checkpointGeneration))
      .update("\0")
      .update(value)
      .digest("hex");
  }

  guard(input: GuardCheckpointTransitionInput): GuardedCheckpointTransition {
    for (const field of bindingFields) {
      if (input.requested[field] !== input.next[field]) {
        throw new OpaqueCheckpointGuardError("checkpoint_binding_mismatch");
      }
    }

    if (input.continuation.kind === "continue") {
      if (input.next.value === null) {
        throw new OpaqueCheckpointGuardError("continue_checkpoint_missing");
      }
      if (
        input.requested.value !== null &&
        safeEqual(input.requested.value, input.next.value)
      ) {
        throw new OpaqueCheckpointGuardError("continue_checkpoint_unchanged");
      }
    }

    const nextFingerprint = this.fingerprint(input.next);
    if (
      input.continuation.kind === "continue" &&
      input.committedFingerprints.has(nextFingerprint)
    ) {
      throw new OpaqueCheckpointGuardError("checkpoint_cycle_detected");
    }
    return Object.freeze({
      nextFingerprint,
      shouldContinueImmediately: input.continuation.kind === "continue",
    });
  }
}

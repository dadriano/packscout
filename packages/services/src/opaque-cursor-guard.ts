import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  NormalizedContinuation,
  OpaqueCursorEnvelope,
} from "@packscout/contracts";

export type OpaqueCursorGuardErrorCode =
  | "cursor_binding_mismatch"
  | "cursor_cycle_detected"
  | "cursor_fingerprint_key_invalid"
  | "continue_cursor_missing"
  | "continue_cursor_unchanged";

export class OpaqueCursorGuardError extends Error {
  readonly code: OpaqueCursorGuardErrorCode;

  constructor(code: OpaqueCursorGuardErrorCode) {
    super(`opaque_cursor.${code}`);
    this.name = "OpaqueCursorGuardError";
    this.code = code;
  }
}

const bindingFields = [
  "sourceInstanceId",
  "sourceRevisionId",
  "sourceTypeKey",
  "adapterVersion",
  "cursorCodecKey",
  "cursorGeneration",
] as const satisfies readonly (keyof OpaqueCursorEnvelope)[];

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes);
}

export interface GuardCursorTransitionInput {
  readonly requested: OpaqueCursorEnvelope;
  readonly next: OpaqueCursorEnvelope;
  readonly continuation: NormalizedContinuation;
  readonly committedFingerprints: ReadonlySet<string>;
}

export interface GuardedCursorTransition {
  readonly nextFingerprint: string;
  readonly shouldContinueImmediately: boolean;
}

export class OpaqueCursorGuard {
  readonly #fingerprintKey: Buffer;

  constructor(fingerprintKey: Uint8Array) {
    if (fingerprintKey.byteLength < 32) {
      throw new OpaqueCursorGuardError("cursor_fingerprint_key_invalid");
    }
    this.#fingerprintKey = Buffer.from(fingerprintKey);
  }

  fingerprint(cursor: OpaqueCursorEnvelope): string {
    const value = cursor.value === null
      ? "N"
      : `S\0${Buffer.byteLength(cursor.value, "utf8")}\0${cursor.value}`;
    return createHmac("sha256", this.#fingerprintKey)
      .update(cursor.sourceInstanceId)
      .update("\0")
      .update(String(cursor.cursorGeneration))
      .update("\0")
      .update(value)
      .digest("hex");
  }

  guard(input: GuardCursorTransitionInput): GuardedCursorTransition {
    for (const field of bindingFields) {
      if (input.requested[field] !== input.next[field]) {
        throw new OpaqueCursorGuardError("cursor_binding_mismatch");
      }
    }

    if (input.continuation.kind === "continue") {
      if (input.next.value === null) {
        throw new OpaqueCursorGuardError("continue_cursor_missing");
      }
      if (
        input.requested.value !== null &&
        safeEqual(input.requested.value, input.next.value)
      ) {
        throw new OpaqueCursorGuardError("continue_cursor_unchanged");
      }
    }

    const nextFingerprint = this.fingerprint(input.next);
    if (
      input.continuation.kind === "continue" &&
      input.committedFingerprints.has(nextFingerprint)
    ) {
      throw new OpaqueCursorGuardError("cursor_cycle_detected");
    }
    return Object.freeze({
      nextFingerprint,
      shouldContinueImmediately: input.continuation.kind === "continue",
    });
  }
}

import { createHash } from "node:crypto";
import { z } from "zod";
import type { WelcomeMessageInput } from "../message-catalogue/catalogue.ts";
import type {
  EnqueueEmailMessageCommand,
  EnqueueEmailMessageResult,
} from "../message-outbox/outbox-service.ts";
import type {
  ClaimedWelcome,
  WelcomeDispatchDirectoryPort,
} from "./directory-client.ts";

/**
 * The welcome dispatcher (messaging/007): one bounded pass that discovers
 * identities at their first admitted session through the operator
 * integration, claims each, enqueues the one welcome through the durable
 * outbox (messaging/004), and settles the claim only after the enqueue is
 * durable.
 *
 * The once-ever guarantee is the composition of two mechanisms, neither
 * sufficient alone:
 *
 * - The directory marker: due → claimed → sent is monotone, claims are
 *   atomic and expiring, and sent is terminal. Concurrent passes claim
 *   disjoint identities; a crashed pass's claims lapse back to due.
 * - The outbox idempotency key, derived from the subject alone: however the
 *   claim-enqueue-settle sequence is torn by a crash and replayed by a later
 *   pass, every enqueue for one identity converges on one intent and the
 *   recipient receives one message.
 *
 * Settling `sent` therefore means "durably enqueued", not "delivered" —
 * delivery, retries, and attempt history are the outbox drain's job, and
 * messaging/011 is where an operator reads what happened after this point.
 */

/** The outbox source welcome enqueues count against, for the volume bound. */
export const WELCOME_MESSAGE_SOURCE = "closed_beta_welcome";

/** The catalogue kind rendered for every welcome (messaging/003). */
export const WELCOME_MESSAGE_KIND = "welcome";

/**
 * The idempotency key for one identity's one welcome, ever. The subject is
 * hashed because subjects carry characters (and lengths) the outbox key
 * alphabet excludes, and because the key travels into delivery records the
 * raw identity should not; the digest keeps it deterministic per identity.
 */
export function welcomeIdempotencyKey(subject: string): string {
  return `welcome:${createHash("sha256").update(subject, "utf8").digest("hex")}`;
}

/**
 * Mirrors the outbox recipient bound exactly, so an address this validation
 * accepts never bounces off enqueue validation as a surprise, and one it
 * refuses is settled as the recorded no-address skip rather than retried
 * forever against a validation that will never change its mind.
 */
const usableRecipientSchema = z.string().trim().max(320).email();

/** Structural subset of `EmailMessageOutboxService` the dispatcher uses. */
export interface WelcomeDispatchOutboxPort {
  enqueueEmailMessage(
    command: EnqueueEmailMessageCommand,
  ): Promise<EnqueueEmailMessageResult>;
}

export interface WelcomeDispatchCycleResult {
  readonly outcome: "dispatched";
  /** Identities this pass claimed. */
  readonly claimed: number;
  /** Welcomes durably enqueued and settled sent this pass. */
  readonly enqueued: number;
  /** Of those, enqueues an earlier pass had already recorded. */
  readonly deduplicated: number;
  /** Claims settled as the recorded no-address skip. */
  readonly skipped: number;
  /**
   * Claims left unsettled — a refused enqueue or a failed settlement. Each
   * lapses back into discovery at its claim expiry and is retried; the
   * idempotency key converges any enqueue that did land.
   */
  readonly errors: number;
  /** True when the pass filled its batch; a backlog remains. */
  readonly capReached: boolean;
}

export interface WelcomeDispatchServiceOptions {
  /** Identities claimed per pass; 1..20 (the directory's claim bound). */
  readonly batchSize: number;
  /** Claim lease passed to the directory; its bounds are the directory's. */
  readonly leaseMilliseconds: number;
}

export interface WelcomeDispatchServiceDependencies {
  readonly directory: WelcomeDispatchDirectoryPort;
  readonly outbox: WelcomeDispatchOutboxPort;
  readonly options: WelcomeDispatchServiceOptions;
}

export class WelcomeDispatchService {
  readonly #directory: WelcomeDispatchDirectoryPort;
  readonly #outbox: WelcomeDispatchOutboxPort;
  readonly #batchSize: number;
  readonly #leaseMilliseconds: number;

  constructor(dependencies: WelcomeDispatchServiceDependencies) {
    const { batchSize, leaseMilliseconds } = dependencies.options;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 20) {
      throw new RangeError("Welcome dispatch batch size is outside its safe bounds.");
    }
    if (
      !Number.isInteger(leaseMilliseconds) ||
      leaseMilliseconds < 1_000 ||
      leaseMilliseconds > 900_000
    ) {
      throw new RangeError("Welcome dispatch claim lease is outside its safe bounds.");
    }
    this.#directory = dependencies.directory;
    this.#outbox = dependencies.outbox;
    this.#batchSize = batchSize;
    this.#leaseMilliseconds = leaseMilliseconds;
  }

  /**
   * One bounded pass. A failure to claim propagates (the worker reports the
   * cycle as failed and tries again next cycle); a failure against any one
   * claimed identity is contained to that identity, counted, and resolved
   * by claim expiry — one poisoned identity cannot stop the rest.
   */
  async runCycle(): Promise<WelcomeDispatchCycleResult> {
    const claims = await this.#directory.claimDueWelcomes({
      limit: this.#batchSize,
      leaseMilliseconds: this.#leaseMilliseconds,
    });
    let enqueued = 0;
    let deduplicated = 0;
    let skipped = 0;
    let errors = 0;
    for (const claim of claims) {
      try {
        const result = await this.#dispatchOne(claim);
        if (result === "enqueued") enqueued += 1;
        else if (result === "deduplicated") {
          enqueued += 1;
          deduplicated += 1;
        } else skipped += 1;
      } catch {
        // The claim stays held and lapses back into discovery; nothing about
        // the failure is retained here (no address, subject, or upstream
        // error text belongs in a cycle result).
        errors += 1;
      }
    }
    return {
      outcome: "dispatched",
      claimed: claims.length,
      enqueued,
      deduplicated,
      skipped,
      errors,
      capReached: claims.length === this.#batchSize,
    };
  }

  async #dispatchOne(
    claim: ClaimedWelcome,
  ): Promise<"enqueued" | "deduplicated" | "skipped"> {
    const recipient = usableRecipientSchema.safeParse(claim.email ?? "");
    if (claim.email === null || !recipient.success) {
      // No reachable address is a normal, permanent skip — recorded once,
      // never retried (the directory marker becomes not_applicable).
      await this.#settle(claim.subject, "no_verified_email");
      return "skipped";
    }
    const input: WelcomeMessageInput = { toEmail: recipient.data };
    const result = await this.#outbox.enqueueEmailMessage({
      kind: WELCOME_MESSAGE_KIND,
      input,
      recipient: recipient.data,
      idempotencyKey: welcomeIdempotencyKey(claim.subject),
      source: WELCOME_MESSAGE_SOURCE,
    });
    if (result.status !== "enqueued") {
      // A refused enqueue (backlog bound, or a validation surprise that is
      // a dispatcher bug) leaves the claim to lapse and retry: the marker
      // settles only once the message is durably enqueued.
      throw new Error("Welcome enqueue was refused.");
    }
    // Settle only after the durable enqueue. If this settlement itself
    // fails, the claim lapses, a later pass re-enqueues into the same
    // intent (idempotency key), and its settlement records the truth.
    await this.#settle(claim.subject, "sent");
    return result.deduplicated ? "deduplicated" : "enqueued";
  }

  async #settle(
    subject: string,
    outcome: "sent" | "no_verified_email",
  ): Promise<void> {
    // Every settle result is acceptable: `already_settled` means another
    // pass got there first (the marker is terminal either way), and
    // `nothing_to_settle` is surfaced by the port as a successful no-op on
    // an identity that no longer carries a marker. Only transport failures
    // throw, leaving the claim to lapse.
    await this.#directory.settleWelcome({ subject, outcome });
  }
}

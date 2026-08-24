import type { EmailLinkPurpose } from "@packscout/contracts";
import type { Clock } from "../auth-service.ts";
import type { RetentionRecordPruner } from "../protected-payload-retention-coordinator.ts";
import {
  emailLinkPathFor,
  type EmailLinkTokenConfiguration,
} from "./configuration.ts";
import {
  generateEmailLinkToken,
  nodeEmailLinkRandomness,
  parsePresentedEmailLinkToken,
  type EmailLinkBucketKeyer,
  type EmailLinkRandomness,
  type EmailLinkVerifierDigest,
} from "./token-format.ts";

/**
 * Issue and redeem one-time email links. A token proves that whoever clicked
 * a mailed link controls the mailbox it was sent to: it is purpose-scoped,
 * subject-bound at issuance, single-use, expiring, stored hashed, and
 * rate-limited at issuance per address and per requesting source.
 *
 * Two properties shape every code path here. First, redemption has exactly
 * one failure outcome: unknown, malformed, expired, superseded, already
 * used, wrong purpose, and ineligible subject all return the same frozen
 * rejection value, and the unknown paths still perform a verifier comparison
 * against a dummy digest so no early return distinguishes them. Second,
 * issuance requests for unknown and known addresses walk the same sequence —
 * resolve, throttle, generate, digest — differing only in whether a row is
 * persisted, so neither the response shape nor the work done reveals whether
 * an account exists. The audit trail records the true outcome; the caller
 * and the requester see the uniform one.
 */

/** The stored-token subset redemption reads; the database repository satisfies it. */
export interface EmailLinkStoredToken {
  readonly id: string;
  readonly purpose: EmailLinkPurpose;
  readonly verifierHash: string;
  readonly subjectId: string;
  readonly addressNormalized: string;
  readonly expiresAt: Date;
  readonly redeemedAt: Date | null;
  readonly supersededAt: Date | null;
}

/** Structural subset of the database token repository the service uses. */
export interface EmailLinkTokenStore {
  issue(input: {
    readonly id: string;
    readonly purpose: EmailLinkPurpose;
    readonly subjectId: string;
    readonly addressNormalized: string;
    readonly selector: string;
    readonly verifierHash: string;
    readonly issuedAt: Date;
    readonly expiresAt: Date;
  }): Promise<{ readonly tokenId: string; readonly supersededCount: number }>;
  findBySelector(selector: string): Promise<EmailLinkStoredToken | null>;
  consume(input: {
    readonly tokenId: string;
    readonly purpose: EmailLinkPurpose;
    readonly now: Date;
  }): Promise<"consumed" | "unavailable">;
}

export interface EmailLinkThrottleOptions {
  readonly windowMs: number;
  readonly maxRequests: number;
  readonly blockMs: number;
}

/** Structural subset of the database rate limiter the service uses. */
export interface EmailLinkIssuanceThrottle {
  recordRequest(
    bucketKeys: readonly string[],
    now: Date,
    options: EmailLinkThrottleOptions,
  ): Promise<Date | null>;
}

export type EmailLinkIssuanceAuditReason =
  | "issued"
  | "rate_limited"
  | "subject_unknown"
  | "address_invalid"
  /** Generated, then the caller's durable commit refused: no link exists. */
  | "issue_uncommitted";

export type EmailLinkRedemptionAuditReason =
  | "redeemed"
  | "malformed_token"
  | "unknown_token"
  | "verifier_mismatch"
  | "purpose_mismatch"
  | "expired"
  | "already_used"
  | "superseded"
  | "subject_ineligible";

export interface EmailLinkAuditEventRecord {
  readonly action: "email_link.issue" | "email_link.redeem";
  readonly purpose: EmailLinkPurpose;
  readonly subjectId: string | null;
  readonly outcome: "success" | "failure" | "blocked";
  readonly reason: EmailLinkIssuanceAuditReason | EmailLinkRedemptionAuditReason;
  readonly occurredAt: Date;
  readonly actorKey?: string;
}

/** Structural subset of the database audit sink the service uses. */
export interface EmailLinkAuditRecorder {
  append(event: EmailLinkAuditEventRecord): Promise<void>;
}

/**
 * One bounded record of an audit write that could not be persisted: the
 * action, its closed reason word, and whether the work it describes is
 * already durable. Never a token, a selector, an address, or a link.
 */
export interface EmailLinkAuditWriteFailure {
  readonly action: EmailLinkAuditEventRecord["action"];
  readonly purpose: EmailLinkPurpose;
  readonly reason: EmailLinkAuditEventRecord["reason"];
  readonly afterCommit: boolean;
}

/** The default report for an audit write that failed: one bounded line. */
function logEmailLinkAuditFailure(failure: EmailLinkAuditWriteFailure): void {
  console.error(
    JSON.stringify({
      level: "error",
      event: "email_link_audit_write_failed",
      action: failure.action,
      purpose: failure.purpose,
      reason: failure.reason,
      afterCommit: failure.afterCommit,
    }),
  );
}

export interface IssueEmailLinkCommand {
  readonly purpose: EmailLinkPurpose;
  /** The bound subject; redemption resolves back to exactly this identity. */
  readonly subjectId: string;
  /** The mailbox the link will be sent to. */
  readonly address: string;
  /** The requesting source (a network identifier or acting-operator key). */
  readonly source: string;
  /** Audit attribution for administrator-triggered issuance. */
  readonly actorKey?: string;
  /**
   * The caller's durable commit for the generated token — typically the one
   * transaction that lands the token row with the message intent carrying its
   * link. It runs before the issuance is audited, so the security trail
   * records a success only for a link that exists. A refusal must throw; the
   * attempt is then audited as `issue_uncommitted` and the error rethrown.
   */
  commit?(issued: IssuedEmailLink): Promise<void>;
}

export interface IssuedEmailLink {
  /** The presented composite, `selector.verifier`. Exists only here and in the mailed link. */
  readonly token: string;
  /** The opaque rooted admin path carrying the token, ready for the message catalogue. */
  readonly linkPath: string;
  readonly expiresAt: Date;
  readonly subjectId: string;
  /** Prior outstanding links for the same subject and purpose this one replaced. */
  readonly supersededCount: number;
}

export type EmailLinkIssuanceResult =
  | { readonly status: "issued"; readonly issued: IssuedEmailLink }
  | { readonly status: "rate_limited"; readonly retryAt: Date };

export interface RequestEmailLinkIssuanceCommand {
  readonly purpose: EmailLinkPurpose;
  /** The requester-supplied address, normalized here. */
  readonly address: string;
  /** The requesting source (a network identifier). */
  readonly source: string;
  /**
   * Resolves the normalized address to a subject, or null when no eligible
   * subject exists. Called exactly once on every request — known, unknown,
   * and rate-limited alike — so lookup cost never distinguishes them.
   */
  resolveSubjectId(addressNormalized: string): Promise<string | null>;
  /**
   * The caller's durable commit for the generated token, run before the
   * issuance is audited so the trail never records a success for a link that
   * was never persisted or mailed. A refusal must throw; the attempt is
   * audited as `issue_uncommitted` and the error rethrown to the caller,
   * whose own uniform response to the requester is unaffected.
   */
  commit?(issued: IssuedEmailLink): Promise<void>;
}

/**
 * The uniform request outcome: always `accepted`. `issued` is present only
 * when a subject resolved and the request was within its limits — it is the
 * caller's cue to enqueue the message, and it never shapes the response the
 * requester sees.
 */
export interface EmailLinkIssuanceRequestResult {
  readonly status: "accepted";
  readonly issued?: IssuedEmailLink;
}

export interface RedeemEmailLinkCommand {
  readonly purpose: EmailLinkPurpose;
  readonly presentedToken: unknown;
  /**
   * The caller's current-eligibility check for the resolved subject —
   * consulted at redemption time, before the token is consumed, so a subject
   * disabled after issuance is refused with the uniform rejection.
   */
  isSubjectEligible(subjectId: string): Promise<boolean>;
}

/**
 * The single rejection value every failed redemption returns. One frozen
 * object — not one per failure mode — so there is nothing to compare,
 * fingerprint, or time between unknown, expired, used, superseded,
 * wrong-purpose, malformed, and ineligible-subject presentations.
 */
export const EMAIL_LINK_REJECTION = Object.freeze({
  status: "rejected",
  errorCode: "EMAIL_LINK_INVALID",
} as const);

export type EmailLinkRedemptionResult =
  | {
      readonly status: "redeemed";
      readonly subjectId: string;
      readonly addressNormalized: string;
    }
  | typeof EMAIL_LINK_REJECTION;

export interface EmailLinkTokenServiceOptions {
  readonly store: EmailLinkTokenStore;
  readonly throttle: EmailLinkIssuanceThrottle;
  readonly audit: EmailLinkAuditRecorder;
  /** From {@link createEmailLinkTokenSecurity}; the service never sees the secret. */
  readonly verifierDigest: EmailLinkVerifierDigest;
  readonly bucketKeyer: EmailLinkBucketKeyer;
  readonly configuration: EmailLinkTokenConfiguration;
  readonly clock?: Clock;
  readonly randomness?: EmailLinkRandomness;
  /**
   * Where an audit record that could not be written is reported. Defaults to
   * one content-free error line. It never decides an outcome: a consumed
   * token stays consumed whether or not its record landed.
   */
  readonly reportAuditFailure?: (failure: EmailLinkAuditWriteFailure) => void;
}

const addressPattern = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

function normalizedAddress(address: string): string | null {
  if (typeof address !== "string") return null;
  const candidate = address.trim().toLocaleLowerCase("en-US");
  if (
    candidate.length < 3 ||
    candidate.length > 320 ||
    !addressPattern.test(candidate)
  ) {
    return null;
  }
  return candidate;
}

export class EmailLinkTokenService {
  readonly #store: EmailLinkTokenStore;
  readonly #throttle: EmailLinkIssuanceThrottle;
  readonly #audit: EmailLinkAuditRecorder;
  readonly #digest: EmailLinkVerifierDigest;
  readonly #configuration: EmailLinkTokenConfiguration;
  readonly #clock: Clock;
  readonly #randomness: EmailLinkRandomness;
  readonly #bucketKeyer: EmailLinkBucketKeyer;
  readonly #reportAuditWriteFailure: (
    failure: EmailLinkAuditWriteFailure,
  ) => void;
  /**
   * The digest an unknown or malformed presentation is compared against — a
   * real digest of a random verifier drawn at construction, so the failing
   * comparison is byte-for-byte the same operation as a real mismatch.
   */
  readonly #dummyVerifierHash: string;

  constructor(options: EmailLinkTokenServiceOptions) {
    this.#store = options.store;
    this.#throttle = options.throttle;
    this.#audit = options.audit;
    this.#digest = options.verifierDigest;
    this.#configuration = options.configuration;
    this.#clock = options.clock ?? { now: () => new Date() };
    this.#randomness = options.randomness ?? nodeEmailLinkRandomness;
    this.#bucketKeyer = options.bucketKeyer;
    this.#reportAuditWriteFailure =
      options.reportAuditFailure ?? logEmailLinkAuditFailure;
    this.#dummyVerifierHash = this.#digest.digest(
      "operator_password_reset",
      generateEmailLinkToken(this.#randomness).verifier,
    );
  }

  /**
   * Issues one link for a known subject: throttles per address and per
   * source, supersedes the subject's outstanding links for the purpose, and
   * returns the only usable copy of the token inside the link path. The
   * token is never given to the audit trail, and delivery is the caller's
   * separate durable enqueue — a delivery failure leaves the token intact,
   * because nothing but redemption ever consumes it.
   */
  async issue(command: IssueEmailLinkCommand): Promise<EmailLinkIssuanceResult> {
    const now = this.#clock.now();
    const address = normalizedAddress(command.address);
    if (address === null) {
      throw new RangeError("Email link address is not a valid address.");
    }
    if (typeof command.source !== "string" || command.source.length === 0 || command.source.length > 512) {
      throw new RangeError("Email link source is not a valid source.");
    }
    const retryAt = await this.#recordThrottle(command.purpose, address, command.source, now);
    if (retryAt) {
      await this.#auditIssuance(command.purpose, command.subjectId, "rate_limited", now, command.actorKey);
      return { status: "rate_limited", retryAt };
    }
    const issued = await this.#persistIssuance(
      command.purpose,
      command.subjectId,
      address,
      now,
    );
    await this.#commitAndAuditIssuance(
      command.purpose,
      command.subjectId,
      issued,
      now,
      command.commit,
      command.actorKey,
    );
    return { status: "issued", issued };
  }

  /**
   * The non-enumerating request path for unauthenticated flows. Every
   * request — unknown address, invalid address, rate-limited, and issued
   * alike — resolves the subject once, records the throttle once, generates
   * and digests token material once, and returns the same `accepted` shape.
   * Only a resolved, unthrottled subject also persists a token and carries
   * the internal `issued` payload for the caller's enqueue.
   */
  async requestIssuance(
    command: RequestEmailLinkIssuanceCommand,
  ): Promise<EmailLinkIssuanceRequestResult> {
    const now = this.#clock.now();
    if (typeof command.source !== "string" || command.source.length === 0 || command.source.length > 512) {
      throw new RangeError("Email link source is not a valid source.");
    }
    const address = normalizedAddress(command.address);
    // The same sequence runs for every request; `address ?? ""` keeps the
    // resolver and throttle calls in place for unusable addresses too.
    const subjectId = await command.resolveSubjectId(address ?? "");
    const retryAt = await this.#recordThrottle(
      command.purpose,
      address ?? "invalid@invalid.invalid",
      command.source,
      now,
    );
    if (retryAt) {
      this.#performDecoyIssuanceWork(command.purpose);
      await this.#auditIssuance(command.purpose, subjectId, "rate_limited", now);
      return { status: "accepted" };
    }
    if (address === null) {
      this.#performDecoyIssuanceWork(command.purpose);
      await this.#auditIssuance(command.purpose, subjectId, "address_invalid", now);
      return { status: "accepted" };
    }
    if (subjectId === null) {
      this.#performDecoyIssuanceWork(command.purpose);
      await this.#auditIssuance(command.purpose, null, "subject_unknown", now);
      return { status: "accepted" };
    }
    const issued = await this.#persistIssuance(command.purpose, subjectId, address, now);
    await this.#commitAndAuditIssuance(
      command.purpose,
      subjectId,
      issued,
      now,
      command.commit,
    );
    return { status: "accepted", issued };
  }

  /**
   * Verifies and consumes one presented token. Success returns the bound
   * subject; every failure returns {@link EMAIL_LINK_REJECTION}. The
   * comparison always runs — against the stored digest when the selector is
   * known, against the construction-time dummy digest when it is not — and
   * consumption is a single guarded UPDATE, so concurrent redemptions
   * resolve to exactly one success and a consumed token stays consumed
   * whatever happens to the caller's follow-on work.
   */
  async redeem(command: RedeemEmailLinkCommand): Promise<EmailLinkRedemptionResult> {
    const now = this.#clock.now();
    const parsed = parsePresentedEmailLinkToken(command.presentedToken);
    const stored = parsed ? await this.#store.findBySelector(parsed.selector) : null;
    const candidateVerifier =
      parsed?.verifier ??
      (typeof command.presentedToken === "string" ? command.presentedToken : "");
    const verified = this.#digest.matches(
      command.purpose,
      candidateVerifier,
      stored?.verifierHash ?? this.#dummyVerifierHash,
    );

    if (!stored) {
      return this.#reject(command.purpose, null, parsed ? "unknown_token" : "malformed_token", now);
    }
    if (!verified) {
      return this.#reject(
        command.purpose,
        stored.subjectId,
        stored.purpose === command.purpose ? "verifier_mismatch" : "purpose_mismatch",
        now,
      );
    }
    if (stored.expiresAt.getTime() <= now.getTime()) {
      return this.#reject(command.purpose, stored.subjectId, "expired", now);
    }
    if (stored.redeemedAt !== null) {
      return this.#reject(command.purpose, stored.subjectId, "already_used", now);
    }
    if (stored.supersededAt !== null) {
      return this.#reject(command.purpose, stored.subjectId, "superseded", now);
    }
    if (!(await command.isSubjectEligible(stored.subjectId))) {
      return this.#reject(command.purpose, stored.subjectId, "subject_ineligible", now);
    }
    const consumed = await this.#store.consume({
      tokenId: stored.id,
      purpose: command.purpose,
      now,
    });
    if (consumed !== "consumed") {
      // A concurrent redemption or supersession won between read and update.
      return this.#reject(command.purpose, stored.subjectId, "already_used", now);
    }
    // The guarded UPDATE has committed: this token is spent and can never be
    // presented again. Rejecting here because the record could not be written
    // would leave the person holding the link with no way forward — the
    // password set or activation behind this redemption never runs, and the
    // link now answers with the uniform rejection. The missing record is its
    // own reported failure, never the redemption's outcome.
    try {
      await this.#audit.append({
        action: "email_link.redeem",
        purpose: command.purpose,
        subjectId: stored.subjectId,
        outcome: "success",
        reason: "redeemed",
        occurredAt: now,
      });
    } catch {
      this.#reportAuditFailure({
        action: "email_link.redeem",
        purpose: command.purpose,
        reason: "redeemed",
        afterCommit: true,
      });
    }
    return {
      status: "redeemed",
      subjectId: stored.subjectId,
      addressNormalized: stored.addressNormalized,
    };
  }

  async #persistIssuance(
    purpose: EmailLinkPurpose,
    subjectId: string,
    addressNormalized: string,
    now: Date,
  ): Promise<IssuedEmailLink> {
    const generated = generateEmailLinkToken(this.#randomness);
    const verifierHash = this.#digest.digest(purpose, generated.verifier);
    const expiresAt = new Date(
      now.getTime() + this.#configuration[purpose].lifetimeMs,
    );
    const { supersededCount } = await this.#store.issue({
      id: this.#randomness.uuid(),
      purpose,
      subjectId,
      addressNormalized,
      selector: generated.selector,
      verifierHash,
      issuedAt: now,
      expiresAt,
    });
    return {
      token: generated.presented,
      linkPath: emailLinkPathFor(purpose, generated.presented),
      expiresAt,
      subjectId,
      supersededCount,
    };
  }

  /** The non-persisting paths still generate and digest a token. */
  #performDecoyIssuanceWork(purpose: EmailLinkPurpose): void {
    const generated = generateEmailLinkToken(this.#randomness);
    this.#digest.digest(purpose, generated.verifier);
  }

  async #recordThrottle(
    purpose: EmailLinkPurpose,
    addressNormalized: string,
    source: string,
    now: Date,
  ): Promise<Date | null> {
    const limits = this.#configuration[purpose].rateLimit;
    const addressBlock = await this.#throttle.recordRequest(
      [this.#bucketKeyer.addressKey(purpose, addressNormalized)],
      now,
      {
        windowMs: limits.windowMs,
        maxRequests: limits.addressMaxPerWindow,
        blockMs: limits.blockMs,
      },
    );
    const sourceBlock = await this.#throttle.recordRequest(
      [this.#bucketKeyer.sourceKey(purpose, source)],
      now,
      {
        windowMs: limits.windowMs,
        maxRequests: limits.sourceMaxPerWindow,
        blockMs: limits.blockMs,
      },
    );
    if (!addressBlock) return sourceBlock;
    if (!sourceBlock) return addressBlock;
    return addressBlock > sourceBlock ? addressBlock : sourceBlock;
  }

  /**
   * Lands the caller's durable commit for a generated token, then records the
   * issuance. Auditing success first would write a successful issuance into
   * the security trail for a link that does not exist and was never mailed.
   */
  async #commitAndAuditIssuance(
    purpose: EmailLinkPurpose,
    subjectId: string,
    issued: IssuedEmailLink,
    now: Date,
    commit: ((issued: IssuedEmailLink) => Promise<void>) | undefined,
    actorKey?: string,
  ): Promise<void> {
    if (commit) {
      try {
        await commit(issued);
      } catch (error) {
        try {
          await this.#auditIssuance(
            purpose,
            subjectId,
            "issue_uncommitted",
            now,
            actorKey,
          );
        } catch {
          // The commit refusal is the outcome the caller must act on; a trail
          // that could not record it must not replace that error.
        }
        throw error;
      }
    }
    await this.#auditIssuance(purpose, subjectId, "issued", now, actorKey);
  }

  /** Reports an unwritable audit record without becoming a failure itself. */
  #reportAuditFailure(failure: EmailLinkAuditWriteFailure): void {
    try {
      this.#reportAuditWriteFailure(failure);
    } catch {
      // Reporting the gap must not become a third failure domain.
    }
  }

  async #auditIssuance(
    purpose: EmailLinkPurpose,
    subjectId: string | null,
    reason: EmailLinkIssuanceAuditReason,
    occurredAt: Date,
    actorKey?: string,
  ): Promise<void> {
    await this.#audit.append({
      action: "email_link.issue",
      purpose,
      subjectId,
      outcome:
        reason === "issued"
          ? "success"
          : reason === "rate_limited"
            ? "blocked"
            : "failure",
      reason,
      occurredAt,
      ...(actorKey === undefined ? {} : { actorKey }),
    });
  }

  async #reject(
    purpose: EmailLinkPurpose,
    subjectId: string | null,
    reason: EmailLinkRedemptionAuditReason,
    occurredAt: Date,
  ): Promise<EmailLinkRedemptionResult> {
    await this.#audit.append({
      action: "email_link.redeem",
      purpose,
      subjectId,
      outcome: "failure",
      reason,
      occurredAt,
    });
    return EMAIL_LINK_REJECTION;
  }
}

/**
 * Registers token pruning with the platform's retention cycle: rows whose
 * expiry lies more than the retention window in the past age out, and a live
 * token is never eligible because expiry is the only criterion.
 */
export const DEFAULT_EMAIL_LINK_TOKEN_RETENTION_MS = 30 * 24 * 60 * 60_000;

export function createEmailLinkTokenPruner(input: {
  readonly repository: { prune(input: { cutoffAt: Date; limit: number }): Promise<number> };
  readonly retentionMs?: number;
}): RetentionRecordPruner {
  const retentionMs = input.retentionMs ?? DEFAULT_EMAIL_LINK_TOKEN_RETENTION_MS;
  if (!Number.isInteger(retentionMs) || retentionMs < 1) {
    throw new RangeError("Email link token retention is out of bounds.");
  }
  return {
    kind: "email_link_tokens",
    retentionMs,
    prune: (request) => input.repository.prune(request),
  };
}

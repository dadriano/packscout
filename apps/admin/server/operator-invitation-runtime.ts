import {
  DatabaseEmailLinkRateLimiter,
  enqueueEmailMessageIntent,
  issueEmailLinkToken,
  PACKSCOUT_TRANSACTION_OPTIONS,
  PrismaEmailLinkAuditSink,
  PrismaEmailLinkTokenRepository,
  type OutstandingEmailLinkToken,
  type PackscoutPrismaClient,
} from "@packscout/database";
import {
  AuthServiceError,
  EmailLinkTokenService,
  EmailMessageOutboxService,
  createEmailLinkTokenSecurity,
  resolveEmailLinkTokenConfiguration,
  type AuthService,
  type Clock,
  type EmailLinkAuditRecorder,
  type EmailLinkIssuanceThrottle,
  type EmailLinkTokenConfiguration,
  type EmailLinkTokenSecurity,
  type EmailLinkTokenStore,
  type EnqueueEmailMessageCommand,
  type OperatorInvitationMessageInput,
} from "@packscout/services";
import type {
  OperatorInvitationFlow,
  OperatorInvitationRuntime,
} from "./routes/operators.ts";

/**
 * Wires operator provisioning by invitation over messaging/008's one-time
 * link mechanism, mirroring the password-reset composition beside it.
 * Everything security-critical — purpose scoping, single use, expiry,
 * hashing, rate limiting, the one uniform rejection — belongs to the token
 * service. This composition adds the three things it leaves to its consumer:
 *
 * - **Issuance is atomic with its message intent.** The token row and the
 *   durable outbox intent that carries its link land in one transaction, so
 *   no redeemable invitation exists that nobody was mailed. Reissuing takes
 *   exactly the same path, and the store's own issue supersedes the account's
 *   outstanding invitations as part of that transaction.
 * - **Redemption goes through the admin's own account machinery.** The
 *   redeemed subject's chosen password is hashed and applied by the single
 *   repository transition that leaves `pending`, guarded on that state inside
 *   the write.
 * - **Status is described without secrets.** The ledger learns that an
 *   invitation is outstanding, when it was sent, and whether it has expired —
 *   never a token, a selector, or a link.
 */

const INVITATION_PURPOSE = "operator_invitation" as const;

/** The outbox source word the per-source volume bound applies to. */
const INVITATION_OUTBOX_SOURCE = "operator_accounts";

/** The issue input the deferring store captures; identical to the database shape. */
type CapturedIssuance = Parameters<EmailLinkTokenStore["issue"]>[0];

/** The redemption store plus the reads the eligibility check and ledger use. */
export interface OperatorInvitationTokenStore extends EmailLinkTokenStore {
  findOutstanding(input: {
    readonly purpose: typeof INVITATION_PURPOSE;
    readonly subjectId: string;
  }): Promise<{ readonly addressNormalized: string } | null>;
  findOutstandingForSubjects(input: {
    readonly purpose: typeof INVITATION_PURPOSE;
    readonly subjectIds: readonly string[];
  }): Promise<Map<string, OutstandingEmailLinkToken>>;
  supersedeOutstanding(input: {
    readonly purpose: typeof INVITATION_PURPOSE;
    readonly subjectId: string;
    readonly now: Date;
  }): Promise<number>;
}

export interface OperatorInvitationFlowDependencies {
  readonly authService: Pick<
    AuthService,
    "isOperatorEligibleForInvitation" | "activateInvitedOperator"
  >;
  readonly security: EmailLinkTokenSecurity;
  readonly configuration: EmailLinkTokenConfiguration;
  readonly throttle: EmailLinkIssuanceThrottle;
  readonly linkAudit: EmailLinkAuditRecorder;
  readonly store: OperatorInvitationTokenStore;
  /**
   * Persists one issued token together with the message intent that carries
   * its link — both or neither. A refusal or failure must throw so the flow
   * records nothing half-done.
   */
  commitIssuance(input: {
    readonly token: CapturedIssuance;
    readonly message: EnqueueEmailMessageCommand;
  }): Promise<void>;
  readonly clock?: Clock;
}

export function createOperatorInvitationFlow(
  dependencies: OperatorInvitationFlowDependencies,
): OperatorInvitationFlow {
  const clock = dependencies.clock ?? { now: () => new Date() };
  const serviceOptions = {
    throttle: dependencies.throttle,
    audit: dependencies.linkAudit,
    verifierDigest: dependencies.security.verifierDigest,
    bucketKeyer: dependencies.security.bucketKeyer,
    configuration: dependencies.configuration,
    clock,
    randomness: dependencies.security.randomness,
  };
  const redemption = new EmailLinkTokenService({
    ...serviceOptions,
    store: dependencies.store,
  });

  return {
    async issueInvitation({
      operatorId,
      email,
      invitedByDisplayName,
      source,
      actorKey,
    }) {
      // The store defers: `issue` runs its throttle, supersession, and token
      // generation while the capture holds what to persist — committed below,
      // atomically with the message intent that carries the link.
      let captured: CapturedIssuance | null = null;
      const issuance = new EmailLinkTokenService({
        ...serviceOptions,
        store: {
          async issue(input) {
            captured = input;
            return { tokenId: input.id, supersededCount: 0 };
          },
          async findBySelector() {
            throw new Error("The issuance path never reads tokens.");
          },
          async consume() {
            throw new Error("The issuance path never consumes tokens.");
          },
        },
      });
      const result = await issuance.issue({
        purpose: INVITATION_PURPOSE,
        subjectId: operatorId,
        address: email,
        source,
        actorKey,
      });
      if (result.status !== "issued" || captured === null) {
        return { status: "rate_limited" };
      }
      const issued: CapturedIssuance = captured;
      const messageInput: OperatorInvitationMessageInput = {
        toEmail: issued.addressNormalized,
        invitedByDisplayName,
        invitationLinkPath: result.issued.linkPath,
        linkExpiresAt: result.issued.expiresAt.toISOString(),
      };
      await dependencies.commitIssuance({
        token: issued,
        message: {
          kind: INVITATION_PURPOSE,
          input: messageInput,
          recipient: issued.addressNormalized,
          idempotencyKey: `${INVITATION_PURPOSE}:${issued.id}`,
          source: INVITATION_OUTBOX_SOURCE,
        },
      });
      return {
        status: "issued",
        sentAt: issued.issuedAt.toISOString(),
        expiresAt: result.issued.expiresAt.toISOString(),
      };
    },

    async revokeInvitations(operatorId) {
      await dependencies.store.supersedeOutstanding({
        purpose: INVITATION_PURPOSE,
        subjectId: operatorId,
        now: clock.now(),
      });
    },

    async describeInvitations(operatorIds) {
      const now = clock.now();
      const outstanding = await dependencies.store.findOutstandingForSubjects({
        purpose: INVITATION_PURPOSE,
        subjectIds: operatorIds,
      });
      return new Map(
        [...outstanding].map(([operatorId, token]) => [
          operatorId,
          {
            sentAt: token.issuedAt.toISOString(),
            expiresAt: token.expiresAt.toISOString(),
            expired: token.expiresAt.getTime() <= now.getTime(),
          },
        ]),
      );
    },

    async acceptInvitation({ token, password }) {
      const redeemed = await redemption.redeem({
        purpose: INVITATION_PURPOSE,
        presentedToken: token,
        // Rechecked at redemption time, before the token is consumed: the
        // account behind the presented link's own outstanding invitation must
        // still exist, still hold the mailed address, and still be pending.
        // A cancelled account, an already-activated one, and a superseded
        // link all fail here and take the uniform rejection.
        isSubjectEligible: async (subjectId) => {
          const outstanding = await dependencies.store.findOutstanding({
            purpose: INVITATION_PURPOSE,
            subjectId,
          });
          if (!outstanding) return false;
          return dependencies.authService.isOperatorEligibleForInvitation(
            subjectId,
            outstanding.addressNormalized,
          );
        },
      });
      if (redeemed.status !== "redeemed") {
        return { status: "rejected" };
      }
      try {
        await dependencies.authService.activateInvitedOperator({
          operatorId: redeemed.subjectId,
          addressNormalized: redeemed.addressNormalized,
          newPassword: password,
        });
        return { status: "activated" };
      } catch (error) {
        // The token is already consumed — by design it can never be reused,
        // even when follow-on work fails. An eligibility race maps to the
        // uniform refusal; anything else is honest unavailability.
        if (error instanceof AuthServiceError && error.code === "FORBIDDEN") {
          return { status: "rejected" };
        }
        // Names the failed capability only — never an address, token, link,
        // password, or anything else the flow was holding.
        console.error(
          JSON.stringify({
            level: "error",
            event: "admin_operator_invitation_acceptance_failed",
          }),
        );
        return { status: "unavailable" };
      }
    },
  };
}

export interface AdminOperatorInvitationRuntimeInput {
  readonly database: PackscoutPrismaClient;
  readonly authService: AuthService;
  /** From `PACKSCOUT_EMAIL_LINK_TOKEN_SECRET`; at least 32 bytes. */
  readonly secret: string;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * The production composition over Prisma: database-backed rate buckets, the
 * shared audit ledger, the token repository, and one transaction that lands
 * the token row and its outbox intent together.
 */
export function createAdminOperatorInvitationRuntime(
  input: AdminOperatorInvitationRuntimeInput,
): OperatorInvitationRuntime {
  const clock: Clock = { now: () => new Date() };
  const flow = createOperatorInvitationFlow({
    authService: input.authService,
    security: createEmailLinkTokenSecurity(input.secret),
    configuration: resolveEmailLinkTokenConfiguration(input.env ?? process.env),
    throttle: new DatabaseEmailLinkRateLimiter(input.database),
    linkAudit: new PrismaEmailLinkAuditSink(input.database),
    store: new PrismaEmailLinkTokenRepository(input.database),
    clock,
    commitIssuance: async ({ token, message }) => {
      await input.database.$transaction(async (transaction) => {
        await issueEmailLinkToken(transaction, token);
        const outbox = new EmailMessageOutboxService({
          clock,
          queue: {
            enqueue: (enqueue) =>
              enqueueEmailMessageIntent(transaction, {
                kind: enqueue.kind,
                recipient: enqueue.recipient,
                idempotencyKey: enqueue.idempotencyKey,
                source: enqueue.source,
                serializedInput: JSON.stringify(enqueue.input ?? null),
                dueAt: enqueue.dueAt,
                now: enqueue.now,
                sourceActiveLimit: enqueue.sourceActiveLimit,
              }),
          },
        });
        const enqueued = await outbox.enqueueEmailMessage(message);
        if (enqueued.status !== "enqueued") {
          throw new Error("The operator invitation message intent was refused.");
        }
      }, PACKSCOUT_TRANSACTION_OPTIONS);
    },
  });
  return { flow };
}

import {
  DatabaseEmailLinkRateLimiter,
  enqueueEmailMessageIntent,
  issueEmailLinkToken,
  PACKSCOUT_TRANSACTION_OPTIONS,
  PrismaEmailLinkAuditSink,
  PrismaEmailLinkTokenRepository,
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
  type OperatorPasswordResetMessageInput,
} from "@packscout/services";
import type {
  OperatorPasswordResetFlow,
  PasswordResetRouterDependencies,
} from "./routes/password-reset.ts";

/**
 * Wires the operator password-reset flow over messaging/008's one-time link
 * mechanism and the admin's own authentication service. Everything
 * security-critical — purpose scoping, single use, expiry, hashing, per-
 * address and per-source rate limiting, non-enumeration, the uniform
 * rejection — belongs to the token service; this composition adds the two
 * things it deliberately leaves to its consumer:
 *
 * - **Issuance is atomic with its message intent.** The token row and the
 *   durable outbox intent that carries its link land in one transaction, so
 *   no redeemable token exists that nobody was mailed and no mail intent
 *   exists without its token. The token service's store is deferred: it
 *   captures the issue instead of persisting it, and the flow commits the
 *   capture together with the enqueue through the database package's
 *   transaction-composable `issueEmailLinkToken` + `enqueueEmailMessageIntent`.
 * - **Completion goes through the admin's existing session machinery.** The
 *   redeemed subject's password is rehashed and applied by the same
 *   repository update an administrator's credential rotation uses, which
 *   atomically revokes every active session for the operator.
 */

const RESET_PURPOSE = "operator_password_reset" as const;

/** The outbox source word the per-source volume bound applies to. */
const RESET_OUTBOX_SOURCE = "operator_accounts";

/** The issue input the deferring store captures; identical to the database shape. */
type CapturedIssuance = Parameters<EmailLinkTokenStore["issue"]>[0];

/** The redemption store plus the outstanding-token read the eligibility check uses. */
export interface PasswordResetTokenStore extends EmailLinkTokenStore {
  findOutstanding(input: {
    readonly purpose: typeof RESET_PURPOSE;
    readonly subjectId: string;
  }): Promise<{ readonly addressNormalized: string } | null>;
}

export interface OperatorPasswordResetFlowDependencies {
  readonly authService: Pick<
    AuthService,
    | "resolveActiveOperatorIdByEmail"
    | "isOperatorEligibleForPasswordReset"
    | "completePasswordReset"
  >;
  readonly security: EmailLinkTokenSecurity;
  readonly configuration: EmailLinkTokenConfiguration;
  readonly throttle: EmailLinkIssuanceThrottle;
  readonly linkAudit: EmailLinkAuditRecorder;
  readonly store: PasswordResetTokenStore;
  /**
   * Persists one issued token together with the message intent that carries
   * its link — both or neither. A refusal or failure must throw so the flow
   * records nothing half-done; the requester's response is unaffected.
   */
  commitIssuance(input: {
    readonly token: CapturedIssuance;
    readonly message: EnqueueEmailMessageCommand;
  }): Promise<void>;
  readonly clock?: Clock;
}

function contentFreeFailure(event: string): void {
  // Names the failed capability only — never an address, token, link,
  // password, or anything else the flow was holding.
  console.error(JSON.stringify({ level: "error", event }));
}

export function createOperatorPasswordResetFlow(
  dependencies: OperatorPasswordResetFlowDependencies,
): OperatorPasswordResetFlow {
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
    async requestReset({ email, source }) {
      try {
        // The store defers: requestIssuance runs its full non-enumerating
        // sequence (resolve once, throttle both scopes, generate and digest
        // once) while the capture holds what to persist — committed below,
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
        await issuance.requestIssuance({
          purpose: RESET_PURPOSE,
          address: email,
          source,
          resolveSubjectId: (addressNormalized) =>
            dependencies.authService.resolveActiveOperatorIdByEmail(
              addressNormalized,
            ),
          // Inside the issuance sequence, so the security trail records the
          // issuance only once the token row and its message intent have
          // landed. A commit that refuses is audited as uncommitted and
          // raised here, where the uniform response below absorbs it.
          commit: async (link) => {
            if (captured === null) {
              throw new Error("The issuance path captured no token to commit.");
            }
            const issued: CapturedIssuance = captured;
            const messageInput: OperatorPasswordResetMessageInput = {
              toEmail: issued.addressNormalized,
              resetLinkPath: link.linkPath,
              linkExpiresAt: link.expiresAt.toISOString(),
            };
            await dependencies.commitIssuance({
              token: issued,
              message: {
                kind: RESET_PURPOSE,
                input: messageInput,
                recipient: issued.addressNormalized,
                idempotencyKey: `${RESET_PURPOSE}:${issued.id}`,
                source: RESET_OUTBOX_SOURCE,
              },
            });
          },
        });
      } catch {
        // Never an oracle: a failed issuance or enqueue resolves exactly
        // like every other request. The audit trail and this content-free
        // event are the operational record.
        contentFreeFailure("admin_password_reset_request_failed");
      }
    },

    async completeReset({ token, password }) {
      const redeemed = await redemption.redeem({
        purpose: RESET_PURPOSE,
        presentedToken: token,
        // Rechecked at redemption time, before the token is consumed: the
        // operator behind the presented link's own outstanding token must
        // still exist, still hold the mailed address, and still be active.
        isSubjectEligible: async (subjectId) => {
          const outstanding = await dependencies.store.findOutstanding({
            purpose: RESET_PURPOSE,
            subjectId,
          });
          if (!outstanding) return false;
          return dependencies.authService.isOperatorEligibleForPasswordReset(
            subjectId,
            outstanding.addressNormalized,
          );
        },
      });
      if (redeemed.status !== "redeemed") {
        return { status: "rejected" };
      }
      try {
        await dependencies.authService.completePasswordReset({
          operatorId: redeemed.subjectId,
          addressNormalized: redeemed.addressNormalized,
          newPassword: password,
        });
        return { status: "completed" };
      } catch (error) {
        // The token is already consumed — by design it can never be reused,
        // even when follow-on work fails. An eligibility race maps to the
        // uniform refusal; anything else is honest unavailability.
        if (error instanceof AuthServiceError && error.code === "FORBIDDEN") {
          return { status: "rejected" };
        }
        contentFreeFailure("admin_password_reset_completion_failed");
        return { status: "unavailable" };
      }
    },
  };
}

export interface AdminPasswordResetRuntimeInput {
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
export function createAdminPasswordResetRuntime(
  input: AdminPasswordResetRuntimeInput,
): Omit<PasswordResetRouterDependencies, "sameOrigin"> {
  const clock: Clock = { now: () => new Date() };
  const flow = createOperatorPasswordResetFlow({
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
          throw new Error("The password reset message intent was refused.");
        }
      }, PACKSCOUT_TRANSACTION_OPTIONS);
    },
  });
  return { flow };
}

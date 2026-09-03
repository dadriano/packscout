import { z } from "zod";

export const operatorRoles = ["admin", "data_operator"] as const;

/**
 * Every state an operator account can hold. `pending` is an invited account
 * that has not yet proven control of its mailbox: it exists so it can carry a
 * role and appear in the access ledger, and it authenticates nowhere.
 * `cancelled` is an invitation an administrator withdrew — terminal, never
 * usable, and deliberately distinct from `disabled`, which is an account that
 * once worked and was switched off.
 */
export const operatorStates = [
  "pending",
  "active",
  "disabled",
  "cancelled",
] as const;

/**
 * The states an administrator may assign directly through the operator
 * update endpoint. `pending` is reached only by inviting, and `cancelled`
 * only by cancelling an invitation, so no ordinary update can manufacture or
 * escape an invited account's state.
 */
export const operatorAssignableStates = ["active", "disabled"] as const;

export type OperatorRole = (typeof operatorRoles)[number];
export type OperatorState = (typeof operatorStates)[number];
export type OperatorAssignableState = (typeof operatorAssignableStates)[number];

export const operatorPermissions = [
  "operators:manage",
  "providers:view",
  "providers:manage",
  "provider_secrets:manage",
  "imports:start",
  "imports:retry",
  "resources:archive",
  "product_users:view",
  "product_users:manage",
  "beta_allowlist:view",
  "beta_allowlist:manage",
  "message_delivery:view",
  "message_delivery:manage",
  "data_inspection:view",
  "pack_publication:recover",
  "pack_catalog:launch",
  "pack_catalog:prune",
] as const;

export type OperatorPermission = (typeof operatorPermissions)[number];

/**
 * The authoritative role grant. Product-user permissions expose personal data
 * (email addresses and wallet-linked identities) that the rest of the pipeline
 * deliberately pseudonymizes, so they are granted to `admin` only. The beta
 * allowlist carries the same kind of personal identifiers and decides who may
 * enter the closed beta, so its permissions are likewise administrator-only.
 * The message-delivery history is a record of who was sent what, so viewing
 * and managing it are administrator-only for the same reason.
 *
 * Data inspection is read-only and shows pipeline records — canonical business
 * data and its published counterpart — rather than personal data, so both roles
 * hold it. It is deliberately separate from `providers:view` so the grant can
 * be withdrawn without also removing provider configuration access.
 */
export const operatorRolePermissions: Readonly<
  Record<OperatorRole, readonly OperatorPermission[]>
> = Object.freeze({
  admin: Object.freeze([
    "operators:manage",
    "providers:view",
    "providers:manage",
    "provider_secrets:manage",
    "imports:start",
    "imports:retry",
    "resources:archive",
    "product_users:view",
    "product_users:manage",
    "beta_allowlist:view",
    "beta_allowlist:manage",
    "message_delivery:view",
    "message_delivery:manage",
    "data_inspection:view",
    "pack_publication:recover",
    "pack_catalog:launch",
    "pack_catalog:prune",
  ] as const),
  data_operator: Object.freeze([
    "providers:view",
    "imports:start",
    "imports:retry",
    "data_inspection:view",
  ] as const),
});

export function permissionsForOperatorRole(
  role: OperatorRole,
): OperatorPermission[] {
  return [...operatorRolePermissions[role]];
}

const emailSchema = z
  .string()
  .trim()
  .min(1, "Enter an email address.")
  .max(254, "Email must be 254 characters or fewer.")
  .email("Enter a valid email address.")
  .transform((value) => value.toLocaleLowerCase("en-US"));

const loginPasswordSchema = z
  .string()
  .min(1, "Enter a password.")
  .max(256, "Password must be 256 characters or fewer.");

const managedPasswordSchema = z
  .string()
  .min(12, "Password must be at least 12 characters.")
  .max(128, "Password must be 128 characters or fewer.");

export const loginRequestSchema = z
  .object({
    email: emailSchema,
    password: loginPasswordSchema,
  })
  .strict();

const displayNameSchema = z
  .string()
  .trim()
  .min(1, "Enter a display name.")
  .max(120, "Display name must be 120 characters or fewer.");

/**
 * Creating an operator by invitation: an address, a name, and a role, and
 * deliberately no password. The invited person chooses their own credential
 * by redeeming the mailed link, so a working password is never chosen by one
 * person and communicated to another.
 */
export const inviteOperatorRequestSchema = z
  .object({
    email: emailSchema,
    displayName: displayNameSchema,
    role: z.enum(operatorRoles),
  })
  .strict();

/**
 * Directly provisions an active operator with an administrator-chosen initial
 * password. This is intentionally separate from invitation creation so each
 * public boundary stays strict: invitations refuse passwords, while direct
 * provisioning requires one that meets the managed credential policy.
 */
export const directProvisionOperatorRequestSchema = z
  .object({
    email: emailSchema,
    displayName: displayNameSchema,
    password: managedPasswordSchema,
    role: z.enum(operatorRoles),
  })
  .strict();

export const updateOperatorRequestSchema = z
  .object({
    displayName: displayNameSchema.optional(),
    password: managedPasswordSchema.optional(),
    role: z.enum(operatorRoles).optional(),
    state: z.enum(operatorAssignableStates).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "Provide at least one operator change.",
  });

export const operatorIdSchema = z.string().uuid("Operator ID must be a UUID.");

export const listOperatorsQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    search: z.string().trim().max(120).optional(),
    role: z.enum(operatorRoles).optional(),
    state: z.enum(operatorStates).optional(),
  })
  .strict();

export interface OperatorIdentity {
  id: string;
  email: string;
  displayName: string;
  state: OperatorState;
}

export interface OrganizationMembership {
  organizationId: string;
  organizationName: string;
  role: OperatorRole;
}

export interface SessionUser extends OperatorIdentity {
  role: OperatorRole;
}

export interface AuthSessionResponse {
  operator: OperatorIdentity;
  membership: OrganizationMembership;
  permissions: OperatorPermission[];
  csrfToken: string;
}

/**
 * What an administrator may see about an account's outstanding invitation:
 * that one exists, when it was sent, when it stops working, and whether it
 * already has. Deliberately no token, no link, and no selector — the usable
 * material exists only inside the message that was mailed.
 */
export interface OperatorInvitationStatus {
  sentAt: string;
  expiresAt: string;
  expired: boolean;
}

export interface OperatorSummary extends SessionUser {
  createdAt: string;
  updatedAt: string;
  lastAccessAt: string | null;
  /**
   * Present only while an invitation is outstanding for a pending account.
   * `null` covers every other case: an activated account, a cancelled one,
   * and a pending one whose invitation was withdrawn or already redeemed.
   */
  invitation?: OperatorInvitationStatus | null;
}

export interface OperatorListResponse {
  items: OperatorSummary[];
  nextCursor: string | null;
}

export interface OperatorMutationResponse {
  operator: OperatorSummary;
}

export const operatorAccountCreatedNotificationFailureReasons = [
  "EMAIL_OUTBOX_UNAVAILABLE",
  "EMAIL_OUTBOX_SOURCE_BACKLOG_EXCEEDED",
  "EMAIL_OUTBOX_REQUEST_INVALID",
  "OPERATOR_ACCOUNT_CREATED_EMAIL_UNCONFIGURED",
] as const;

export type OperatorAccountCreatedNotificationFailureReason =
  (typeof operatorAccountCreatedNotificationFailureReasons)[number];

export type OperatorAccountCreatedNotificationOutcome =
  | { status: "enqueued"; deduplicated: boolean }
  | {
      status: "failed";
      reason: OperatorAccountCreatedNotificationFailureReason;
    };

/**
 * Direct provisioning commits the account before enqueueing its informational
 * email. The explicit notification outcome keeps a durable account from being
 * misreported as failed when only its follow-up email could not be queued.
 */
export interface DirectProvisionOperatorResponse
  extends OperatorMutationResponse {
  notification: OperatorAccountCreatedNotificationOutcome;
}

export type LoginRequest = z.input<typeof loginRequestSchema>;
export type NormalizedLoginRequest = z.output<typeof loginRequestSchema>;
export type InviteOperatorRequest = z.input<typeof inviteOperatorRequestSchema>;
export type NormalizedInviteOperatorRequest = z.output<
  typeof inviteOperatorRequestSchema
>;
export type DirectProvisionOperatorRequest = z.input<
  typeof directProvisionOperatorRequestSchema
>;
export type NormalizedDirectProvisionOperatorRequest = z.output<
  typeof directProvisionOperatorRequestSchema
>;
export type UpdateOperatorRequest = z.input<typeof updateOperatorRequestSchema>;
export type NormalizedUpdateOperatorRequest = z.output<
  typeof updateOperatorRequestSchema
>;
export type ListOperatorsQuery = z.output<typeof listOperatorsQuerySchema>;

export const authErrorCodes = [
  "AUTH_REQUIRED",
  "INVALID_CREDENTIALS",
  "FORBIDDEN",
  "VALIDATION_FAILED",
  "RATE_LIMITED",
  "OPERATOR_EMAIL_CONFLICT",
  "LAST_ACTIVE_ADMIN",
  "OPERATOR_NOT_FOUND",
  "OPERATOR_NOT_ACTIVATED",
  "SERVICE_UNAVAILABLE",
] as const;

export type AuthErrorCode = (typeof authErrorCodes)[number];

/**
 * Operator password reset (messaging/009). The request side carries only an
 * email address; whether that address belongs to an operator is never
 * reflected in any response, so the schema's own failures are purely
 * syntactic. The completion side carries the presented one-time token as an
 * opaque bounded string — its real validation is redemption, which refuses
 * every invalid shape with the same outcome — plus the new password, held to
 * exactly the same rules an administrator-set password must satisfy.
 */
export const passwordResetRequestSchema = z
  .object({
    email: emailSchema,
  })
  .strict();

export const passwordResetCompletionRequestSchema = z
  .object({
    token: z
      .string()
      .min(1, "The reset link is incomplete. Open it from your email again.")
      .max(512, "The reset link is incomplete. Open it from your email again."),
    password: managedPasswordSchema,
  })
  .strict();

export type PasswordResetRequest = z.input<typeof passwordResetRequestSchema>;
export type NormalizedPasswordResetRequest = z.output<
  typeof passwordResetRequestSchema
>;
export type PasswordResetCompletionRequest = z.input<
  typeof passwordResetCompletionRequestSchema
>;
export type NormalizedPasswordResetCompletionRequest = z.output<
  typeof passwordResetCompletionRequestSchema
>;

/**
 * Operator invitation redemption (messaging/010). The mailed link's token
 * rides in the query string and is posted here once; like the reset flow it
 * is carried as an opaque bounded string, because its real validation is
 * redemption — which refuses every invalid, expired, superseded, cancelled,
 * and already-used presentation with one indistinguishable outcome. The
 * chosen password is held to exactly the same rules an administrator-set
 * password must satisfy, so invitation introduces no password policy.
 */
export const operatorInvitationAcceptanceRequestSchema = z
  .object({
    token: z
      .string()
      .min(
        1,
        "The invitation link is incomplete. Open it from your email again.",
      )
      .max(
        512,
        "The invitation link is incomplete. Open it from your email again.",
      ),
    password: managedPasswordSchema,
  })
  .strict();

export type OperatorInvitationAcceptanceRequest = z.input<
  typeof operatorInvitationAcceptanceRequestSchema
>;
export type NormalizedOperatorInvitationAcceptanceRequest = z.output<
  typeof operatorInvitationAcceptanceRequestSchema
>;

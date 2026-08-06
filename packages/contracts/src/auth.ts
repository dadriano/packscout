import { z } from "zod";

export const operatorRoles = ["admin", "data_operator"] as const;
export const operatorStates = ["active", "disabled"] as const;

export type OperatorRole = (typeof operatorRoles)[number];
export type OperatorState = (typeof operatorStates)[number];

export const operatorPermissions = [
  "operators:manage",
  "providers:view",
  "providers:manage",
  "provider_secrets:manage",
  "imports:start",
  "imports:retry",
  "resources:archive",
] as const;

export type OperatorPermission = (typeof operatorPermissions)[number];

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

export const createOperatorRequestSchema = z
  .object({
    email: emailSchema,
    displayName: z
      .string()
      .trim()
      .min(1, "Enter a display name.")
      .max(120, "Display name must be 120 characters or fewer."),
    password: managedPasswordSchema,
    role: z.enum(operatorRoles),
  })
  .strict();

export const updateOperatorRequestSchema = z
  .object({
    displayName: z
      .string()
      .trim()
      .min(1, "Enter a display name.")
      .max(120, "Display name must be 120 characters or fewer.")
      .optional(),
    password: managedPasswordSchema.optional(),
    role: z.enum(operatorRoles).optional(),
    state: z.enum(operatorStates).optional(),
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

export interface OperatorSummary extends SessionUser {
  createdAt: string;
  updatedAt: string;
  lastAccessAt: string | null;
}

export interface OperatorListResponse {
  items: OperatorSummary[];
  nextCursor: string | null;
}

export interface OperatorMutationResponse {
  operator: OperatorSummary;
}

export type LoginRequest = z.input<typeof loginRequestSchema>;
export type NormalizedLoginRequest = z.output<typeof loginRequestSchema>;
export type CreateOperatorRequest = z.input<typeof createOperatorRequestSchema>;
export type NormalizedCreateOperatorRequest = z.output<
  typeof createOperatorRequestSchema
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
  "SERVICE_UNAVAILABLE",
] as const;

export type AuthErrorCode = (typeof authErrorCodes)[number];

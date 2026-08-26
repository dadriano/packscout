import {
  operationalSeveritySchema,
  type OperationalSeverity,
} from "@packscout/contracts";
import type { MessageCatalogueOrigins } from "./origins.ts";
import {
  EMAIL_MESSAGE_CONTENT_UNSAFE_ERROR_CODE,
  EMAIL_MESSAGE_INPUT_INVALID_ERROR_CODE,
  EMAIL_MESSAGE_ORIGIN_MISSING_ERROR_CODE,
  absoluteEmailMessageLink,
  emailMessageRenderFailure,
  escapeEmailHtml,
  finalizeRenderedEmailMessage,
  formatEmailInstantUtc,
  normalizeEmailMessageProse,
  unsafeEmailMessageContent,
  type EmailMessageRenderFailure,
  type EmailMessageRenderResult,
} from "./rendering.ts";

/**
 * The message catalogue: every kind of message PackScout sends, defined in
 * one place. Senders describe what happened through a typed input; one
 * rendering entry point per kind produces the subject, real plain-text body,
 * and HTML body the delivery boundary accepts. Both bodies carry the same
 * information and the same actions, every link is absolute and built from a
 * configured public origin, every interpolated value is escaped and checked
 * against the unsafe-content rules, and rendering is pure — same input, same
 * output, with no clock, network, or database access.
 */

export const CATALOGUE_EMAIL_MESSAGE_KINDS = [
  "operational_alert",
  "operational_alert_recovery",
  "access_approved",
  "access_declined",
  "welcome",
  "operator_password_reset",
  "operator_invitation",
  "operator_account_created",
] as const;

export type CatalogueEmailMessageKind =
  (typeof CATALOGUE_EMAIL_MESSAGE_KINDS)[number];

/** Who a message kind addresses; it decides which public origin links use. */
export type EmailMessageAudience = "operator" | "product_user";

/**
 * A kind's transactional character, encoded structurally. Every kind in this
 * feature is transactional. A promotional kind must carry a working
 * unsubscribe path, and PackScout has no preference centre — so the
 * promotional branch requires a value of type `never` and cannot be
 * constructed. When a preference centre exists, `never` becomes its
 * unsubscribe-path type and the compiler starts demanding one per kind.
 */
export type EmailMessageCharacter =
  | { readonly transactional: true }
  | { readonly transactional: false; readonly unsubscribePath: never };

export interface EmailMessageKindDefinition {
  readonly kind: CatalogueEmailMessageKind;
  readonly audience: EmailMessageAudience;
  readonly character: EmailMessageCharacter;
  /** The footer's answer to "why am I receiving this", per kind. */
  readonly reasonForReceiving: string;
}

/** Every message kind this feature sends, keyed by its stable kind id. */
export const emailMessageCatalogue: Readonly<
  Record<CatalogueEmailMessageKind, EmailMessageKindDefinition>
> = {
  operational_alert: {
    kind: "operational_alert",
    audience: "operator",
    character: { transactional: true },
    reasonForReceiving:
      "You are receiving it because this address is configured to receive PackScout operational alerts.",
  },
  operational_alert_recovery: {
    kind: "operational_alert_recovery",
    audience: "operator",
    character: { transactional: true },
    reasonForReceiving:
      "You are receiving it because this address is configured to receive PackScout operational alerts.",
  },
  access_approved: {
    kind: "access_approved",
    audience: "product_user",
    character: { transactional: true },
    reasonForReceiving:
      "You are receiving it because this address asked for access to the PackScout closed beta.",
  },
  access_declined: {
    kind: "access_declined",
    audience: "product_user",
    character: { transactional: true },
    reasonForReceiving:
      "You are receiving it because this address asked for access to the PackScout closed beta.",
  },
  welcome: {
    kind: "welcome",
    audience: "product_user",
    character: { transactional: true },
    reasonForReceiving:
      "You are receiving this one-time message because this address signed in to the PackScout closed beta.",
  },
  operator_password_reset: {
    kind: "operator_password_reset",
    audience: "operator",
    character: { transactional: true },
    reasonForReceiving:
      "You are receiving it because a password reset was requested for the PackScout admin account at this address.",
  },
  operator_invitation: {
    kind: "operator_invitation",
    audience: "operator",
    character: { transactional: true },
    reasonForReceiving:
      "You are receiving it because an administrator invited this address to operate the PackScout admin.",
  },
  operator_account_created: {
    kind: "operator_account_created",
    audience: "operator",
    character: { transactional: true },
    reasonForReceiving:
      "You are receiving it because an administrator created an active PackScout admin operator account for this address.",
  },
};

/** Alert titles share the operational notification contract's title bound. */
export const EMAIL_MESSAGE_TITLE_MAX_LENGTH = 160;
/** Alert summaries share the operational notification contract's bound. */
export const EMAIL_MESSAGE_SUMMARY_MAX_LENGTH = 500;
/** Inviter names share the admin operator display-name bound. */
export const EMAIL_MESSAGE_DISPLAY_NAME_MAX_LENGTH = 120;
/** An alert message never carries more evidence codes than this. */
export const EMAIL_MESSAGE_MAX_EVIDENCE_CODES = 8;

/** Evidence codes reuse the operational stable-code alphabet. */
const stableEvidenceCodePattern = /^[A-Z][A-Z0-9_]{0,127}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- Typed inputs: what happened, to whom, and the few values the copy needs.

export interface OperationalAlertMessageInput {
  readonly toEmail: string;
  readonly severity: OperationalSeverity;
  /** The alert's already-safe title; credential-shaped text fails rendering. */
  readonly title: string;
  /** The alert's already-safe summary; never a raw provider error. */
  readonly summary: string;
  /** Stable evidence codes only — never payload content. May be empty. */
  readonly evidenceCodes: readonly string[];
  readonly occurrenceCount: number;
  /** When the alert was first seen, as an ISO-8601 instant. */
  readonly firstSeenAt: string;
  /** The admin alert identifier the review link points at. */
  readonly alertId: string;
}

export interface OperationalAlertRecoveryMessageInput
  extends OperationalAlertMessageInput {
  /** When the alert recovered, as an ISO-8601 instant. */
  readonly recoveredAt: string;
}

export interface AccessApprovedMessageInput {
  readonly toEmail: string;
}

export interface AccessDeclinedMessageInput {
  readonly toEmail: string;
}

export interface WelcomeMessageInput {
  readonly toEmail: string;
}

export interface OperatorPasswordResetMessageInput {
  readonly toEmail: string;
  /**
   * The rooted admin path of the one-time reset link, opaque token included.
   * The catalogue builds the absolute link from the configured admin origin,
   * never inspects or generates the token, and never logs the link.
   */
  readonly resetLinkPath: string;
  /** When the link stops working, as an ISO-8601 instant. */
  readonly linkExpiresAt: string;
}

export interface OperatorInvitationMessageInput {
  readonly toEmail: string;
  /** Who invited them, as the inviting operator's display name. */
  readonly invitedByDisplayName: string;
  /** The rooted admin path of the single-use invitation link. */
  readonly invitationLinkPath: string;
  /** When the link stops working, as an ISO-8601 instant. */
  readonly linkExpiresAt: string;
}

/**
 * The direct-provisioning notice needs only its recipient. Credential material
 * is deliberately absent: the initial password is shared through a separate
 * secure channel and must never enter the outbox rendering input.
 */
export interface OperatorAccountCreatedMessageInput {
  readonly toEmail: string;
}

// --- Shared presentation: one visual and verbal identity for every message.

const SENDER_IDENTITY_LINE =
  "PackScout — closed-beta market intelligence for collectible repacks.";
const TRANSACTIONAL_LINE =
  "This is a transactional service message; PackScout does not send marketing email.";

const severityLabels: Readonly<Record<OperationalSeverity, string>> = {
  info: "Info",
  warning: "Warning",
  critical: "Critical",
};

const severityColors: Readonly<Record<OperationalSeverity, string>> = {
  info: "#1d4ed8",
  warning: "#b45309",
  critical: "#b91c1c",
};

const paragraphStyle =
  "margin:0 0 14px;font-size:15px;line-height:1.55;color:#1f2937;";
const factsStyle =
  "margin:0 0 14px;font-size:14px;line-height:1.7;color:#374151;";
const buttonStyle =
  "display:inline-block;background-color:#111827;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:11px 20px;border-radius:6px;";
const fallbackLinkStyle =
  "margin:0 0 14px;font-size:13px;line-height:1.5;color:#4b5563;word-break:break-all;";
const inlineLinkStyle = "color:#1d4ed8;text-decoration:underline;";

/** One unit of body content carried identically by both bodies. */
interface EmailBodyBlock {
  readonly text: string;
  readonly html: string;
}

function paragraphBlock(text: string): EmailBodyBlock {
  return {
    text,
    html: `<p style="${paragraphStyle}">${escapeEmailHtml(text)}</p>`,
  };
}

function factsBlock(
  facts: ReadonlyArray<{ readonly label: string; readonly value: string }>,
): EmailBodyBlock {
  return {
    text: facts.map(({ label, value }) => `${label}: ${value}`).join("\n"),
    html: `<p style="${factsStyle}">${facts
      .map(
        ({ label, value }) =>
          `<strong>${escapeEmailHtml(label)}:</strong> ${escapeEmailHtml(value)}`,
      )
      .join("<br>")}</p>`,
  };
}

/**
 * The one action a message offers: a labelled absolute link. The HTML body
 * shows a button plus the full URL as visible text, so the action and the
 * destination stay identical to the plain-text body even with images blocked.
 */
function linkActionBlock(label: string, href: string): EmailBodyBlock {
  const escapedHref = escapeEmailHtml(href);
  return {
    text: `${label}:\n${href}`,
    html:
      `<p style="margin:0 0 10px;"><a href="${escapedHref}" style="${buttonStyle}">${escapeEmailHtml(label)}</a></p>` +
      `<p style="${fallbackLinkStyle}">Or open this link directly:<br><a href="${escapedHref}" style="${inlineLinkStyle}">${escapedHref}</a></p>`,
  };
}

function linkListBlock(
  items: ReadonlyArray<{ readonly label: string; readonly href: string }>,
): EmailBodyBlock {
  return {
    text: items.map(({ label, href }) => `- ${label}:\n  ${href}`).join("\n"),
    html: `<ul style="margin:0 0 14px;padding:0 0 0 20px;">${items
      .map(
        ({ label, href }) =>
          `<li style="margin:0 0 8px;font-size:15px;line-height:1.55;color:#1f2937;">${escapeEmailHtml(label)}:<br><a href="${escapeEmailHtml(href)}" style="${inlineLinkStyle}word-break:break-all;">${escapeEmailHtml(href)}</a></li>`,
      )
      .join("")}</ul>`,
  };
}

interface EmailMessageLayout {
  readonly kind: CatalogueEmailMessageKind;
  readonly toEmail: string;
  readonly subject: string;
  readonly heading: string;
  /** An optional short line rendered above the heading, e.g. a severity. */
  readonly kicker?: { readonly text: string; readonly color: string };
  readonly blocks: readonly EmailBodyBlock[];
}

/**
 * Assembles the shared layout — brand header, heading, content blocks, and
 * the footer identifying who is sending and why — then runs the final
 * delivery-contract gate. The HTML document is self-contained: inline styles
 * only, no external stylesheet, script, font, or image, so it reads
 * identically with remote content blocked.
 */
function renderThroughLayout(layout: EmailMessageLayout): EmailMessageRenderResult {
  const { reasonForReceiving } = emailMessageCatalogue[layout.kind];
  const textBody = [
    layout.kicker === undefined
      ? layout.heading
      : `${layout.kicker.text}\n${layout.heading}`,
    ...layout.blocks.map((block) => block.text),
    `-- \n${SENDER_IDENTITY_LINE}\n${reasonForReceiving}\n${TRANSACTIONAL_LINE}`,
  ].join("\n\n");
  const kickerHtml =
    layout.kicker === undefined
      ? ""
      : `<p style="margin:0 0 6px;font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${layout.kicker.color};">${escapeEmailHtml(layout.kicker.text)}</p>`;
  const htmlBody =
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeEmailHtml(layout.subject)}</title></head>` +
    `<body style="margin:0;padding:0;background-color:#f4f4f5;">` +
    `<div style="max-width:560px;margin:0 auto;padding:24px 16px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">` +
    `<p style="margin:0 0 14px;font-size:15px;font-weight:700;letter-spacing:0.02em;color:#111827;">PackScout <span style="font-weight:400;color:#6b7280;">· closed beta</span></p>` +
    `<div style="background-color:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:24px;">` +
    kickerHtml +
    `<h1 style="margin:0 0 14px;font-size:20px;line-height:1.3;color:#111827;">${escapeEmailHtml(layout.heading)}</h1>` +
    layout.blocks.map((block) => block.html).join("") +
    `</div>` +
    `<p style="margin:16px 0 0;font-size:12px;line-height:1.6;color:#6b7280;">${escapeEmailHtml(SENDER_IDENTITY_LINE)}<br>${escapeEmailHtml(reasonForReceiving)}<br>${escapeEmailHtml(TRANSACTIONAL_LINE)}</p>` +
    `</div></body></html>`;
  return finalizeRenderedEmailMessage({
    kind: layout.kind,
    toEmail: layout.toEmail,
    subject: layout.subject,
    textBody,
    htmlBody,
  });
}

// --- Shared input validation helpers. Failures are static and content-free.

function invalidInput(reason: string): EmailMessageRenderFailure {
  return emailMessageRenderFailure(
    EMAIL_MESSAGE_INPUT_INVALID_ERROR_CODE,
    reason,
  );
}

function unsafeContent(reason: string): EmailMessageRenderFailure {
  return emailMessageRenderFailure(
    EMAIL_MESSAGE_CONTENT_UNSAFE_ERROR_CODE,
    reason,
  );
}

function missingOrigin(reason: string): EmailMessageRenderFailure {
  return emailMessageRenderFailure(
    EMAIL_MESSAGE_ORIGIN_MISSING_ERROR_CODE,
    reason,
  );
}

type Validated<T> = { readonly value: T } | { readonly failure: EmailMessageRenderFailure };

function validatedProse(
  value: unknown,
  maximumLength: number,
  description: string,
): Validated<string> {
  const normalized = normalizeEmailMessageProse(value, maximumLength);
  if (normalized === null) {
    return { failure: invalidInput(`The ${description} is missing or invalid.`) };
  }
  if (unsafeEmailMessageContent(normalized)) {
    return {
      failure: unsafeContent(
        `The ${description} looks like it carries a credential or token.`,
      ),
    };
  }
  return { value: normalized };
}

function validatedInstant(
  value: unknown,
  description: string,
): Validated<string> {
  const formatted = formatEmailInstantUtc(value);
  return formatted === null
    ? { failure: invalidInput(`The ${description} is not a valid instant.`) }
    : { value: formatted };
}

function validatedAdminLink(
  adminOrigin: string | null,
  path: unknown,
  description: string,
): Validated<string> {
  if (adminOrigin === null) {
    return {
      failure: missingOrigin(
        "No admin public origin is configured, so an absolute link cannot be built.",
      ),
    };
  }
  const href = absoluteEmailMessageLink(adminOrigin, path);
  return href === null
    ? { failure: invalidInput(`The ${description} is not a valid rooted path.`) }
    : { value: href };
}

function validatedProductLink(
  productOrigin: string | null,
  path: string,
): Validated<string> {
  if (productOrigin === null) {
    return {
      failure: missingOrigin(
        "No product public origin is configured, so an absolute link cannot be built.",
      ),
    };
  }
  const href = absoluteEmailMessageLink(productOrigin, path);
  return href === null
    ? { failure: invalidInput("The product link path is not valid.") }
    : { value: href };
}

function validatedOperatorAccountCreatedInput(
  input: unknown,
): Validated<OperatorAccountCreatedMessageInput> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {
      failure: invalidInput(
        "The operator account-created message input is missing or invalid.",
      ),
    };
  }
  const keys = Object.keys(input);
  if (keys.length !== 1 || keys[0] !== "toEmail") {
    return {
      failure: invalidInput(
        "The operator account-created message input contains unsupported fields.",
      ),
    };
  }
  const toEmail = (input as { readonly toEmail?: unknown }).toEmail;
  if (typeof toEmail !== "string") {
    return {
      failure: invalidInput(
        "The operator account-created message recipient is missing or invalid.",
      ),
    };
  }
  return { value: { toEmail } };
}

interface ValidatedAlertValues {
  readonly severity: OperationalSeverity;
  readonly title: string;
  readonly summary: string;
  readonly evidenceCodes: readonly string[];
  readonly occurrenceCount: string;
  readonly firstSeenAt: string;
  readonly reviewHref: string;
}

function validatedAlertValues(
  input: OperationalAlertMessageInput,
  origins: MessageCatalogueOrigins,
): Validated<ValidatedAlertValues> {
  const severity = operationalSeveritySchema.safeParse(input.severity);
  if (!severity.success) {
    return { failure: invalidInput("The alert severity is not recognized.") };
  }
  const title = validatedProse(
    input.title,
    EMAIL_MESSAGE_TITLE_MAX_LENGTH,
    "alert title",
  );
  if ("failure" in title) return title;
  const summary = validatedProse(
    input.summary,
    EMAIL_MESSAGE_SUMMARY_MAX_LENGTH,
    "alert summary",
  );
  if ("failure" in summary) return summary;
  if (
    !Array.isArray(input.evidenceCodes) ||
    input.evidenceCodes.length > EMAIL_MESSAGE_MAX_EVIDENCE_CODES ||
    input.evidenceCodes.some(
      (code) => typeof code !== "string" || !stableEvidenceCodePattern.test(code),
    )
  ) {
    return { failure: invalidInput("The alert evidence codes are invalid.") };
  }
  if (
    !Number.isSafeInteger(input.occurrenceCount) ||
    input.occurrenceCount < 1
  ) {
    return { failure: invalidInput("The alert occurrence count is invalid.") };
  }
  const firstSeenAt = validatedInstant(input.firstSeenAt, "alert first-seen time");
  if ("failure" in firstSeenAt) return firstSeenAt;
  if (typeof input.alertId !== "string" || !uuidPattern.test(input.alertId)) {
    return { failure: invalidInput("The alert identifier is invalid.") };
  }
  const reviewHref = validatedAdminLink(
    origins.adminOrigin,
    `/alerts/${input.alertId.toLowerCase()}`,
    "alert link",
  );
  if ("failure" in reviewHref) return reviewHref;
  return {
    value: {
      severity: severity.data,
      title: title.value,
      summary: summary.value,
      evidenceCodes: input.evidenceCodes,
      occurrenceCount: String(input.occurrenceCount),
      firstSeenAt: firstSeenAt.value,
      reviewHref: reviewHref.value,
    },
  };
}

// --- Rendering entry points: one per message kind.

/**
 * An operational alert to an operator: what happened, how often, since when,
 * and where to look in the admin — built only from the alert's already-safe
 * title, summary, and evidence codes.
 */
export function renderOperationalAlertMessage(
  input: OperationalAlertMessageInput,
  origins: MessageCatalogueOrigins,
): EmailMessageRenderResult {
  const validated = validatedAlertValues(input, origins);
  if ("failure" in validated) return validated.failure;
  const values = validated.value;
  const facts: Array<{ label: string; value: string }> = [
    { label: "Severity", value: severityLabels[values.severity] },
    { label: "First seen", value: values.firstSeenAt },
    { label: "Occurrences", value: values.occurrenceCount },
  ];
  if (values.evidenceCodes.length > 0) {
    facts.push({
      label: "Evidence codes",
      value: values.evidenceCodes.join(", "),
    });
  }
  return renderThroughLayout({
    kind: "operational_alert",
    toEmail: input.toEmail,
    subject: `PackScout alert (${severityLabels[values.severity].toLowerCase()}): ${values.title}`,
    heading: values.title,
    kicker: {
      text: `${severityLabels[values.severity]} alert`,
      color: severityColors[values.severity],
    },
    blocks: [
      factsBlock(facts),
      paragraphBlock(values.summary),
      linkActionBlock("Review this alert in the admin", values.reviewHref),
    ],
  });
}

/**
 * The matching recovery note: the operators who were told about an alert
 * learn that it recovered, so nobody chases a fixed problem.
 */
export function renderOperationalAlertRecoveryMessage(
  input: OperationalAlertRecoveryMessageInput,
  origins: MessageCatalogueOrigins,
): EmailMessageRenderResult {
  const validated = validatedAlertValues(input, origins);
  if ("failure" in validated) return validated.failure;
  const recoveredAt = validatedInstant(input.recoveredAt, "alert recovery time");
  if ("failure" in recoveredAt) return recoveredAt.failure;
  const values = validated.value;
  return renderThroughLayout({
    kind: "operational_alert_recovery",
    toEmail: input.toEmail,
    subject: `PackScout alert recovered: ${values.title}`,
    heading: values.title,
    kicker: { text: "Recovered", color: "#047857" },
    blocks: [
      paragraphBlock(
        "This alert has recovered. No further action is needed.",
      ),
      factsBlock([
        { label: "Severity", value: severityLabels[values.severity] },
        { label: "First seen", value: values.firstSeenAt },
        { label: "Recovered", value: recoveredAt.value },
        { label: "Occurrences while active", value: values.occurrenceCount },
      ]),
      paragraphBlock(values.summary),
      linkActionBlock("Review the alert history in the admin", values.reviewHref),
    ],
  });
}

/**
 * Tells a waiting person plainly that they are in, with a link to the
 * product. Carries no credential or sign-in token: they sign in the way they
 * already did.
 */
export function renderAccessApprovedMessage(
  input: AccessApprovedMessageInput,
  origins: MessageCatalogueOrigins,
): EmailMessageRenderResult {
  const openHref = validatedProductLink(origins.productOrigin, "/");
  if ("failure" in openHref) return openHref.failure;
  return renderThroughLayout({
    kind: "access_approved",
    toEmail: input.toEmail,
    subject: "Your PackScout beta access is approved",
    heading: "You're in",
    blocks: [
      paragraphBlock(
        "An administrator approved your access to the PackScout closed beta. Your account is ready now.",
      ),
      paragraphBlock(
        "Sign in the same way you first signed up — no new password, code, or invitation is needed.",
      ),
      linkActionBlock("Open PackScout", openHref.value),
    ],
  });
}

/**
 * A brief, respectful decline: access is not available, with no operator
 * notes, no internal reasoning, and no reply thread the product cannot
 * service. Deliberately link-free.
 */
export function renderAccessDeclinedMessage(
  input: AccessDeclinedMessageInput,
  origins: MessageCatalogueOrigins,
): EmailMessageRenderResult {
  // The decline is deliberately link-free, so no origin is required; the
  // parameter stays for the uniform renderer signature consumers rely on.
  void origins;
  return renderThroughLayout({
    kind: "access_declined",
    toEmail: input.toEmail,
    subject: "An update on your PackScout beta access",
    heading: "About your beta access request",
    blocks: [
      paragraphBlock(
        "Thank you for your interest in PackScout. After review, closed-beta access is not available for your account at this time.",
      ),
      paragraphBlock(
        "The beta is deliberately small while the product takes shape. No action is needed on your part.",
      ),
    ],
  });
}

/**
 * The one-time welcome at first admitted sign-in: what PackScout does, where
 * to start, what the numbers mean, and the closed-beta note. Orientation
 * only — nothing promotional.
 */
export function renderWelcomeMessage(
  input: WelcomeMessageInput,
  origins: MessageCatalogueOrigins,
): EmailMessageRenderResult {
  const dashboardHref = validatedProductLink(origins.productOrigin, "/");
  if ("failure" in dashboardHref) return dashboardHref.failure;
  const packsHref = validatedProductLink(origins.productOrigin, "/packs");
  if ("failure" in packsHref) return packsHref.failure;
  const learnHref = validatedProductLink(origins.productOrigin, "/learn");
  if ("failure" in learnHref) return learnHref.failure;
  return renderThroughLayout({
    kind: "welcome",
    toEmail: input.toEmail,
    subject: "Welcome to PackScout",
    heading: "Welcome to PackScout",
    blocks: [
      paragraphBlock(
        "You're in the closed beta. PackScout tracks collectible repacks across marketplaces and estimates the value inside each one, so you can compare packs before you buy.",
      ),
      paragraphBlock("Where to start:"),
      linkListBlock([
        {
          label: "Dashboard — live repacks ranked by estimated value",
          href: dashboardHref.value,
        },
        {
          label: "All repacks — every pack PackScout tracks, with filters",
          href: packsHref.value,
        },
        {
          label:
            "Learn — how estimated value is calculated and what the confidence labels mean",
          href: learnHref.value,
        },
      ]),
      paragraphBlock(
        "A note on the numbers: estimates are decision support built from live listing and sales data, not a promise of what any single pack contains.",
      ),
      paragraphBlock(
        "PackScout is a closed beta: coverage grows week by week, and you may find rough edges.",
      ),
    ],
  });
}

/**
 * The operator password-reset message: a single one-time link, its expiry,
 * and the plain statement that no action is needed if the recipient did not
 * request the reset. The token inside the link arrives as an opaque input.
 */
export function renderOperatorPasswordResetMessage(
  input: OperatorPasswordResetMessageInput,
  origins: MessageCatalogueOrigins,
): EmailMessageRenderResult {
  const resetHref = validatedAdminLink(
    origins.adminOrigin,
    input.resetLinkPath,
    "reset link path",
  );
  if ("failure" in resetHref) return resetHref.failure;
  const expiresAt = validatedInstant(input.linkExpiresAt, "link expiry time");
  if ("failure" in expiresAt) return expiresAt.failure;
  return renderThroughLayout({
    kind: "operator_password_reset",
    toEmail: input.toEmail,
    subject: "Reset your PackScout admin password",
    heading: "Reset your admin password",
    blocks: [
      paragraphBlock(
        "A password reset was requested for the PackScout admin account that uses this address.",
      ),
      linkActionBlock("Reset your password", resetHref.value),
      paragraphBlock(
        `This link works once and expires ${expiresAt.value}. Requesting a new reset replaces it.`,
      ),
      paragraphBlock(
        "If you did not request this reset, no action is needed: your password is unchanged, and the link expires on its own.",
      ),
    ],
  });
}

/**
 * The operator invitation: who invited them, what the PackScout admin is,
 * and a single-use, time-limited activation link. No password travels in
 * this message or anywhere else.
 */
export function renderOperatorInvitationMessage(
  input: OperatorInvitationMessageInput,
  origins: MessageCatalogueOrigins,
): EmailMessageRenderResult {
  const invitedBy = validatedProse(
    input.invitedByDisplayName,
    EMAIL_MESSAGE_DISPLAY_NAME_MAX_LENGTH,
    "inviter display name",
  );
  if ("failure" in invitedBy) return invitedBy.failure;
  const invitationHref = validatedAdminLink(
    origins.adminOrigin,
    input.invitationLinkPath,
    "invitation link path",
  );
  if ("failure" in invitationHref) return invitationHref.failure;
  const expiresAt = validatedInstant(input.linkExpiresAt, "link expiry time");
  if ("failure" in expiresAt) return expiresAt.failure;
  return renderThroughLayout({
    kind: "operator_invitation",
    toEmail: input.toEmail,
    subject: `${invitedBy.value} invited you to the PackScout admin`,
    heading: `${invitedBy.value} invited you to the PackScout admin`,
    blocks: [
      paragraphBlock(
        `${invitedBy.value} created a PackScout admin operator account for this address. The admin is the operator console where PackScout's data pipeline, catalog, and closed-beta access are run.`,
      ),
      linkActionBlock(
        "Set your password and activate your account",
        invitationHref.value,
      ),
      paragraphBlock(
        `This link works once and expires ${expiresAt.value}. If it expires before you use it, the person who invited you can send a new one.`,
      ),
      paragraphBlock(
        "If you were not expecting this invitation, you can ignore this message; the account stays inactive until the link is used.",
      ),
    ],
  });
}

/**
 * Confirms that an administrator directly provisioned an active operator.
 * The sign-in destination is fixed and credential-free; the initial password
 * is obtained separately through a secure channel chosen by the administrator.
 */
export function renderOperatorAccountCreatedMessage(
  input: OperatorAccountCreatedMessageInput,
  origins: MessageCatalogueOrigins,
): EmailMessageRenderResult {
  const validatedInput = validatedOperatorAccountCreatedInput(input);
  if ("failure" in validatedInput) return validatedInput.failure;
  const signInHref = validatedAdminLink(
    origins.adminOrigin,
    "/login",
    "admin sign-in link",
  );
  if ("failure" in signInHref) return signInHref.failure;
  return renderThroughLayout({
    kind: "operator_account_created",
    toEmail: validatedInput.value.toEmail,
    subject: "Your PackScout admin account is ready",
    heading: "Your PackScout admin account is ready",
    blocks: [
      paragraphBlock(
        "An administrator created an active PackScout admin operator account for this address. You can sign in now.",
      ),
      paragraphBlock(
        "For security, your initial password is not included in this email. Obtain it from the administrator through a separate secure channel.",
      ),
      linkActionBlock("Sign in to the PackScout admin", signInHref.value),
      paragraphBlock(
        "If you were not expecting this account, contact the PackScout administrator who provided your sign-in details.",
      ),
    ],
  });
}

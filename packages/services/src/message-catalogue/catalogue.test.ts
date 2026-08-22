import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { emailMessageKindSchema } from "@packscout/contracts";
import type { MessageCatalogueOrigins } from "./origins.ts";
import {
  EMAIL_MESSAGE_CONTENT_UNSAFE_ERROR_CODE,
  EMAIL_MESSAGE_INPUT_INVALID_ERROR_CODE,
  EMAIL_MESSAGE_ORIGIN_MISSING_ERROR_CODE,
  type EmailMessageRenderResult,
} from "./rendering.ts";
import {
  CATALOGUE_EMAIL_MESSAGE_KINDS,
  emailMessageCatalogue,
  renderAccessApprovedMessage,
  renderAccessDeclinedMessage,
  renderOperationalAlertMessage,
  renderOperationalAlertRecoveryMessage,
  renderOperatorInvitationMessage,
  renderOperatorPasswordResetMessage,
  renderWelcomeMessage,
  type CatalogueEmailMessageKind,
  type EmailMessageCharacter,
  type OperationalAlertMessageInput,
} from "./catalogue.ts";

const origins: MessageCatalogueOrigins = {
  productOrigin: "https://packscout.io",
  adminOrigin: "https://admin.packscout.io",
};

const alertInput: OperationalAlertMessageInput = {
  toEmail: "operator@example.com",
  severity: "critical",
  title: "Provider imports failing for GameStop",
  summary:
    "Three consecutive import runs failed before any page completed. The provider schedule is paused until the next healthy run.",
  evidenceCodes: ["RUN_TIMEOUT", "PROVIDER_STALE"],
  occurrenceCount: 14,
  firstSeenAt: "2026-08-20T14:03:00.000Z",
  alertId: "5b0c78f2-6ee9-4a4d-9c4b-2f6f4b6f2d11",
};

function renderAll(): Record<CatalogueEmailMessageKind, EmailMessageRenderResult> {
  return {
    operational_alert: renderOperationalAlertMessage(alertInput, origins),
    operational_alert_recovery: renderOperationalAlertRecoveryMessage(
      { ...alertInput, recoveredAt: "2026-08-20T16:41:00.000Z" },
      origins,
    ),
    access_approved: renderAccessApprovedMessage(
      { toEmail: "collector@example.com" },
      origins,
    ),
    access_declined: renderAccessDeclinedMessage(
      { toEmail: "collector@example.com" },
      origins,
    ),
    welcome: renderWelcomeMessage({ toEmail: "collector@example.com" }, origins),
    operator_password_reset: renderOperatorPasswordResetMessage(
      {
        toEmail: "operator@example.com",
        resetLinkPath: "/reset-password?lookup=6f1c&secretPart=opaque-value",
        linkExpiresAt: "2026-08-20T16:03:00.000Z",
      },
      origins,
    ),
    operator_invitation: renderOperatorInvitationMessage(
      {
        toEmail: "new-operator@example.com",
        invitedByDisplayName: "Dana Reyes",
        invitationLinkPath:
          "/invitations/accept?lookup=9a2d&secretPart=opaque-value",
        linkExpiresAt: "2026-08-22T10:00:00.000Z",
      },
      origins,
    ),
  };
}

function renderedOrThrow(result: EmailMessageRenderResult) {
  assert.ok(
    result.status === "rendered",
    `expected a rendered message, got ${JSON.stringify(result)}`,
  );
  return result.message;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function unescapeHtmlEntities(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

function urlsInText(textBody: string): Set<string> {
  return new Set(textBody.match(/https?:\/\/[^\s]+/g) ?? []);
}

function hrefsInHtml(htmlBody: string): Set<string> {
  const hrefs = new Set<string>();
  for (const match of htmlBody.matchAll(/href="([^"]*)"/g)) {
    hrefs.add(unescapeHtmlEntities(match[1] ?? ""));
  }
  return hrefs;
}

const OPERATOR_ALERT_REASON =
  "You are receiving it because this address is configured to receive PackScout operational alerts.";
const ACCESS_REASON =
  "You are receiving it because this address asked for access to the PackScout closed beta.";
const WELCOME_REASON =
  "You are receiving this one-time message because this address signed in to the PackScout closed beta.";
const RESET_REASON =
  "You are receiving it because a password reset was requested for the PackScout admin account at this address.";
const INVITATION_REASON =
  "You are receiving it because an administrator invited this address to operate the PackScout admin.";

function footer(reason: string): string {
  return [
    "-- ",
    "PackScout — closed-beta market intelligence for collectible repacks.",
    reason,
    "This is a transactional service message; PackScout does not send marketing email.",
  ].join("\n");
}

test("the catalogue registry declares every kind transactional with a stable id", () => {
  assert.deepEqual(
    Object.keys(emailMessageCatalogue).sort(),
    [...CATALOGUE_EMAIL_MESSAGE_KINDS].sort(),
  );
  for (const kind of CATALOGUE_EMAIL_MESSAGE_KINDS) {
    const definition = emailMessageCatalogue[kind];
    assert.equal(definition.kind, kind);
    assert.equal(emailMessageKindSchema.safeParse(kind).success, true);
    assert.equal(definition.character.transactional, true);
    assert.ok(definition.reasonForReceiving.length > 0);
  }
  assert.deepEqual(
    Object.fromEntries(
      CATALOGUE_EMAIL_MESSAGE_KINDS.map((kind) => [
        kind,
        emailMessageCatalogue[kind].audience,
      ]),
    ),
    {
      operational_alert: "operator",
      operational_alert_recovery: "operator",
      access_approved: "product_user",
      access_declined: "product_user",
      welcome: "product_user",
      operator_password_reset: "operator",
      operator_invitation: "operator",
    },
  );
});

test("a promotional kind cannot be declared without an unsubscribe path", () => {
  const characters: EmailMessageCharacter[] = [
    { transactional: true },
    // @ts-expect-error — the promotional branch requires an unsubscribe path,
    // and no unsubscribe-path type exists until a preference centre does.
    { transactional: false, unsubscribePath: "/unsubscribe" },
  ];
  assert.equal(characters.length, 2);
});

test("operational alert renders its stable snapshot", () => {
  const message = renderedOrThrow(renderAll().operational_alert);
  assert.equal(message.kind, "operational_alert");
  assert.equal(message.toEmail, "operator@example.com");
  assert.equal(
    message.subject,
    "PackScout alert (critical): Provider imports failing for GameStop",
  );
  assert.equal(
    message.textBody,
    [
      "Critical alert\nProvider imports failing for GameStop",
      "Severity: Critical\nFirst seen: 20 Aug 2026, 14:03 UTC\nOccurrences: 14\nEvidence codes: RUN_TIMEOUT, PROVIDER_STALE",
      "Three consecutive import runs failed before any page completed. The provider schedule is paused until the next healthy run.",
      "Review this alert in the admin:\nhttps://admin.packscout.io/alerts/5b0c78f2-6ee9-4a4d-9c4b-2f6f4b6f2d11",
      footer(OPERATOR_ALERT_REASON),
    ].join("\n\n"),
  );
  assert.equal(
    sha256(message.htmlBody),
    "5bdba337313f699436ac49814e4b0169f20049193016ece0dc4d12ef71eb0284",
  );
});

test("operational alert recovery renders its stable snapshot", () => {
  const message = renderedOrThrow(renderAll().operational_alert_recovery);
  assert.equal(message.kind, "operational_alert_recovery");
  assert.equal(
    message.subject,
    "PackScout alert recovered: Provider imports failing for GameStop",
  );
  assert.equal(
    message.textBody,
    [
      "Recovered\nProvider imports failing for GameStop",
      "This alert has recovered. No further action is needed.",
      "Severity: Critical\nFirst seen: 20 Aug 2026, 14:03 UTC\nRecovered: 20 Aug 2026, 16:41 UTC\nOccurrences while active: 14",
      "Three consecutive import runs failed before any page completed. The provider schedule is paused until the next healthy run.",
      "Review the alert history in the admin:\nhttps://admin.packscout.io/alerts/5b0c78f2-6ee9-4a4d-9c4b-2f6f4b6f2d11",
      footer(OPERATOR_ALERT_REASON),
    ].join("\n\n"),
  );
  assert.equal(
    sha256(message.htmlBody),
    "21356b8e96384f555488f5a06545e03e634bc9b86e19e880763dda2d84066e40",
  );
});

test("access approved renders its stable snapshot", () => {
  const message = renderedOrThrow(renderAll().access_approved);
  assert.equal(message.kind, "access_approved");
  assert.equal(message.toEmail, "collector@example.com");
  assert.equal(message.subject, "Your PackScout beta access is approved");
  assert.equal(
    message.textBody,
    [
      "You're in",
      "An administrator approved your access to the PackScout closed beta. Your account is ready now.",
      "Sign in the same way you first signed up — no new password, code, or invitation is needed.",
      "Open PackScout:\nhttps://packscout.io/",
      footer(ACCESS_REASON),
    ].join("\n\n"),
  );
  assert.equal(
    sha256(message.htmlBody),
    "f9d36ec3081b61fb5769e6de77fb6631f2dc0b35577d2afd20a3af00d1b91eac",
  );
});

test("access declined renders its stable, link-free snapshot", () => {
  const message = renderedOrThrow(renderAll().access_declined);
  assert.equal(message.kind, "access_declined");
  assert.equal(message.subject, "An update on your PackScout beta access");
  assert.equal(
    message.textBody,
    [
      "About your beta access request",
      "Thank you for your interest in PackScout. After review, closed-beta access is not available for your account at this time.",
      "The beta is deliberately small while the product takes shape. No action is needed on your part.",
      footer(ACCESS_REASON),
    ].join("\n\n"),
  );
  assert.equal(
    sha256(message.htmlBody),
    "c01d2aac8ac69d448d5bd4eba245b484e7fbfa1881bd579f8f7324d53719e982",
  );
  assert.equal(urlsInText(message.textBody).size, 0);
  assert.equal(hrefsInHtml(message.htmlBody).size, 0);
});

test("welcome renders its stable snapshot", () => {
  const message = renderedOrThrow(renderAll().welcome);
  assert.equal(message.kind, "welcome");
  assert.equal(message.subject, "Welcome to PackScout");
  assert.equal(
    message.textBody,
    [
      "Welcome to PackScout",
      "You're in the closed beta. PackScout tracks collectible repacks across marketplaces and estimates the value inside each one, so you can compare packs before you buy.",
      "Where to start:",
      "- Dashboard — live repacks ranked by estimated value:\n  https://packscout.io/\n- All repacks — every pack PackScout tracks, with filters:\n  https://packscout.io/packs\n- Learn — how estimated value is calculated and what the confidence labels mean:\n  https://packscout.io/learn",
      "A note on the numbers: estimates are decision support built from live listing and sales data, not a promise of what any single pack contains.",
      "PackScout is a closed beta: coverage grows week by week, and you may find rough edges.",
      footer(WELCOME_REASON),
    ].join("\n\n"),
  );
  assert.equal(
    sha256(message.htmlBody),
    "372018b8a12cb180262bb8222c822849e3fb3f76ea11268fc9b02c376abb83c1",
  );
});

test("operator password reset renders its stable snapshot", () => {
  const message = renderedOrThrow(renderAll().operator_password_reset);
  assert.equal(message.kind, "operator_password_reset");
  assert.equal(message.subject, "Reset your PackScout admin password");
  assert.equal(
    message.textBody,
    [
      "Reset your admin password",
      "A password reset was requested for the PackScout admin account that uses this address.",
      "Reset your password:\nhttps://admin.packscout.io/reset-password?lookup=6f1c&secretPart=opaque-value",
      "This link works once and expires 20 Aug 2026, 16:03 UTC. Requesting a new reset replaces it.",
      "If you did not request this reset, no action is needed: your password is unchanged, and the link expires on its own.",
      footer(RESET_REASON),
    ].join("\n\n"),
  );
  assert.equal(
    sha256(message.htmlBody),
    "d8c1152d1911f3ccf4ba6e4d4973231359210795f876dd3daa3d5300504a3943",
  );
});

test("operator invitation renders its stable snapshot", () => {
  const message = renderedOrThrow(renderAll().operator_invitation);
  assert.equal(message.kind, "operator_invitation");
  assert.equal(message.toEmail, "new-operator@example.com");
  assert.equal(
    message.subject,
    "Dana Reyes invited you to the PackScout admin",
  );
  assert.equal(
    message.textBody,
    [
      "Dana Reyes invited you to the PackScout admin",
      "Dana Reyes created a PackScout admin operator account for this address. The admin is the operator console where PackScout's data pipeline, catalog, and closed-beta access are run.",
      "Set your password and activate your account:\nhttps://admin.packscout.io/invitations/accept?lookup=9a2d&secretPart=opaque-value",
      "This link works once and expires 22 Aug 2026, 10:00 UTC. If it expires before you use it, the person who invited you can send a new one.",
      "If you were not expecting this invitation, you can ignore this message; the account stays inactive until the link is used.",
      footer(INVITATION_REASON),
    ].join("\n\n"),
  );
  assert.equal(
    sha256(message.htmlBody),
    "d66ad366fa70d4ea5e91881cb93c65a0ba79244d5c7c19ee836c3ad1f3fa8159",
  );
});

test("every kind renders identical output for identical input", () => {
  assert.deepEqual(renderAll(), renderAll());
});

test("rendering never consults the clock or randomness", () => {
  const originalNow = Date.now;
  const originalRandom = Math.random;
  Date.now = () => {
    throw new Error("rendering consulted the clock");
  };
  Math.random = () => {
    throw new Error("rendering consulted randomness");
  };
  try {
    for (const [kind, result] of Object.entries(renderAll())) {
      assert.equal(result.status, "rendered", `expected ${kind} to render`);
    }
  } finally {
    Date.now = originalNow;
    Math.random = originalRandom;
  }
});

test("plain-text and HTML bodies carry the same links and facts", () => {
  for (const [kind, result] of Object.entries(renderAll())) {
    const message = renderedOrThrow(result);
    assert.deepEqual(
      hrefsInHtml(message.htmlBody),
      urlsInText(message.textBody),
      `expected identical links in both bodies of ${kind}`,
    );
    const html = unescapeHtmlEntities(message.htmlBody);
    assert.ok(
      html.includes(
        "PackScout — closed-beta market intelligence for collectible repacks.",
      ),
      `expected the sender identity in the HTML body of ${kind}`,
    );
    assert.ok(
      html.includes(emailMessageCatalogue[message.kind as CatalogueEmailMessageKind].reasonForReceiving),
      `expected the receiving reason in the HTML body of ${kind}`,
    );
  }
  const alert = renderedOrThrow(renderAll().operational_alert);
  for (const fact of [
    "Provider imports failing for GameStop",
    "20 Aug 2026, 14:03 UTC",
    "14",
    "RUN_TIMEOUT, PROVIDER_STALE",
  ]) {
    assert.ok(alert.textBody.includes(fact));
    assert.ok(unescapeHtmlEntities(alert.htmlBody).includes(fact));
  }
});

test("interpolated values cannot inject markup", () => {
  const result = renderOperationalAlertMessage(
    {
      ...alertInput,
      title: `Import <run> failed & "quoted" it's stuck`,
      summary: "A provider replied with <img src=x onerror=broken> markup.",
    },
    origins,
  );
  const message = renderedOrThrow(result);
  assert.ok(!message.htmlBody.includes("<run>"));
  assert.ok(!message.htmlBody.includes("<img"));
  assert.ok(message.htmlBody.includes("&lt;run&gt;"));
  assert.ok(message.htmlBody.includes("&lt;img src=x onerror=broken&gt;"));
  assert.ok(message.htmlBody.includes("&quot;quoted&quot;"));
  assert.ok(message.htmlBody.includes("it&#39;s stuck"));
  assert.ok(message.htmlBody.includes("&amp;"));
  assert.ok(message.textBody.includes(`Import <run> failed & "quoted" it's stuck`));

  const invitation = renderOperatorInvitationMessage(
    {
      toEmail: "new-operator@example.com",
      invitedByDisplayName: "<b>Mallory & Sons</b>",
      invitationLinkPath: "/invitations/accept?lookup=9a2d",
      linkExpiresAt: "2026-08-22T10:00:00.000Z",
    },
    origins,
  );
  const invitationMessage = renderedOrThrow(invitation);
  assert.ok(!invitationMessage.htmlBody.includes("<b>"));
  assert.ok(invitationMessage.htmlBody.includes("&lt;b&gt;Mallory &amp; Sons&lt;/b&gt;"));
});

test("credential-shaped interpolated content fails rendering", () => {
  const cases: ReadonlyArray<EmailMessageRenderResult> = [
    renderOperationalAlertMessage(
      { ...alertInput, title: "Authorization: Bearer abc123 rejected" },
      origins,
    ),
    renderOperationalAlertMessage(
      { ...alertInput, summary: "Provider refused key 0xdeadbeefdeadbeef." },
      origins,
    ),
    renderOperationalAlertMessage(
      { ...alertInput, summary: "The provider password was rejected." },
      origins,
    ),
    renderOperatorInvitationMessage(
      {
        toEmail: "new-operator@example.com",
        invitedByDisplayName: "eyJhbGciOiJIUzI1NiJ9",
        invitationLinkPath: "/invitations/accept?lookup=9a2d",
        linkExpiresAt: "2026-08-22T10:00:00.000Z",
      },
      origins,
    ),
  ];
  for (const result of cases) {
    assert.ok(result.status === "failed");
    assert.equal(result.errorCode, EMAIL_MESSAGE_CONTENT_UNSAFE_ERROR_CODE);
    assert.ok(!("message" in result), "a failure must carry no partial message");
  }
});

test("a one-time link path passes through opaque and uninspected", () => {
  const result = renderOperatorPasswordResetMessage(
    {
      toEmail: "operator@example.com",
      resetLinkPath: `/reset-password?token=${"A1b2C3d4".repeat(8)}`,
      linkExpiresAt: "2026-08-20T16:03:00.000Z",
    },
    origins,
  );
  const message = renderedOrThrow(result);
  const expected = `https://admin.packscout.io/reset-password?token=${"A1b2C3d4".repeat(8)}`;
  assert.ok(message.textBody.includes(expected));
  assert.ok(hrefsInHtml(message.htmlBody).has(expected));
});

test("a missing public origin reports an explicit failure, not a broken link", () => {
  const noAdmin: MessageCatalogueOrigins = {
    productOrigin: "https://packscout.io",
    adminOrigin: null,
  };
  const noProduct: MessageCatalogueOrigins = {
    productOrigin: null,
    adminOrigin: "https://admin.packscout.io",
  };
  const none: MessageCatalogueOrigins = { productOrigin: null, adminOrigin: null };
  const failures: ReadonlyArray<EmailMessageRenderResult> = [
    renderOperationalAlertMessage(alertInput, noAdmin),
    renderOperationalAlertRecoveryMessage(
      { ...alertInput, recoveredAt: "2026-08-20T16:41:00.000Z" },
      noAdmin,
    ),
    renderAccessApprovedMessage({ toEmail: "collector@example.com" }, noProduct),
    renderWelcomeMessage({ toEmail: "collector@example.com" }, noProduct),
    renderOperatorPasswordResetMessage(
      {
        toEmail: "operator@example.com",
        resetLinkPath: "/reset-password?lookup=6f1c",
        linkExpiresAt: "2026-08-20T16:03:00.000Z",
      },
      noAdmin,
    ),
    renderOperatorInvitationMessage(
      {
        toEmail: "new-operator@example.com",
        invitedByDisplayName: "Dana Reyes",
        invitationLinkPath: "/invitations/accept?lookup=9a2d",
        linkExpiresAt: "2026-08-22T10:00:00.000Z",
      },
      noAdmin,
    ),
  ];
  for (const result of failures) {
    assert.ok(result.status === "failed");
    assert.equal(result.errorCode, EMAIL_MESSAGE_ORIGIN_MISSING_ERROR_CODE);
  }
  const declined = renderAccessDeclinedMessage(
    { toEmail: "collector@example.com" },
    none,
  );
  assert.equal(declined.status, "rendered");
});

test("invalid or missing input values report explicit failures", () => {
  const invalidAlerts: ReadonlyArray<EmailMessageRenderResult> = [
    renderOperationalAlertMessage(
      { ...alertInput, severity: "urgent" as OperationalAlertMessageInput["severity"] },
      origins,
    ),
    renderOperationalAlertMessage({ ...alertInput, title: "   " }, origins),
    renderOperationalAlertMessage({ ...alertInput, occurrenceCount: 0 }, origins),
    renderOperationalAlertMessage({ ...alertInput, occurrenceCount: 1.5 }, origins),
    renderOperationalAlertMessage(
      { ...alertInput, evidenceCodes: ["lower_case"] },
      origins,
    ),
    renderOperationalAlertMessage(
      { ...alertInput, evidenceCodes: Array.from({ length: 9 }, () => "CODE") },
      origins,
    ),
    renderOperationalAlertMessage({ ...alertInput, alertId: "not-a-uuid" }, origins),
    renderOperationalAlertMessage(
      { ...alertInput, firstSeenAt: "yesterdayish" },
      origins,
    ),
    renderOperationalAlertMessage({ ...alertInput, toEmail: "nope" }, origins),
    renderOperatorPasswordResetMessage(
      {
        toEmail: "operator@example.com",
        resetLinkPath: "https://evil.example/reset",
        linkExpiresAt: "2026-08-20T16:03:00.000Z",
      },
      origins,
    ),
    renderOperatorPasswordResetMessage(
      {
        toEmail: "operator@example.com",
        resetLinkPath: "/reset-password?lookup=6f1c",
        linkExpiresAt: "whenever",
      },
      origins,
    ),
    renderOperatorInvitationMessage(
      {
        toEmail: "new-operator@example.com",
        invitedByDisplayName: "",
        invitationLinkPath: "/invitations/accept?lookup=9a2d",
        linkExpiresAt: "2026-08-22T10:00:00.000Z",
      },
      origins,
    ),
  ];
  for (const result of invalidAlerts) {
    assert.ok(result.status === "failed");
    assert.equal(result.errorCode, EMAIL_MESSAGE_INPUT_INVALID_ERROR_CODE);
  }
});

test("HTML bodies are self-contained and read with images blocked", () => {
  const allowedOrigins = ["https://packscout.io", "https://admin.packscout.io"];
  for (const [kind, result] of Object.entries(renderAll())) {
    const message = renderedOrThrow(result);
    for (const forbidden of ["<img", "<script", "<link", "@import", "@font-face", "url("]) {
      assert.ok(
        !message.htmlBody.toLowerCase().includes(forbidden),
        `expected no ${JSON.stringify(forbidden)} in the HTML body of ${kind}`,
      );
    }
    for (const body of [message.htmlBody, message.textBody]) {
      for (const match of body.match(/https?:[^"\s<]*/g) ?? []) {
        const url = unescapeHtmlEntities(match);
        assert.ok(
          allowedOrigins.some((allowed) => url.startsWith(allowed)),
          `expected only configured-origin links in ${kind}, saw ${url}`,
        );
      }
    }
    assert.ok(
      !/<[a-z!/]/i.test(message.textBody),
      `expected a markup-free plain-text body for ${kind}`,
    );
  }
});

test("maximal safe inputs stay within the delivery subject bound", () => {
  const longTitle = `${"abcdefghi ".repeat(15)}abcdefghij`;
  const alert = renderedOrThrow(
    renderOperationalAlertMessage({ ...alertInput, title: longTitle }, origins),
  );
  assert.ok(alert.subject.endsWith(longTitle));
  assert.ok(alert.subject.length <= 200);

  const longName = `${"ab ".repeat(39)}abc`;
  const invitation = renderedOrThrow(
    renderOperatorInvitationMessage(
      {
        toEmail: "new-operator@example.com",
        invitedByDisplayName: longName,
        invitationLinkPath: "/invitations/accept?lookup=9a2d",
        linkExpiresAt: "2026-08-22T10:00:00.000Z",
      },
      origins,
    ),
  );
  assert.ok(invitation.subject.startsWith(longName));
  assert.ok(invitation.subject.length <= 200);
});

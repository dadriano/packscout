import { Router, type RequestHandler, type Response } from "express";
import {
  BETA_ALLOWLIST_MAX_CURSOR_LENGTH,
  BETA_ALLOWLIST_MAX_EMAIL_LENGTH,
  BETA_ALLOWLIST_MAX_ENTRY_ID_LENGTH,
  BETA_ALLOWLIST_MAX_LABEL_LENGTH,
  BETA_ALLOWLIST_MAX_OPERATOR_ID_LENGTH,
  BETA_ALLOWLIST_MAX_OPERATOR_NAME_LENGTH,
  BETA_ALLOWLIST_MAX_WALLET_ADDRESS_LENGTH,
  createBetaAllowlistEntryRequestSchema,
  listBetaAllowlistRequestSchema,
  removeBetaAllowlistEntryRequestSchema,
  updateBetaAllowlistEntryRequestSchema,
  type BetaAllowlistEntry,
  type BetaAllowlistEntryChange,
  type BetaAllowlistRemoval,
  type BetaAllowlistRow,
} from "@packscout/contracts";
import type { AuthService, AuthenticatedActor } from "@packscout/services";
import type { SessionCookiePolicy } from "../auth/cookies.ts";
import { createRequireSession, getAuthenticatedActor } from "../auth/middleware.ts";
import {
  type BetaAllowlistAuditAction,
  type BetaAllowlistAuditOutcome,
  type BetaAllowlistAuditSink,
} from "../beta-allowlist-audit.ts";
import {
  BetaAllowlistDirectoryError,
  type BetaAllowlistDirectoryClient,
} from "../beta-allowlist-directory.ts";

/**
 * The admin's beta-allowlist surface.
 *
 * The browser talks only to this route; the server-to-server integration and
 * its credential stay behind it. Reads are guarded by `beta_allowlist:view`
 * and every change by `beta_allowlist:manage`, both of which only
 * administrators hold, and every listing is bounded and paginated.
 *
 * Every operation is a POST because allowlist identifiers are personal data:
 * carrying them in request bodies keeps them out of URLs, browser history,
 * referrers, and access logs. Reads perform no mutation, so the same-origin
 * guard — not a CSRF token — is what keeps them same-site; the three writes
 * are state changes and additionally require the token.
 *
 * Removal here deletes only a list entry, never a person: it stops future
 * automatic admission and changes no existing access decision.
 */

/**
 * A recording that did not happen. The allowlist change itself may already
 * have committed, so this can never alter what the browser is told; it names
 * the gap in the trail with non-personal values so an operator can find it.
 */
export interface BetaAllowlistAuditFailure {
  readonly action: BetaAllowlistAuditAction;
  readonly outcome: BetaAllowlistAuditOutcome;
  /** True when the allowlist change had already committed upstream. */
  readonly afterCommit: boolean;
}

export interface BetaAllowlistRouterDependencies {
  readonly auth: Pick<
    AuthService,
    "resolveSession" | "requirePermission" | "listOperators"
  >;
  readonly directory: BetaAllowlistDirectoryClient;
  readonly audit: BetaAllowlistAuditSink;
  readonly cookiePolicy: SessionCookiePolicy;
  readonly sameOrigin: RequestHandler;
  /** Where an unwritable audit record is reported. Defaults to the error log. */
  readonly onAuditFailure?: (failure: BetaAllowlistAuditFailure) => void;
}

function bounded(value: string, maximum: number): string {
  return value.slice(0, maximum);
}

function boundedOrNull(value: string | null, maximum: number): string | null {
  return value === null ? null : bounded(value, maximum);
}

/**
 * Explicit field-by-field projection. Nothing the browser has no business
 * seeing can ride along, whatever the upstream entry happens to carry.
 */
function sanitizeEntry(entry: BetaAllowlistEntry): BetaAllowlistEntry {
  return {
    entryId: bounded(entry.entryId, BETA_ALLOWLIST_MAX_ENTRY_ID_LENGTH),
    email: boundedOrNull(entry.email, BETA_ALLOWLIST_MAX_EMAIL_LENGTH),
    walletAddress: boundedOrNull(
      entry.walletAddress,
      BETA_ALLOWLIST_MAX_WALLET_ADDRESS_LENGTH,
    ),
    label: boundedOrNull(entry.label, BETA_ALLOWLIST_MAX_LABEL_LENGTH),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    createdByOperatorId: bounded(
      entry.createdByOperatorId,
      BETA_ALLOWLIST_MAX_OPERATOR_ID_LENGTH,
    ),
  };
}

function invalid(response: Response, details: unknown): void {
  response.status(422).json({
    error: "Check the allowlist request and try again.",
    code: "INVALID_BETA_ALLOWLIST_REQUEST",
    details,
  });
}

/**
 * Every failure resolves to one of the allowlist's stable codes. No upstream
 * status text, body, or exception detail is ever restated to the browser.
 */
function failure(response: Response, error: unknown): void {
  if (error instanceof BetaAllowlistDirectoryError) {
    response.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  response.status(503).json({
    error: "The beta allowlist is temporarily unavailable.",
    code: "BETA_ALLOWLIST_UNAVAILABLE",
  });
}

/**
 * A short, non-personal description of why an attempt did not succeed. It is
 * the allowlist's own stable code, never an upstream message.
 */
function failureReason(error: unknown): string {
  return error instanceof BetaAllowlistDirectoryError
    ? error.code
    : "BETA_ALLOWLIST_UNAVAILABLE";
}

/**
 * The default report for an audit write that failed: one bounded line naming
 * the action and where it failed, and nothing about the person it concerned.
 */
function logAuditFailure(failure: BetaAllowlistAuditFailure): void {
  console.error(
    JSON.stringify({
      level: "error",
      event: "beta_allowlist_audit_write_failed",
      action: failure.action,
      outcome: failure.outcome,
      afterCommit: failure.afterCommit,
    }),
  );
}

export function createBetaAllowlistRouter(
  dependencies: BetaAllowlistRouterDependencies,
) {
  const router = Router();
  const reportAuditFailure = dependencies.onAuditFailure ?? logAuditFailure;
  const read = createRequireSession(dependencies.auth, dependencies.cookiePolicy, {
    permission: "beta_allowlist:view",
  });
  const manage = createRequireSession(
    dependencies.auth,
    dependencies.cookiePolicy,
    { csrf: true, permission: "beta_allowlist:manage" },
  );

  /**
   * The display names behind a page's `createdByOperatorId` references, read
   * from the admin's own operator directory. Best effort by design: the
   * ledger must stay usable when the lookup fails or an operator record is
   * gone, so any gap resolves to a null name, never a failed listing.
   */
  async function creatorNames(
    actor: AuthenticatedActor,
    entries: readonly BetaAllowlistEntry[],
  ): Promise<ReadonlyMap<string, string>> {
    if (entries.length === 0) return new Map();
    try {
      const { items } = await dependencies.auth.listOperators(actor, {
        limit: 100,
      });
      return new Map(items.map((operator) => [operator.id, operator.displayName]));
    } catch {
      return new Map();
    }
  }

  function toRow(
    entry: BetaAllowlistEntry,
    names: ReadonlyMap<string, string>,
  ): BetaAllowlistRow {
    const displayName = names.get(entry.createdByOperatorId);
    return {
      ...sanitizeEntry(entry),
      createdByDisplayName:
        displayName === undefined
          ? null
          : bounded(displayName, BETA_ALLOWLIST_MAX_OPERATOR_NAME_LENGTH),
    };
  }

  /**
   * Records one attempt on the trail without letting the recording decide the
   * outcome: a change that committed upstream is reported to the browser as
   * committed whatever the trail manages to write.
   */
  async function record(
    action: BetaAllowlistAuditAction,
    actor: AuthenticatedActor,
    target: {
      entryId: string | null;
      email: string | null;
      walletAddress: string | null;
    },
    outcome: BetaAllowlistAuditOutcome,
    detail: { admittedCount?: number; removed?: boolean; reason?: string },
    afterCommit: boolean,
  ): Promise<void> {
    try {
      await dependencies.audit.append({
        organizationId: actor.organizationId,
        actorId: actor.operatorId,
        action,
        entryId: target.entryId,
        email: target.email,
        walletAddress: target.walletAddress,
        outcome,
        occurredAt: new Date(),
        ...detail,
      });
    } catch {
      try {
        reportAuditFailure({ action, outcome, afterCommit });
      } catch {
        // Reporting the gap must not become a third failure domain.
      }
    }
  }

  router.post("/list", dependencies.sameOrigin, read, async (request, response) => {
    const body = listBetaAllowlistRequestSchema.safeParse(request.body ?? {});
    if (!body.success) return invalid(response, body.error.flatten().fieldErrors);
    try {
      const page = await dependencies.directory.listEntries({
        ...(body.data.search === undefined ? {} : { search: body.data.search }),
        ...(body.data.cursor === undefined ? {} : { cursor: body.data.cursor }),
        limit: body.data.limit,
      });
      const names = await creatorNames(getAuthenticatedActor(response), page.items);
      // Personal data must not be stored by any intermediary or the browser.
      response.setHeader("Cache-Control", "no-store");
      response.status(200).json({
        items: page.items
          .slice(0, body.data.limit)
          .map((entry) => toRow(entry, names)),
        nextCursor:
          page.nextCursor === null
            ? null
            : bounded(page.nextCursor, BETA_ALLOWLIST_MAX_CURSOR_LENGTH),
        searchTruncated: page.searchTruncated,
      });
    } catch (error) {
      failure(response, error);
    }
  });

  /**
   * Adds an entry. The acting operator is taken from the session — no request
   * shape can name one — and the response restates how many waiting accounts
   * the entry admitted, so the operator sees the effect rather than guessing.
   */
  router.post("/create", dependencies.sameOrigin, manage, async (request, response) => {
    const body = createBetaAllowlistEntryRequestSchema.safeParse(request.body ?? {});
    if (!body.success) return invalid(response, body.error.flatten().fieldErrors);
    const actor = getAuthenticatedActor(response);
    const target = {
      entryId: null,
      email: body.data.email ?? null,
      walletAddress: body.data.walletAddress ?? null,
    };

    let change: BetaAllowlistEntryChange;
    try {
      change = await dependencies.directory.createEntry({
        email: target.email,
        walletAddress: target.walletAddress,
        label: body.data.label ?? null,
        operatorId: actor.operatorId,
      });
    } catch (error) {
      // Nothing committed: this attempt to change who may enter the beta is
      // still recorded before the refusal is reported.
      await record(
        "beta_allowlist.add",
        actor,
        target,
        "failure",
        { reason: failureReason(error) },
        false,
      );
      failure(response, error);
      return;
    }

    await record(
      "beta_allowlist.add",
      actor,
      { ...target, entryId: change.entry.entryId },
      "success",
      { admittedCount: change.admittedCount },
      true,
    );
    // Personal data must not be stored by any intermediary or the browser.
    response.setHeader("Cache-Control", "no-store");
    response.status(200).json({
      entry: sanitizeEntry(change.entry),
      admittedCount: change.admittedCount,
    });
  });

  /**
   * Edits an entry with the same validation and messaging as adding. An
   * omitted field keeps its stored value and an explicit null clears it; a
   * vanished entry refuses as not found rather than claiming an edit.
   */
  router.post("/update", dependencies.sameOrigin, manage, async (request, response) => {
    const body = updateBetaAllowlistEntryRequestSchema.safeParse(request.body ?? {});
    if (!body.success) return invalid(response, body.error.flatten().fieldErrors);
    const actor = getAuthenticatedActor(response);
    const target = {
      entryId: body.data.entryId,
      email: body.data.email ?? null,
      walletAddress: body.data.walletAddress ?? null,
    };

    let change: BetaAllowlistEntryChange;
    try {
      change = await dependencies.directory.updateEntry({
        entryId: body.data.entryId,
        ...(body.data.email === undefined ? {} : { email: body.data.email }),
        ...(body.data.walletAddress === undefined
          ? {}
          : { walletAddress: body.data.walletAddress }),
        ...(body.data.label === undefined ? {} : { label: body.data.label }),
      });
    } catch (error) {
      await record(
        "beta_allowlist.edit",
        actor,
        target,
        "failure",
        { reason: failureReason(error) },
        false,
      );
      failure(response, error);
      return;
    }

    await record(
      "beta_allowlist.edit",
      actor,
      target,
      "success",
      { admittedCount: change.admittedCount },
      true,
    );
    // Personal data must not be stored by any intermediary or the browser.
    response.setHeader("Cache-Control", "no-store");
    response.status(200).json({
      entry: sanitizeEntry(change.entry),
      admittedCount: change.admittedCount,
    });
  });

  /**
   * Removes an entry. Removal stops future automatic admission for the
   * entry's identifiers and changes no existing access decision — revoking a
   * person who is already in is a separate, audited action in the users area.
   * `removed: false` reports an entry that was already gone, so repeated
   * operator actions converge.
   */
  router.post("/remove", dependencies.sameOrigin, manage, async (request, response) => {
    const body = removeBetaAllowlistEntryRequestSchema.safeParse(request.body ?? {});
    if (!body.success) return invalid(response, body.error.flatten().fieldErrors);
    const actor = getAuthenticatedActor(response);
    // The removal request names only the opaque entry id; the identifiers it
    // covered never travel here, so none can be recorded.
    const target = { entryId: body.data.entryId, email: null, walletAddress: null };

    let removal: BetaAllowlistRemoval;
    try {
      removal = await dependencies.directory.removeEntry({
        entryId: body.data.entryId,
      });
    } catch (error) {
      await record(
        "beta_allowlist.remove",
        actor,
        target,
        "failure",
        { reason: failureReason(error) },
        false,
      );
      failure(response, error);
      return;
    }

    await record(
      "beta_allowlist.remove",
      actor,
      target,
      "success",
      { removed: removal.removed },
      true,
    );
    // Personal data must not be stored by any intermediary or the browser.
    response.setHeader("Cache-Control", "no-store");
    response.status(200).json({ removed: removal.removed });
  });

  return router;
}

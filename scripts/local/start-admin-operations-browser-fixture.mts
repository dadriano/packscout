#!/usr/bin/env node

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  diagnosticHistory,
  operationsDetail,
  operationsFixtureIds,
  operationsOverview,
  operationsSession,
  sourceAdminCatalog,
} from "../../apps/admin/src/testing/provider-source-operations-fixture.ts";

const port = Number(process.env.PACKSCOUT_ADMIN_OPERATIONS_FIXTURE_PORT ?? "4174");
const browserOrigin = process.env.PACKSCOUT_ADMIN_OPERATIONS_FIXTURE_ORIGIN ??
  "http://127.0.0.1:5174";
if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
  throw new TypeError("PACKSCOUT_ADMIN_OPERATIONS_FIXTURE_PORT must be a non-reserved TCP port.");
}

type FixtureMode = "admin" | "operator" | "viewer" | "forbidden";
let mode: FixtureMode = "admin";
let manualRequests = 0;
const pauseRequested = new Set<string>();
const intervalSeconds = new Map<string, number>();

function headers(response: ServerResponse): void {
  response.setHeader("Access-Control-Allow-Origin", browserOrigin);
  response.setHeader("Access-Control-Allow-Credentials", "true");
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Accept, Content-Type, X-CSRF-Token",
  );
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Cache-Control", "no-store");
}

function json(response: ServerResponse, status: number, value: unknown): void {
  headers(response);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

async function requestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > 16_384) throw new TypeError("Fixture request body is too large.");
    chunks.push(bytes);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function currentOverview() {
  const overview = operationsOverview();
  return {
    ...overview,
    refreshedAt: new Date().toISOString(),
    sources: overview.sources.map((source) => {
      const requested = pauseRequested.has(source.providerId);
      const revisedInterval = intervalSeconds.get(source.providerId);
      return {
        ...source,
        source: source.source ? { ...source.source, pauseRequested: requested } : null,
        schedule: source.schedule ? {
          ...source.schedule,
          intervalSeconds: revisedInterval ?? source.schedule.intervalSeconds,
        } : null,
      };
    }),
  };
}

function currentDetail(providerId: string) {
  const index = operationsFixtureIds.providers.indexOf(
    providerId as (typeof operationsFixtureIds.providers)[number],
  );
  if (index < 0) return null;
  const detail = operationsDetail(index);
  return {
    ...detail,
    refreshedAt: new Date().toISOString(),
    source: currentOverview().sources[index]!,
  };
}

function session() {
  if (mode === "admin" || mode === "forbidden") return operationsSession("admin");
  const operator = operationsSession("data_operator");
  return mode === "viewer"
    ? { ...operator, permissions: ["providers:view"] as const }
    : operator;
}

function fixtureAudit(action: string) {
  return {
    actor: "current_operator",
    action,
    subjectType: "provider_source",
    subjectId: operationsFixtureIds.sources[0],
    revisionId: operationsFixtureIds.revisions[0],
    outcome: "succeeded",
    safeCode: null,
    occurredAt: new Date().toISOString(),
  };
}

const server = createServer(async (request, response) => {
  try {
    headers(response);
    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.end();
      return;
    }
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    if (request.method === "GET" && url.pathname === "/api/auth/session") {
      json(response, 200, session());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/local-fixture/mode") {
      const body = await requestBody(request) as { mode?: unknown };
      if (!["admin", "operator", "viewer", "forbidden"].includes(String(body.mode))) {
        json(response, 422, { error: "Select a supported local fixture mode.", code: "INVALID_FIXTURE_MODE" });
        return;
      }
      mode = body.mode as FixtureMode;
      json(response, 200, { mode });
      return;
    }
    if (mode === "forbidden" && url.pathname.startsWith("/api/provider-source-operations")) {
      json(response, 403, { error: "Forbidden", code: "FORBIDDEN" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/provider-source-operations") {
      json(response, 200, currentOverview());
      return;
    }
    const diagnosticMatch = url.pathname.match(
      /^\/api\/provider-source-operations\/providers\/([^/]+)\/diagnostics$/u,
    );
    if (request.method === "GET" && diagnosticMatch) {
      const providerId = diagnosticMatch[1]!;
      const index = operationsFixtureIds.providers.indexOf(
        providerId as (typeof operationsFixtureIds.providers)[number],
      );
      if (index < 0) {
        json(response, 404, { error: "Not found", code: "SOURCE_OPERATIONS_NOT_FOUND" });
        return;
      }
      if (url.searchParams.has("cursor")) {
        json(response, 200, {
          ...diagnosticHistory(index),
          snapshot: currentOverview().sources[index],
          refreshedAt: new Date().toISOString(),
          events: [],
          nextCursor: null,
          history: {
            state: "expired",
            message: "Older diagnostic history has expired. Current source state is shown above.",
          },
        });
        return;
      }
      const runId = url.searchParams.get("runId");
      json(response, 200, {
        ...diagnosticHistory(index, {
          severity: url.searchParams.get("severity") as "info" | "warning" | "critical" | null,
          phase: url.searchParams.get("phase"),
          runId,
          contextEventsHidden: runId !== null,
        }),
        snapshot: currentOverview().sources[index],
        refreshedAt: new Date().toISOString(),
      });
      return;
    }
    const detailMatch = url.pathname.match(
      /^\/api\/provider-source-operations\/providers\/([^/]+)$/u,
    );
    if (request.method === "GET" && detailMatch) {
      const detail = currentDetail(detailMatch[1]!);
      json(response, detail ? 200 : 404, detail ?? {
        error: "Not found",
        code: "SOURCE_OPERATIONS_NOT_FOUND",
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/provider-sources") {
      const catalog = sourceAdminCatalog();
      json(response, 200, {
        catalog: {
          ...catalog,
          sources: catalog.sources.map((source) => ({
            ...source,
            pauseRequested: pauseRequested.has(source.providerId),
            intervalSeconds: intervalSeconds.get(source.providerId) ?? source.intervalSeconds,
          })),
        },
      });
      return;
    }
    const manualMatch = url.pathname.match(/^\/api\/data-providers\/([^/]+)\/import-runs$/u);
    if (request.method === "POST" && manualMatch) {
      const providerId = manualMatch[1]!;
      const index = operationsFixtureIds.providers.indexOf(
        providerId as (typeof operationsFixtureIds.providers)[number],
      );
      if (index < 0) {
        json(response, 404, { error: "Not found", code: "PROVIDER_NOT_FOUND" });
        return;
      }
      manualRequests += 1;
      const coalesced = manualRequests > 1;
      json(response, coalesced ? 200 : 202, {
        run: {
          id: operationsFixtureIds.runs[index],
          providerId,
          configurationRevisionId: operationsFixtureIds.revisions[index],
          trigger: "manual",
          state: coalesced ? "running" : "queued",
        },
        deduplicated: coalesced,
        outcome: coalesced ? "coalesced" : "queued",
      });
      return;
    }
    const sourceCommand = url.pathname.match(
      /^\/api\/provider-sources\/providers\/([^/]+)\/sources\/([^/]+)\/(pause|resume|test|interval|cursor-reset-preview)$/u,
    );
    if (request.method === "POST" && sourceCommand) {
      const providerId = sourceCommand[1]!;
      const action = sourceCommand[3]!;
      const index = operationsFixtureIds.providers.indexOf(
        providerId as (typeof operationsFixtureIds.providers)[number],
      );
      if (index < 0) {
        json(response, 404, { error: "Not found", code: "SOURCE_NOT_FOUND" });
        return;
      }
      if (action === "pause") {
        pauseRequested.add(providerId);
        json(response, 200, { state: "pause_requested", audit: fixtureAudit("source_pause_requested") });
        return;
      }
      if (action === "resume") {
        pauseRequested.delete(providerId);
        json(response, 200, { state: "resumed", audit: fixtureAudit("source_resumed") });
        return;
      }
      if (action === "test") {
        json(response, 200, {
          state: "pending",
          jobId: operationsFixtureIds.revisions[index],
          audit: fixtureAudit("source_test_requested"),
        });
        return;
      }
      if (action === "interval") {
        const body = await requestBody(request) as { intervalSeconds?: unknown };
        const next = Number(body.intervalSeconds);
        if (!Number.isInteger(next) || next < 60 || next > 86_400) {
          json(response, 422, { error: "Invalid interval", code: "INVALID_SOURCE_CONFIGURATION" });
          return;
        }
        intervalSeconds.set(providerId, next);
        json(response, 200, {
          scheduleRevisionId: operationsFixtureIds.schedules[index],
          audit: fixtureAudit("source_interval_revised"),
        });
        return;
      }
      const source = sourceAdminCatalog().sources[index]!;
      json(response, 200, {
        preview: {
          providerId,
          provider: source.provider,
          sourceInstanceId: source.sourceInstanceId,
          sourceRevisionId: source.sourceRevisionId,
          sourceState: source.state,
          cursorGeneration: source.cursor.generation,
          cursorFingerprint: source.cursor.fingerprint,
          confirmation: `RESET ${source.provider} TO FEED START`,
          consequence: "The saved cursor will be cleared and the next resume will start from Feed start.",
        },
      });
      return;
    }
    json(response, 404, { error: "Local fixture route not found.", code: "FIXTURE_NOT_FOUND" });
  } catch {
    json(response, 500, { error: "Local fixture failed safely.", code: "FIXTURE_FAILURE" });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`PackScout operations fixture API is available at http://127.0.0.1:${port}/api`);
});

function shutdown(): void {
  server.close((error) => {
    if (error) process.exitCode = 1;
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

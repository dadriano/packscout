import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyPanelRequest,
  evaluatePanelAccess,
  normalizeRequestPath,
  outcomeForStatus,
  PANEL_REQUEST_HEADER_VALUE,
  type PanelRequestDescriptor,
} from "./access.ts";

const loopbackHost = "127.0.0.1:5110";

function request(
  overrides: Partial<PanelRequestDescriptor> = {},
): PanelRequestDescriptor {
  return {
    method: "GET",
    path: "/api/logs/sources",
    host: loopbackHost,
    ...overrides,
  };
}

test("request paths normalize before classification", () => {
  assert.equal(normalizeRequestPath("/api/logs/sources?tail=1"), "/api/logs/sources");
  assert.equal(normalizeRequestPath("/api/logs/sources/"), "/api/logs/sources");
  assert.equal(normalizeRequestPath("/API/Logs"), "/api/logs");
  assert.equal(normalizeRequestPath("/"), "/");
});

test("guard membership matches the contract later tasks build on", () => {
  const sourcesRead = classifyPanelRequest({
    method: "GET",
    path: "/api/logs/sources",
  });
  assert.equal(sourcesRead.sensitiveRead, true);
  assert.equal(sourcesRead.privileged, false);

  const databaseStatus = classifyPanelRequest({
    method: "GET",
    path: "/api/database/status",
  });
  assert.equal(databaseStatus.sensitiveRead, true);
  assert.equal(databaseStatus.privileged, false);

  const download = classifyPanelRequest({
    method: "GET",
    path: "/api/logs/download/worker",
  });
  assert.equal(download.sensitiveRead, true);
  assert.equal(download.privileged, true);

  const migration = classifyPanelRequest({
    method: "POST",
    path: "/api/database/migrate",
  });
  assert.equal(migration.privileged, true);
  assert.equal(migration.action, "POST /api/database/migrate");

  const stream = classifyPanelRequest({
    method: "GET",
    path: "/api/logs/sources/stream",
  });
  assert.equal(stream.eventStream, true);
  assert.equal(stream.sensitiveRead, true);

  const health = classifyPanelRequest({ method: "GET", path: "/api/health" });
  assert.equal(health.sensitiveRead, false);
  assert.equal(health.privileged, false);
});

test("a mutation without the custom header is rejected", () => {
  const decision = evaluatePanelAccess(
    request({ method: "POST", path: "/api/database/migrate" }),
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.allowed === false && decision.reason, "missing_panel_header");
  assert.equal(decision.allowed === false && decision.status, 403);
  assert.equal(decision.classification.privileged, true);
});

test("a mutation with a wrong custom header value is rejected", () => {
  const decision = evaluatePanelAccess(
    request({
      method: "POST",
      path: "/api/database/migrate",
      panelHeader: "0",
    }),
  );
  assert.equal(decision.allowed === false && decision.reason, "missing_panel_header");
});

test("a mutation with the custom header from a loopback origin is allowed", () => {
  const decision = evaluatePanelAccess(
    request({
      method: "POST",
      path: "/api/database/migrate",
      origin: "http://127.0.0.1:5110",
      panelHeader: PANEL_REQUEST_HEADER_VALUE,
    }),
  );
  assert.equal(decision.allowed, true);
});

test("a mutation from a foreign origin is rejected before the header check", () => {
  const decision = evaluatePanelAccess(
    request({
      method: "POST",
      path: "/api/database/migrate",
      origin: "https://attacker.example",
      panelHeader: PANEL_REQUEST_HEADER_VALUE,
    }),
  );
  assert.equal(decision.allowed === false && decision.reason, "non_loopback_origin");
});

test("a sensitive read through a rebound host name is rejected", () => {
  const decision = evaluatePanelAccess(
    request({ host: "panel.attacker.example:5110" }),
  );
  assert.equal(decision.allowed === false && decision.reason, "non_loopback_host");
});

test("a sensitive read without a host header fails closed", () => {
  const decision = evaluatePanelAccess(request({ host: undefined }));
  assert.equal(decision.allowed === false && decision.reason, "non_loopback_host");
});

test("a sensitive read over loopback needs no custom header", () => {
  assert.equal(evaluatePanelAccess(request()).allowed, true);
});

test("event streams relax the header only, never the loopback checks", () => {
  assert.equal(
    evaluatePanelAccess(request({ path: "/api/logs/sources/stream" })).allowed,
    true,
  );

  const rebound = evaluatePanelAccess(
    request({ path: "/api/logs/sources/stream", host: "panel.attacker.example" }),
  );
  assert.equal(rebound.allowed === false && rebound.reason, "non_loopback_host");

  const foreign = evaluatePanelAccess(
    request({
      path: "/api/logs/sources/stream",
      origin: "https://attacker.example",
    }),
  );
  assert.equal(foreign.allowed === false && foreign.reason, "non_loopback_origin");
});

test("a raw download is privileged even though it is a GET", () => {
  const withoutHeader = evaluatePanelAccess(
    request({ path: "/api/logs/download/worker" }),
  );
  assert.equal(
    withoutHeader.allowed === false && withoutHeader.reason,
    "missing_panel_header",
  );
  assert.equal(
    evaluatePanelAccess(
      request({
        path: "/api/logs/download/worker",
        panelHeader: PANEL_REQUEST_HEADER_VALUE,
      }),
    ).allowed,
    true,
  );
});

test("a raw download ending in /stream still demands the panel header", () => {
  // The EventSource exemption exists because the browser's EventSource client
  // cannot attach request headers. A raw download must never inherit it: a
  // cross-origin GET from an image or script tag sends no `Origin` and carries
  // a loopback `Host`, so the custom header is the only remaining layer.
  const classification = classifyPanelRequest({
    method: "GET",
    path: "/api/logs/download/worker/stream",
  });
  assert.equal(classification.privileged, true);
  assert.equal(classification.eventStream, false);

  const crossOrigin = evaluatePanelAccess({
    method: "GET",
    path: "/api/logs/download/worker/stream",
    host: "127.0.0.1:5110",
    origin: undefined,
    panelHeader: undefined,
  });
  assert.equal(
    crossOrigin.allowed === false && crossOrigin.reason,
    "missing_panel_header",
  );
});

test("liveness stays reachable without loopback host checks", () => {
  assert.equal(
    evaluatePanelAccess(request({ path: "/api/health", host: undefined })).allowed,
    true,
  );
});

test("response status maps to an audit outcome", () => {
  assert.equal(outcomeForStatus(200), "succeeded");
  assert.equal(outcomeForStatus(204), "succeeded");
  assert.equal(outcomeForStatus(400), "failed");
  assert.equal(outcomeForStatus(500), "failed");
});

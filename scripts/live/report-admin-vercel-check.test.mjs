import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { reportAdminVercelCheck } from "./report-admin-vercel-check.mjs";

const ID = "dpl_AdminCandidate";
const RUN_ID = "ckr_01111111-1111-1111-1111-111111111111";
const CHECK_ID = "chk_1319f9e5-a77d-4853-95bc-3fc2a64756d8";
const PROJECT = "prj_KR0CnNkPlRgaHRxdPkJh9pVqDGsC";
const TEAM = "team_ZzCQUWPmGibyjlKTAsymGPu1";
const HOST = "packscout-admin-ab123cd45-pack-scout.vercel.app";
const TOKEN = "fixture-vercel-token-never-log";
const BYPASS = "fixture-bypass-never-log";
const json = (value) => new Response(JSON.stringify(value), {
  headers: { "content-type": "application/json" },
});
const deployment = (patch = {}) => ({
  id: ID, projectId: PROJECT, ownerId: TEAM, target: "production", readyState: "READY",
  readySubstate: "STAGED", url: HOST,
  gitSource: { type: "github", repoId: 1318671205, ref: "main", sha: "a".repeat(40) },
  checks: { "deployment-alias": { state: "pending" } }, ...patch,
});
const definition = (patch = {}) => ({
  id: CHECK_ID, name: "Admin deployed runtime", ownerId: TEAM, projectId: PROJECT,
  source: { kind: "webhook" }, sourceKind: "webhook", requires: "deployment-url",
  blocks: "deployment-alias", targets: ["production"], isRerequestable: false,
  timeout: 300, createdAt: 1, updatedAt: 1, ...patch,
});
// Checks v2 permits these run fields to be absent: projectId/requires/blocks/targets.
const run = (patch = {}) => ({
  id: RUN_ID, checkId: CHECK_ID, name: "Admin deployed runtime", ownerId: TEAM,
  deploymentId: ID, source: { kind: "webhook" }, status: "queued",
  timeout: 300, createdAt: 1, updatedAt: 1, ...patch,
});
const nth = (values, count) => values[Math.min(count - 1, values.length - 1)];

function fixture({
  candidate = deployment(), definitions = [definition()], rows = [run()],
  runLists, runReads, smokeImpl = async () => ({ ok: true }), intercept = () => undefined,
} = {}) {
  const calls = [];
  const events = [];
  const waits = [];
  const counts = new Map();
  const stored = new Map(rows.map((row) => [row.id, row]));
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    const method = options.method ?? "GET";
    const key = `${method} ${url.pathname}`;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url, options, method, body });
    events.push(key);
    const response = await intercept({ url, options, method, body, count });
    if (response !== undefined) return response;
    assert.equal(url.origin, "https://api.vercel.com");
    if (url.pathname === `/v13/deployments/${candidate.id}`) return json(candidate);
    if (url.pathname === `/v2/projects/${PROJECT}/checks/${CHECK_ID}`) return json(nth(definitions, count));
    const listPath = `/v2/deployments/${candidate.id}/check-runs`;
    if (url.pathname === listPath) return json({ runs: runLists ? nth(runLists, count) : rows });
    assert.ok(url.pathname.startsWith(`${listPath}/`));
    const id = url.pathname.slice(listPath.length + 1);
    assert.ok(stored.has(id));
    if (method === "GET") return json(runReads ? nth(runReads, count) : stored.get(id));
    assert.equal(method, "PATCH");
    stored.set(id, { ...stored.get(id), ...body });
    return json(stored.get(id));
  };
  return {
    calls, events, waits,
    patches: () => calls.filter(({ method }) => method === "PATCH"),
    invoke: (options = {}) => reportAdminVercelCheck({
      deploymentId: candidate.id, token: TOKEN, protectionBypass: BYPASS, fetchImpl,
      smoke: async (input) => {
        events.push("smoke");
        assert.equal(input.deploymentUrl, `https://${HOST}`);
        assert.equal(input.protectionBypass, BYPASS);
        assert.ok(input.totalTimeoutMs > 0 && input.totalTimeoutMs <= 60_000);
        return smokeImpl(input);
      },
      wait: async (ms) => { waits.push(ms); }, ...options,
    }),
  };
}

const rejects = (promise, code) => assert.rejects(promise, { message: `ADMIN_CHECK_${code}` });
async function refuses(fake, code, options) {
  await rejects(fake.invoke(options), code);
  assert.equal(fake.patches().length, 0);
}

test("healthy artifact reports only its native deployment run, leaving promotion to Vercel", async () => {
  const fake = fixture({ smokeImpl: async () => ({ ok: true, arbitrarySecret: BYPASS }) });
  assert.deepEqual(await fake.invoke(), { status: "succeeded", deploymentId: ID, checkRunId: RUN_ID });
  const patches = fake.patches();
  assert.deepEqual(patches.map(({ body }) => body), [
    { status: "running" },
    { status: "completed", conclusion: "succeeded", conclusionText: "Deployed admin runtime smoke checks passed." },
  ]);
  assert.ok(fake.events.indexOf("smoke") > fake.events.indexOf(`PATCH ${patches[0].url.pathname}`));
  assert.ok(fake.events.lastIndexOf(`GET ${patches[0].url.pathname}`) > fake.events.indexOf("smoke"));
  assert.equal(fake.events.filter((event) => event === `GET /v2/projects/${PROJECT}/checks/${CHECK_ID}`).length, 2);
  for (const { url, options, method } of fake.calls) {
    assert.equal(url.origin, "https://api.vercel.com");
    assert.equal(url.searchParams.get("teamId"), TEAM);
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(options.headers["x-vercel-protection-bypass"], undefined);
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    assert.ok(options.signal instanceof AbortSignal);
    assert.ok(["GET", "PATCH"].includes(method));
    if (method === "PATCH") assert.equal(url.pathname, `/v2/deployments/${ID}/check-runs/${RUN_ID}`);
    else assert.equal(options.body, undefined);
  }
  assert.deepEqual(fake.waits, []);
});

test("a redeployment of the same SHA must pass its own check run", async () => {
  const old = run({ id: "ckr_old", deploymentId: "dpl_PreviousArtifact", status: "completed", conclusion: "succeeded" });
  await refuses(fixture({ rows: [old] }), "INVALID_RUN");
  const newId = "dpl_RedeployedSameSha";
  const fake = fixture({ candidate: deployment({ id: newId }), rows: [run({ deploymentId: newId })] });
  assert.deepEqual(await fake.invoke(), { status: "succeeded", deploymentId: newId, checkRunId: RUN_ID });
  assert.equal(fake.events.includes("smoke"), true);
  assert.ok(fake.patches().every(({ url }) => url.pathname.includes(`/deployments/${newId}/`)));
});

test("smoke failure is reported as failed with fixed text and never leaks its error or body", async () => {
  for (const smokeImpl of [
    async () => ({ ok: false, body: `${TOKEN} ${BYPASS}` }),
    async () => { throw new Error(`request ${TOKEN} https://foreign.example/${BYPASS}`); },
    async () => undefined,
  ]) {
    const fake = fixture({ smokeImpl });
    await rejects(fake.invoke(), "SMOKE_FAILED");
    assert.deepEqual(fake.patches().map(({ body }) => body), [
      { status: "running" },
      { status: "completed", conclusion: "failed", conclusionText: "Deployed admin runtime smoke checks failed." },
    ]);
  }
});

test("finished runs cannot be rewritten or used to skip an active retry", async () => {
  const completed = run({ status: "completed", conclusion: "succeeded" });
  const done = fixture({ candidate: deployment({ readySubstate: "PROMOTED" }), rows: [completed] });
  assert.deepEqual(await done.invoke(), { status: "already-completed", deploymentId: ID, checkRunId: RUN_ID });
  assert.equal(done.events.includes("smoke"), false);
  assert.equal(done.patches().length, 0);
  for (const conclusion of ["failed", "timeout", "canceled", "neutral", "skipped", undefined]) {
    await refuses(fixture({ rows: [run({ status: "completed", conclusion })] }), "RUN_ALREADY_FAILED");
  }
  const retry = fixture({ rows: [run({ id: "ckr_previous", status: "completed", conclusion: "succeeded" }), run()] });
  assert.equal((await retry.invoke()).checkRunId, RUN_ID);
  assert.equal(retry.events.includes("smoke"), true);
  assert.equal(retry.patches().length, 2);
});

test("a terminal run observed after smoke is respected without a completion rewrite", async () => {
  for (const conclusion of ["failed", "timeout", "canceled"]) {
    const fake = fixture({ runReads: [run({ status: "completed", conclusion })] });
    await rejects(fake.invoke(), "RUN_ALREADY_FAILED");
    assert.deepEqual(fake.patches().map(({ body }) => body), [{ status: "running" }]);
  }
  const completed = fixture({ runReads: [run({ status: "completed", conclusion: "succeeded" })] });
  assert.equal((await completed.invoke()).status, "already-completed");
  assert.equal(completed.patches().length, 1);
});

test("run discovery allows eventual registration but refuses missing, malformed or ambiguous matches", async () => {
  const later = fixture({ runLists: [[], [run()]] });
  assert.equal((await later.invoke()).status, "succeeded");
  assert.deepEqual(later.waits, [1_000]);
  const missing = fixture({ rows: [] });
  await refuses(missing, "RUN_NOT_FOUND");
  assert.ok(missing.waits.length > 0 && missing.waits.length <= 5);
  await refuses(fixture({ rows: [run(), run({ id: "ckr_duplicate" })] }), "AMBIGUOUS_RUN");
  await refuses(fixture({ rows: [run({ status: "completed" }), run({ id: "ckr_duplicate", status: "completed" })] }), "AMBIGUOUS_RUN");
  const otherCheck = fixture({ rows: [run({ id: "ckr_unrelated", checkId: "chk_Unrelated" }), run()] });
  assert.equal((await otherCheck.invoke()).checkRunId, RUN_ID);
  await refuses(fixture({ intercept: ({ url }) => url.pathname.endsWith("/check-runs") ? json({ runs: null }) : undefined }), "INVALID_RUN_LIST");
});

test("only authoritative admin production metadata can select a deployment", async (t) => {
  for (const [name, patch] of [
    ["wrong project", { projectId: "prj_Other" }], ["wrong team", { ownerId: "team_Other" }],
    ["preview", { target: "preview" }], ["building", { readyState: "BUILDING" }],
    ["missing git", { gitSource: null }],
    ["wrong provider", { gitSource: { ...deployment().gitSource, type: "gitlab" } }],
    ["wrong repository", { gitSource: { ...deployment().gitSource, repoId: 1 } }],
    ["feature branch", { gitSource: { ...deployment().gitSource, ref: "feature" } }],
    ["invalid sha", { gitSource: { ...deployment().gitSource, sha: "main" } }],
  ]) await t.test(name, () => refuses(fixture({ candidate: deployment(patch) }), "INVALID_DEPLOYMENT"));
  await refuses(fixture({ intercept: ({ url }) => url.pathname.startsWith("/v13/") ? json(deployment({ id: "dpl_Other" })) : undefined }), "INVALID_DEPLOYMENT");
  for (const url of ["foreign.example", "packscout-admin.vercel.app", `${HOST}/operations`, `${HOST}?secret=${BYPASS}`]) {
    const fake = fixture({ candidate: deployment({ url }) });
    await refuses(fake, "INVALID_DEPLOYMENT_URL");
    assert.equal(fake.events.includes("smoke"), false);
  }
});

test("a removed, foreign, nonblocking or misconfigured definition cannot be approved", async (t) => {
  for (const [name, patch] of [
    ["wrong id", { id: "chk_Other" }], ["wrong project", { projectId: "prj_Other" }],
    ["wrong owner", { ownerId: "team_Other" }], ["wrong source", { source: { kind: "git-provider" } }],
    ["no source", { source: undefined }], ["no deployment URL", { requires: "build-ready" }],
    ["nonblocking", { blocks: "none" }], ["different phase", { blocks: "deployment-promotion" }],
    ["preview only", { targets: ["preview"] }], ["malformed targets", { targets: "production" }],
    ["deleted", { deletedAt: 123 }],
  ]) await t.test(name, () => refuses(fixture({ definitions: [definition(patch)] }), "INVALID_DEFINITION"));
  const changed = fixture({ definitions: [definition(), definition({ blocks: "none" })] });
  await rejects(changed.invoke(), "INVALID_DEFINITION");
  assert.deepEqual(changed.patches().map(({ body }) => body), [{ status: "running" }]);
});

test("run ownership and any supplied optional scope fields must match the registered check", async (t) => {
  for (const [name, patch] of [
    ["invalid run id", { id: "ckr_bad/path" }], ["foreign deployment", { deploymentId: "dpl_Other" }],
    ["foreign owner", { ownerId: "team_Other" }], ["foreign source", { source: { kind: "integration" } }],
    ["foreign project", { projectId: "prj_Other" }], ["wrong prerequisite", { requires: "none" }],
    ["nonblocking", { blocks: "none" }], ["wrong target", { targets: ["preview"] }],
    ["unknown status", { status: "passed" }],
  ]) await t.test(name, () => refuses(fixture({ rows: [run(patch)] }), "INVALID_RUN"));
  const completeScope = fixture({ rows: [run({ projectId: PROJECT, requires: "deployment-url", blocks: "deployment-alias", targets: ["production"] })] });
  assert.equal((await completeScope.invoke()).status, "succeeded");
  const switched = fixture({ runReads: [run({ id: "ckr_Other" })] });
  await rejects(switched.invoke(), "INVALID_RUN");
  assert.equal(switched.patches().length, 1);
});

test("invalid credentials, identifiers and timeout budgets fail before any request", async (t) => {
  for (const [name, patch, code] of [
    ["no token", { token: "" }, "TOKEN_REQUIRED"], ["newline token", { token: "bad\nsecret" }, "TOKEN_REQUIRED"],
    ["newline bypass", { protectionBypass: "bad\nsecret" }, "BYPASS_INVALID"],
    ["missing id", { deploymentId: undefined }, "INVALID_ID"], ["path injection", { deploymentId: "dpl_A/../B" }, "INVALID_ID"],
    ["query injection", { deploymentId: "dpl_A?teamId=other" }, "INVALID_ID"],
    ["zero timeout", { requestTimeoutMs: 0 }, "LIMIT_INVALID"],
    ["unbounded deadline", { totalTimeoutMs: Infinity }, "LIMIT_INVALID"],
  ]) await t.test(name, async () => {
    const fake = fixture();
    await refuses(fake, code, patch);
    assert.equal(fake.calls.length, 0);
  });
});

test("redirects, transport errors, malformed JSON and oversized API responses fail safely", async (t) => {
  for (const [name, response, code] of [
    ["redirect", () => new Response(null, { status: 307, headers: { location: `https://foreign.example/${TOKEN}` } }), "API_REJECTED"],
    ["rejected", () => new Response(`${TOKEN} ${BYPASS}`, { status: 403 }), "API_REJECTED"],
    ["network", () => { throw new Error(`${TOKEN} ${BYPASS}`); }, "API_REQUEST_FAILED"],
    ["malformed JSON", () => new Response(`not-json ${TOKEN}`), "API_REQUEST_FAILED"],
    ["large advertised body", () => new Response("{}", { headers: { "content-length": "1048577" } }), "API_BODY_TOO_LARGE"],
    ["large streamed body", () => new Response("x".repeat(1048577)), "API_BODY_TOO_LARGE"],
  ]) await t.test(name, () => refuses(fixture({ intercept: response }), code));
  for (const property of ["redirected", "url"]) {
    const response = json(deployment());
    Object.defineProperty(response, property, { value: property === "url" ? `https://foreign.example/${TOKEN}` : true });
    await refuses(fixture({ intercept: () => response }), "API_REJECTED");
  }
});

test("stalled fetch and response bodies are aborted within the request budget", async () => {
  for (const intercept of [
    () => new Promise(() => {}),
    () => new Response(new ReadableStream({ start() {} })),
  ]) {
    const fake = fixture({ intercept });
    const started = Date.now();
    await refuses(fake, "DEADLINE_EXCEEDED", { requestTimeoutMs: 10, totalTimeoutMs: 30 });
    assert.ok(Date.now() - started < 1_000);
    assert.equal(fake.calls[0].options.signal.aborted, true);
  }
});

test("Vercel must confirm each update for the same run and requested conclusion", async () => {
  for (const response of [
    () => json(run()),
    () => json(run({ id: "ckr_Other", status: "running" })),
    () => new Response(TOKEN, { status: 403 }),
  ]) {
    const fake = fixture({ intercept: ({ method }) => method === "PATCH" ? response() : undefined });
    await assert.rejects(fake.invoke(), /^Error: ADMIN_CHECK_(?:UPDATE_NOT_CONFIRMED|INVALID_RUN|API_REJECTED)$/u);
    assert.equal(fake.events.includes("smoke"), false);
    assert.equal(fake.patches().length, 1);
  }
  const wrongConclusion = fixture({ intercept: ({ method, body }) => method === "PATCH" && body.status === "completed"
    ? json(run({ status: "completed", conclusion: "failed" })) : undefined });
  await rejects(wrongConclusion.invoke(), "UPDATE_NOT_CONFIRMED");
  assert.equal(wrongConclusion.patches().length, 2);
});

test("CLI requires a trusted workflow and redacts transport and smoke failures", () => {
  const script = fileURLToPath(new URL("./report-admin-vercel-check.mjs", import.meta.url));
  const failureStub = `globalThis.fetch = async () => { throw new Error(${JSON.stringify(`${TOKEN} ${BYPASS}`)}); };`;
  const smokeStub = `let row = ${JSON.stringify(run())}; globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input); let value;
    if (url.hostname !== 'api.vercel.com') return new Response(${JSON.stringify(BYPASS)}, { headers: { 'content-type': 'text/html' } });
    if (url.pathname.startsWith('/v13/')) value = ${JSON.stringify(deployment())};
    else if (url.pathname.startsWith('/v2/projects/')) value = ${JSON.stringify(definition())};
    else if (url.pathname.endsWith('/check-runs')) value = { runs: [row] };
    else { if (options.method === 'PATCH') row = { ...row, ...JSON.parse(options.body) }; value = row; }
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  };`;
  const invoke = (patch = {}, preload = failureStub) => spawnSync(process.execPath, [
    "--import", `data:text/javascript,${encodeURIComponent(preload)}`, script,
  ], { encoding: "utf8", env: {
    ...process.env, GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "dadriano/packscout",
    GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "repository_dispatch",
    PACKSCOUT_ADMIN_DEPLOYMENT_ID: ID, VERCEL_ADMIN_CHECK_TOKEN: TOKEN,
    VERCEL_AUTOMATION_BYPASS_SECRET: BYPASS, ...patch,
  } });
  for (const patch of [
    { GITHUB_ACTIONS: "false" }, { GITHUB_REPOSITORY: "attacker/packscout" },
    { GITHUB_REF: "refs/heads/feature" }, { GITHUB_EVENT_NAME: "pull_request" },
  ]) {
    const result = invoke(patch);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "ADMIN_CHECK_TRUSTED_WORKFLOW_REQUIRED\n");
  }
  for (const [preload, code] of [[failureStub, "API_REQUEST_FAILED"], [smokeStub, "SMOKE_FAILED"]]) {
    const result = invoke({}, preload);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, `ADMIN_CHECK_${code}\n`);
  }
});

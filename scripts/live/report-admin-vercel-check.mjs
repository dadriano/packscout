import path from "node:path";
import { pathToFileURL } from "node:url";
import { checkAdminDeployment, validateDeploymentUrl } from "../preproduction/check-admin-vercel.mjs";

const projectId = "prj_KR0CnNkPlRgaHRxdPkJh9pVqDGsC";
const teamId = "team_ZzCQUWPmGibyjlKTAsymGPu1";
const repositoryId = "1318671205";
const checkId = "chk_1319f9e5-a77d-4853-95bc-3fc2a64756d8";

class AdminCheckError extends Error {
  constructor(code) {
    super(`ADMIN_CHECK_${code}`);
    this.code = this.message;
  }
}
function requireCondition(condition, code) {
  if (!condition) throw new AdminCheckError(code);
}
const credentialValid = (value) => typeof value === "string" && /^[\x21-\x7e]{1,8192}$/u.test(value);
const productionTarget = (targets) => Array.isArray(targets) && targets.includes("production");

function validateDeployment(deployment, deploymentId) {
  requireCondition(
    deployment?.id === deploymentId && deployment.projectId === projectId &&
    deployment.ownerId === teamId && deployment.target === "production" &&
    deployment.readyState === "READY" && deployment.gitSource?.type === "github" &&
    String(deployment.gitSource.repoId) === repositoryId && deployment.gitSource.ref === "main" &&
    /^[a-f0-9]{40}$/u.test(deployment.gitSource.sha ?? ""), "INVALID_DEPLOYMENT",
  );
  try { return validateDeploymentUrl(`https://${deployment.url}`); }
  catch { throw new AdminCheckError("INVALID_DEPLOYMENT_URL"); }
}

function validateDefinition(check) {
  requireCondition(
    check?.id === checkId && check.projectId === projectId && check.ownerId === teamId &&
    check.source?.kind === "webhook" && check.requires === "deployment-url" &&
    check.blocks === "deployment-alias" && productionTarget(check.targets) && !check.deletedAt,
    "INVALID_DEFINITION",
  );
}

function validateRun(run, deploymentId, expectedId) {
  requireCondition(
    typeof run?.id === "string" && /^ckr_[A-Za-z0-9-]{1,100}$/u.test(run.id) &&
    (!expectedId || run.id === expectedId) && run.checkId === checkId &&
    run.deploymentId === deploymentId && run.ownerId === teamId && run.source?.kind === "webhook" &&
    (run.projectId === undefined || run.projectId === projectId) &&
    (run.requires === undefined || run.requires === "deployment-url") &&
    (run.blocks === undefined || run.blocks === "deployment-alias") &&
    (run.targets === undefined || productionTarget(run.targets)) &&
    ["queued", "running", "completed"].includes(run.status), "INVALID_RUN",
  );
  return run;
}

async function readJson(response) {
  requireCondition(Number(response.headers.get("content-length")) <= 1024 * 1024, "API_BODY_TOO_LARGE");
  const reader = response.body?.getReader();
  requireCondition(reader, "API_RESPONSE_INVALID");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      requireCondition(size <= 1024 * 1024, "API_BODY_TOO_LARGE");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } finally {
    void reader.cancel().catch(() => {});
  }
}

/** Reports only the registered Vercel check run; Vercel owns production promotion. */
export async function reportAdminVercelCheck({
  deploymentId, token, protectionBypass, fetchImpl = fetch, smoke = checkAdminDeployment,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  requestTimeoutMs = 15_000, totalTimeoutMs = 120_000,
} = {}) {
  requireCondition(typeof deploymentId === "string" && /^dpl_[A-Za-z0-9]{1,100}$/u.test(deploymentId), "INVALID_ID");
  requireCondition(credentialValid(token), "TOKEN_REQUIRED");
  requireCondition(protectionBypass === undefined || protectionBypass === "" || credentialValid(protectionBypass), "BYPASS_INVALID");
  requireCondition(Number.isSafeInteger(requestTimeoutMs) && requestTimeoutMs > 0 && requestTimeoutMs <= 30_000 &&
    Number.isSafeInteger(totalTimeoutMs) && totalTimeoutMs > 0 && totalTimeoutMs <= 180_000, "LIMIT_INVALID");
  const deadline = Date.now() + totalTimeoutMs;

  async function api(route, body) {
    const timeout = Math.min(requestTimeoutMs, deadline - Date.now());
    requireCondition(timeout > 0, "DEADLINE_EXCEEDED");
    const url = new URL(route, "https://api.vercel.com");
    url.searchParams.set("teamId", teamId);
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        (async () => {
          const response = await fetchImpl(url, {
            method: body ? "PATCH" : "GET", redirect: "error", credentials: "omit",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            signal: controller.signal, ...(body ? { body: JSON.stringify(body) } : {}),
          });
          requireCondition(response.ok && !response.redirected && (!response.url || response.url === url.href), "API_REJECTED");
          return readJson(response);
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new AdminCheckError("DEADLINE_EXCEEDED"));
            controller.abort();
          }, timeout);
        }),
      ]);
    } catch (error) {
      throw error instanceof AdminCheckError ? error : new AdminCheckError("API_REQUEST_FAILED");
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  const deploymentUrl = validateDeployment(await api(`/v13/deployments/${deploymentId}`), deploymentId);
  const definitionRoute = `/v2/projects/${projectId}/checks/${checkId}`;
  validateDefinition(await api(definitionRoute));
  let selected;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = await api(`/v2/deployments/${deploymentId}/check-runs`);
    requireCondition(Array.isArray(result?.runs), "INVALID_RUN_LIST");
    const matches = result.runs.filter((run) => run?.checkId === checkId);
    matches.forEach((run) => validateRun(run, deploymentId));
    const active = matches.filter((run) => run.status !== "completed");
    requireCondition(active.length <= 1 && (active.length === 1 || matches.length <= 1), "AMBIGUOUS_RUN");
    selected = active[0] ?? matches[0];
    if (selected) break;
    if (attempt < 4) {
      requireCondition(Date.now() + 1_000 < deadline, "DEADLINE_EXCEEDED");
      await wait(1_000);
    }
  }
  requireCondition(selected, "RUN_NOT_FOUND");
  const summary = { deploymentId, checkRunId: selected.id };
  const terminal = (run) => {
    if (run.status !== "completed") return false;
    requireCondition(run.conclusion === "succeeded", "RUN_ALREADY_FAILED");
    return true;
  };
  if (terminal(selected)) return { status: "already-completed", ...summary };
  const runRoute = `/v2/deployments/${deploymentId}/check-runs/${selected.id}`;
  const update = async (body) => {
    const run = validateRun(await api(runRoute, body), deploymentId, selected.id);
    requireCondition(run.status === body.status && (!body.conclusion || run.conclusion === body.conclusion), "UPDATE_NOT_CONFIRMED");
    return run;
  };
  await update({ status: "running" });

  let passed = false;
  try {
    const remaining = deadline - Date.now();
    requireCondition(remaining > 0, "DEADLINE_EXCEEDED");
    passed = (await smoke({ deploymentUrl, protectionBypass, totalTimeoutMs: Math.min(60_000, remaining) }))?.ok === true;
  } catch {
    // Neither credential-bearing transport errors nor deployment bodies enter Vercel check output.
  }
  const current = validateRun(await api(runRoute), deploymentId, selected.id);
  if (terminal(current)) return { status: "already-completed", ...summary };
  validateDefinition(await api(definitionRoute));
  await update({
    status: "completed", conclusion: passed ? "succeeded" : "failed",
    conclusionText: passed ? "Deployed admin runtime smoke checks passed." : "Deployed admin runtime smoke checks failed.",
  });
  requireCondition(passed, "SMOKE_FAILED");
  return { status: "succeeded", ...summary };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    requireCondition(process.env.GITHUB_ACTIONS === "true" &&
      process.env.GITHUB_REPOSITORY === "dadriano/packscout" && process.env.GITHUB_REF === "refs/heads/main" &&
      ["repository_dispatch", "workflow_dispatch"].includes(process.env.GITHUB_EVENT_NAME), "TRUSTED_WORKFLOW_REQUIRED");
    const result = await reportAdminVercelCheck({
      deploymentId: process.env.PACKSCOUT_ADMIN_DEPLOYMENT_ID,
      token: process.env.VERCEL_ADMIN_CHECK_TOKEN,
      protectionBypass: process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof AdminCheckError ? error.code : "ADMIN_CHECK_FAILED");
    process.exitCode = 1;
  }
}

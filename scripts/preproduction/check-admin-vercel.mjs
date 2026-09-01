#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";

class DeploymentCheckError extends Error {
  constructor(code) {
    super(`ADMIN_VERCEL_${code}`);
    this.code = this.message;
  }
}
const refuse = (code) => { throw new DeploymentCheckError(code); };
const attribute = (tag, name) => tag.match(new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`, "iu"))?.[2];
const mediaType = (response) => response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();

export function validateDeploymentUrl(value) {
  if (typeof value !== "string" || !/^https:\/\/packscout-admin-[a-z0-9]+-pack-scout\.vercel\.app\/?$/u.test(value)) {
    refuse("TARGET_INVALID");
  }
  return value.replace(/\/$/u, "");
}

function bounded(value, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) refuse("LIMIT_INVALID");
  return value;
}

function assetsFromHtml(html, origin) {
  if (!/<title>\s*Packscout Admin\s*<\/title>/iu.test(html) ||
      !/<div\b[^>]*\sid\s*=\s*(["'])root\1/iu.test(html)) refuse("SHELL_INVALID");
  const assets = new Map();
  for (const [tag] of html.matchAll(/<(?:script|link)\b[^>]*>/giu)) {
    const script = /^<script\b/iu.test(tag);
    if (!script && !attribute(tag, "rel")?.split(/\s+/u).includes("stylesheet")) continue;
    const reference = attribute(tag, script ? "src" : "href");
    if (script && reference === undefined) continue;
    const asset = reference?.startsWith(`${origin}/`) ? reference.slice(origin.length) : reference;
    const kind = script ? "js" : "css";
    if (!asset || !new RegExp(`^/assets/[A-Za-z0-9][A-Za-z0-9._-]*\\.${kind}$`, "u").test(asset)) {
      refuse("ASSET_URL_INVALID");
    }
    assets.set(asset, kind);
    if (assets.size > 24) refuse("ASSET_LIMIT_EXCEEDED");
  }
  if (!new Set(assets.values()).has("js") || !new Set(assets.values()).has("css")) refuse("ASSETS_MISSING");
  return assets;
}

async function limitedBody(response, maximumBytes) {
  if (Number(response.headers.get("content-length")) > maximumBytes) refuse("BODY_TOO_LARGE");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) refuse("BODY_TOO_LARGE");
      chunks.push(value);
    }
    return Buffer.concat(chunks, size).toString("utf8");
  } finally {
    void reader.cancel().catch(() => {});
  }
}

/** Read-only checks against one immutable Vercel deployment; never logs response bodies. */
export async function checkAdminDeployment({
  deploymentUrl, protectionBypass, fetchImpl = fetch,
  requestTimeoutMs = 10_000, totalTimeoutMs = 60_000,
  maxBodyBytes = 4 * 1024 * 1024, attempts = 3, retryDelayMs = 1_000,
} = {}) {
  const origin = validateDeploymentUrl(deploymentUrl);
  bounded(requestTimeoutMs, 30_000);
  bounded(totalTimeoutMs, 120_000);
  bounded(maxBodyBytes, 8 * 1024 * 1024);
  bounded(attempts, 3);
  bounded(retryDelayMs, 5_000);
  if (protectionBypass !== undefined &&
      (typeof protectionBypass !== "string" || /[\r\n]/u.test(protectionBypass))) refuse("BYPASS_INVALID");
  const headers = protectionBypass ? { "x-vercel-protection-bypass": protectionBypass } : {};
  const deadline = Date.now() + totalTimeoutMs;
  let checkedRequests = 0;

  async function request(route) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const timeout = Math.min(requestTimeoutMs, deadline - Date.now());
      if (timeout <= 0) refuse("DEADLINE_EXCEEDED");
      const controller = new AbortController();
      let timer;
      try {
        return await Promise.race([
          (async () => {
            checkedRequests += 1;
            const response = await fetchImpl(`${origin}${route}`, {
              method: "GET", headers, redirect: "error", credentials: "omit",
              cache: "no-store", signal: controller.signal,
            });
            if (response.redirected || (response.url && response.url !== `${origin}${route}`) ||
                (response.status >= 300 && response.status < 400)) refuse("REDIRECT_REFUSED");
            if (response.status >= 500) {
              void response.body?.cancel().catch(() => {});
              refuse("SERVER_ERROR");
            }
            return { status: response.status, type: mediaType(response), text: await limitedBody(response, maxBodyBytes) };
          })(),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              reject(new DeploymentCheckError("DEADLINE_EXCEEDED"));
              controller.abort();
            }, timeout);
          }),
        ]);
      } catch (error) {
        const failure = error instanceof DeploymentCheckError ? error : new DeploymentCheckError("REQUEST_FAILED");
        const retryable = ["ADMIN_VERCEL_SERVER_ERROR", "ADMIN_VERCEL_REQUEST_FAILED", "ADMIN_VERCEL_DEADLINE_EXCEEDED"].includes(failure.code);
        if (!retryable || attempt === attempts) throw failure;
        if (Date.now() + retryDelayMs >= deadline) refuse("DEADLINE_EXCEEDED");
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  const shell = await request("/operations");
  if (shell.status !== 200 || shell.type !== "text/html") refuse("SHELL_RESPONSE_INVALID");
  const assets = assetsFromHtml(shell.text, origin);
  for (const [asset, kind] of assets) {
    const response = await request(asset);
    const types = kind === "js" ? ["text/javascript", "application/javascript"] : ["text/css"];
    if (response.status !== 200 || !types.includes(response.type) ||
        !response.text.trim() || /^\s*</u.test(response.text)) refuse("ASSET_RESPONSE_INVALID");
  }
  for (const [route, status, contract] of [
    ["/api/health", 200, { ok: true, service: "packscout-admin" }],
    ["/api/auth/session", 401, { code: "AUTH_REQUIRED" }],
    ["/api/provider-source-operations", 401, { code: "AUTH_REQUIRED" }],
  ]) {
    const response = await request(route);
    if (response.status !== status || response.type !== "application/json") refuse("API_RESPONSE_INVALID");
    let body;
    try { body = JSON.parse(response.text); } catch { refuse("API_JSON_INVALID"); }
    if (!body || Object.entries(contract).some(([key, value]) => body[key] !== value)) refuse("API_CONTRACT_INVALID");
  }
  return Object.freeze({ ok: true, readOnly: true, assetCount: assets.size, checkedRequests });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  checkAdminDeployment({
    deploymentUrl: process.env.PACKSCOUT_ADMIN_DEPLOYMENT_URL,
    protectionBypass: process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
  }).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof DeploymentCheckError ? error.code : "ADMIN_VERCEL_CHECK_FAILED"}\n`);
    process.exitCode = 1;
  });
}

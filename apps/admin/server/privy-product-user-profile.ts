import {
  PRODUCT_USER_MAX_DISPLAY_NAME_LENGTH,
  PRODUCT_USER_MAX_TEXT_LENGTH,
  type ProductUserProfile,
} from "@packscout/contracts";
import type { ProductUserProfileReader } from "./product-user-profiles.ts";

const USER_SUBJECT = /^privy\.io\|(did:privy:[A-Za-z0-9_-]{1,128})$/u;
const APP_ID = /^[A-Za-z0-9_-]{8,128}$/u;
const MAX_LINKED_ACCOUNTS = 100;
const MAX_BODY_BYTES = 128 * 1_024;
const MAX_CACHE_ENTRIES = 256;
const CACHE_TTL_MS = 5 * 60_000;
const MISSING_PROFILE_TTL_MS = 30_000;
const MAX_CONCURRENT_REQUESTS = 4;
const MAX_OUTSTANDING_REQUESTS = 64;
const DEFAULT_TIMEOUT_MS = 3_000;

interface CachedProfile {
  readonly profile: ProductUserProfile | null;
  readonly expiresAt: number;
}

function containsControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

export interface PrivyProductUserProfileReaderInput {
  readonly appId: string | undefined;
  readonly appSecret: string | undefined;
  readonly fetchImplementation?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown, maximumLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed.length > maximumLength ||
    containsControlCharacters(trimmed) ? null : trimmed;
}

function email(value: unknown): string | null {
  const address = text(value, PRODUCT_USER_MAX_TEXT_LENGTH);
  return address !== null && /^[^\s@]+@[^\s@]+$/u.test(address)
    ? address.toLowerCase()
    : null;
}

function readProfilePayload(value: unknown, userId: string): ProductUserProfile | null {
  const user = object(value);
  // Even an authenticated provider response cannot identify a different user.
  if (user?.id !== userId || !Array.isArray(user.linked_accounts) ||
    user.linked_accounts.length > MAX_LINKED_ACCOUNTS) return null;

  let linkedEmail: string | null = null;
  let googleEmail: string | null = null;
  let name: string | null = null;
  for (const value of user.linked_accounts) {
    const account = object(value);
    // These are the two enabled login methods. Custom metadata and unrelated
    // account fields are never promoted into a person's display identity.
    if (account?.type === "email") linkedEmail ??= email(account.address);
    if (account?.type === "google_oauth") {
      googleEmail ??= email(account.email);
      name ??= text(account.name, PRODUCT_USER_MAX_DISPLAY_NAME_LENGTH);
    }
  }
  const address = linkedEmail ?? googleEmail;
  return name === null && address === null
    ? null
    : Object.freeze({ name, email: address });
}

/** Consume only a bounded body, including when Content-Length is missing. */
async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";
  try {
    while (true) {
      const next = await reader.read();
      if (signal.aborted) return null;
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      body += decoder.decode(next.value, { stream: true });
    }
    return JSON.parse(body + decoder.decode()) as unknown;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

/**
 * Privy's access token identifies the user but omits their linked accounts.
 * This server-only read resolves existing signups as well as new ones. The
 * fixed host, exact issuer, returned-ID check and bounded projection prevent
 * the lookup from accepting caller-controlled profile data or destinations.
 */
export function createPrivyProductUserProfileReader(
  input: PrivyProductUserProfileReaderInput,
): ProductUserProfileReader {
  const { appId, appSecret } = input;
  if (!appId || !APP_ID.test(appId) || !appSecret ||
    appSecret.length > 4_096 || appSecret !== appSecret.trim() ||
    containsControlCharacters(appSecret)) {
    return { readProfile: async () => null };
  }

  const call = input.fetchImplementation ?? fetch;
  const now = input.now ?? Date.now;
  const timeoutMs = Math.max(1, Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, 10_000));
  const authorization = `Basic ${Buffer.from(`${appId}:${appSecret}`).toString("base64")}`;
  const headers = { authorization, "privy-app-id": appId, accept: "application/json" };
  const cache = new Map<string, CachedProfile>();
  const outstanding = new Map<string, Promise<ProductUserProfile | null>>();
  const waiting: Array<() => void> = [];
  let active = 0;

  async function lookup(
    userId: string,
    budgetMs: number,
    deadline: AbortController,
  ): Promise<ProductUserProfile | null> {
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<null>((resolve) => {
      expiry = setTimeout(() => {
        deadline.abort();
        resolve(null);
      }, budgetMs);
    });
    try {
      const request = async () => {
        const response = await call(`https://api.privy.io/v1/users/${encodeURIComponent(userId)}`, {
          method: "GET",
          redirect: "error",
          headers,
          signal: deadline.signal,
        });
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          return null;
        }
        return readProfilePayload(await readJson(response, deadline.signal), userId);
      };
      // Covers headers AND body consumption, including a body that stalls.
      return await Promise.race([request(), expired]);
    } catch {
      // No provider response, credentials, or transport details leave here.
      return null;
    } finally {
      clearTimeout(expiry);
    }
  }

  function schedule(userId: string): Promise<ProductUserProfile | null> {
    const expiresAt = Date.now() + timeoutMs;
    const deadline = new AbortController();
    return new Promise((resolve) => {
      let started = false;
      let finished = false;
      const finish = (profile: ProductUserProfile | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(expiry);
        if (!started) {
          const index = waiting.indexOf(start);
          if (index !== -1) waiting.splice(index, 1);
        }
        resolve(profile);
      };
      const start = () => {
        const budgetMs = expiresAt - Date.now();
        if (budgetMs <= 0) {
          finish(null);
          waiting.shift()?.();
          return;
        }
        started = true;
        active += 1;
        void lookup(userId, budgetMs, deadline).then((profile) => {
          active -= 1;
          waiting.shift()?.();
          finish(profile);
        });
      };
      // Queue time consumes the same deadline as the HTTP request. A provider
      // outage cannot turn a page of twenty people into five timeout windows.
      const expiry = setTimeout(() => {
        deadline.abort();
        finish(null);
      }, timeoutMs);
      if (active < MAX_CONCURRENT_REQUESTS) start();
      else waiting.push(start);
    });
  }

  return {
    async readProfile(subject) {
      const userId = USER_SUBJECT.exec(subject)?.[1];
      if (userId === undefined) return null;
      const cached = cache.get(subject);
      if (cached !== undefined && cached.expiresAt > now()) {
        cache.delete(subject);
        cache.set(subject, cached);
        return cached.profile;
      }
      cache.delete(subject);
      const pending = outstanding.get(subject);
      if (pending !== undefined) return pending;
      // Bound both active requests and queued work across concurrent pages.
      if (outstanding.size >= MAX_OUTSTANDING_REQUESTS) return null;

      const result = schedule(userId).then((profile) => {
        if (cache.size >= MAX_CACHE_ENTRIES) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(subject, {
          profile,
          expiresAt: now() + (profile === null ? MISSING_PROFILE_TTL_MS : CACHE_TTL_MS),
        });
        outstanding.delete(subject);
        return profile;
      });
      outstanding.set(subject, result);
      return result;
    },
  };
}

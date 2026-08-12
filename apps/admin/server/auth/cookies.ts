import type { Response } from "express";

export interface SessionCookiePolicy {
  name: string;
  secure: boolean;
  maxAgeMs: number;
}

export function createSessionCookiePolicy(input: {
  production: boolean;
  maxAgeMs: number;
}): SessionCookiePolicy {
  return {
    name: input.production
      ? "__Host-packscout_session"
      : "packscout_session",
    secure: input.production,
    maxAgeMs: input.maxAgeMs,
  };
}

export function readCookie(
  cookieHeader: string | undefined,
  name: string,
): string | undefined {
  if (!cookieHeader) return undefined;
  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0 || pair.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(pair.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function setSessionCookie(
  response: Response,
  policy: SessionCookiePolicy,
  sessionToken: string,
): void {
  response.cookie(policy.name, sessionToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: policy.secure,
    path: "/",
    maxAge: policy.maxAgeMs,
  });
}

export function clearSessionCookie(
  response: Response,
  policy: SessionCookiePolicy,
): void {
  response.clearCookie(policy.name, {
    httpOnly: true,
    sameSite: "lax",
    secure: policy.secure,
    path: "/",
  });
}

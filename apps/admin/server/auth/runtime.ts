import type { RequestHandler } from "express";
import {
  AuthService,
  type AuthAuditSink,
  type AuthRepository,
  type LoginAttemptLimiter,
} from "@packscout/services";
import { createSessionCookiePolicy, type SessionCookiePolicy } from "./cookies.ts";
import { createNodeAuthSecurity } from "./crypto.ts";
import { createSameOriginGuard } from "./request-protection.ts";

export interface AdminAuthRuntime {
  service: AuthService;
  cookiePolicy: SessionCookiePolicy;
  sameOrigin: RequestHandler;
}

export async function createAdminAuthRuntime(input: {
  repository: AuthRepository;
  loginLimiter: LoginAttemptLimiter;
  audit: AuthAuditSink;
  sessionSecret: string;
  sessionIdleMs: number;
  sessionAbsoluteMs: number;
  production: boolean;
  allowedOrigins: readonly string[];
}): Promise<AdminAuthRuntime> {
  const security = createNodeAuthSecurity(input.sessionSecret);
  const service = new AuthService({
    repository: input.repository,
    clock: { now: () => new Date() },
    random: security.random,
    passwordHasher: security.passwordHasher,
    sessionDigest: security.sessionDigest,
    csrfDigest: security.csrfDigest,
    bucketKeyer: security.bucketKeyer,
    loginLimiter: input.loginLimiter,
    audit: input.audit,
    config: {
      sessionIdleMs: input.sessionIdleMs,
      sessionAbsoluteMs: input.sessionAbsoluteMs,
      dummyPasswordHash: await security.passwordHasher.hash(
        security.random.token(32),
      ),
    },
  });
  return {
    service,
    cookiePolicy: createSessionCookiePolicy({
      production: input.production,
      maxAgeMs: input.sessionAbsoluteMs,
    }),
    sameOrigin: createSameOriginGuard(input.allowedOrigins),
  };
}

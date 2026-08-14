import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  buildContentSecurityPolicy,
  createCspNonce,
  readPublicSecurityConfiguration,
} from "@/lib/security-policy.server";

const publicSecurityConfiguration = readPublicSecurityConfiguration();

export function proxy(request: NextRequest) {
  const nonce = createCspNonce();
  const contentSecurityPolicy = buildContentSecurityPolicy({
    nonce,
    configuration: publicSecurityConfiguration,
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", contentSecurityPolicy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", contentSecurityPolicy);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};

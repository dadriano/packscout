import path from "node:path";
import type { NextConfig } from "next";
import { readPublicSecurityConfiguration } from "./lib/security-policy.server";

readPublicSecurityConfiguration();

export const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
];

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR || ".next",
  outputFileTracingRoot: path.join(__dirname, "..", ".."),
  // Type checking is a separate, separately-reported phase of the verification
  // gate and still fails it. Repeating it inside the bundle step found the same
  // errors twice in the same run. Do not enable this without also removing
  // `typecheck` from the gate — the gate is what makes skipping it here safe.
  // (Next 16 no longer runs ESLint during builds, so there is nothing to
  // disable on that side.)
  typescript: { ignoreBuildErrors: true },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;

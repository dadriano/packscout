import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { AuthProviderBoundary } from "@/components/auth/AuthProviderBoundary.client";
import { resolvePublicAuthConfiguration } from "@/components/auth/auth-config";
import { AppShell } from "@/components/shell/AppShell";
import {
  resolveVisitorAccess,
  shellSurfaceForDecision,
} from "@/lib/access-gate.server";
import { readPublicConvexOrigin } from "@/lib/security-policy.server";
import { THEME_BOOTSTRAP_SCRIPT } from "@/lib/theme-bootstrap";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "PackScout",
    template: "%s · PackScout",
  },
  description:
    "Explore collectible repack listings with transparent expected-value context.",
  applicationName: "PackScout",
  icons: {
    icon: "/favicon.ico",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "light dark",
  themeColor: "#f8f9fc",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const configuration = resolvePublicAuthConfiguration({
    privyAppId: process.env.NEXT_PUBLIC_PRIVY_APP_ID,
    convexUrl: readPublicConvexOrigin() ?? undefined,
  });
  // The same request-scoped resolution the page consumes (React cache dedupes
  // the two), so the shell's first paint already wears the right face:
  // product chrome for visitors the product renders for, the pared-back
  // gateway shell around the landing and holding surfaces.
  const initialSurface = shellSurfaceForDecision(await resolveVisitorAccess());

  return (
    <html data-scroll-behavior="smooth" lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }}
          id="packscout-theme-bootstrap"
          nonce={nonce}
          suppressHydrationWarning
        />
      </head>
      <body>
        <AuthProviderBoundary configuration={configuration} nonce={nonce}>
          <AppShell initialSurface={initialSurface}>{children}</AppShell>
        </AuthProviderBoundary>
      </body>
    </html>
  );
}

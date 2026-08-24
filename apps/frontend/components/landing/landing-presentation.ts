import type { PackScoutAuthStatus } from "@/components/auth/AuthContext.client";

/**
 * What the landing page's single access action looks like for each
 * authentication state.
 *
 * The landing surface offers exactly one thing to do, and this module decides
 * what that one thing is. It reads only the frontend authentication status —
 * never the admission decision, which belongs to closed-beta-access/007 and
 * 008 — so the mapping is deliberately coarse:
 *
 * - A signed-out visitor gets the sign-in command. That sign-in is the access
 *   request; there is no other form.
 * - A visitor whose session is being established sees the same slot busy.
 *   The status is "loading" both while a returning session boots the
 *   provider and after an explicit sign-in click, so the label claims
 *   nothing about which one is happening.
 * - A signed-in visitor is never offered a second sign-in. They get a
 *   navigation into the product instead, where the root route decides what
 *   their access actually is. The same applies to a session the product
 *   could not verify — signing in again cannot repair an established but
 *   unverifiable session, so the way out is the account menu inside.
 * - When authentication is not configured at all, the action says so plainly
 *   instead of dangling a dead button.
 *
 * Every kind renders in the same reserved slot, so the provider's arrival
 * changes words, not layout.
 */

export type LandingAccessAction =
  | Readonly<{ kind: "sign_in"; label: string; note: string }>
  | Readonly<{ kind: "busy"; label: string; note: string }>
  | Readonly<{ kind: "enter"; label: string; href: "/"; note: string }>
  | Readonly<{ kind: "unavailable"; label: string; note: string }>;

export function presentLandingAccessAction(
  status: PackScoutAuthStatus,
): LandingAccessAction {
  switch (status) {
    case "signed_out":
      return {
        kind: "sign_in",
        label: "Sign in to request access",
        note:
          "Opens PackScout's hosted wallet and social sign-in. Your sign-in " +
          "is the access request — there is nothing else to fill in.",
      };
    case "loading":
      return {
        kind: "busy",
        label: "Checking sign-in…",
        note: "Give it a moment while sign-in gets ready.",
      };
    case "signed_in":
      return {
        kind: "enter",
        label: "Continue to PackScout",
        href: "/",
        note:
          "You are already signed in — no second sign-in needed. Continue " +
          "to see where things stand.",
      };
    case "error":
      return {
        kind: "enter",
        label: "Continue to PackScout",
        href: "/",
        note:
          "Your session could not be verified. Continue and use the account " +
          "menu to sign out, then try signing in again.",
      };
    case "unavailable":
      return {
        kind: "unavailable",
        label: "Sign-in unavailable",
        note:
          "Sign-in is not available right now, so access requests are " +
          "paused. Please check back soon.",
      };
  }
}

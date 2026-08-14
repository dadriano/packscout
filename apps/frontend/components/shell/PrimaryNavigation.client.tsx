"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { resolveGlobalDestination } from "@/lib/shell-navigation.client";

export function PrimaryNavigation() {
  const pathname = usePathname();
  const destination = resolveGlobalDestination(pathname);

  return (
    <nav className="primary-navigation" aria-label="Primary navigation">
      <Link
        aria-current={destination === "dashboard" ? "page" : undefined}
        className="primary-navigation__link"
        href="/"
      >
        Dashboard
      </Link>
      <Link
        aria-current={destination === "learn" ? "page" : undefined}
        className="primary-navigation__link"
        href="/learn"
      >
        Learn
      </Link>
    </nav>
  );
}

"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import {
  catalogSearchHref,
  shouldFocusCatalogSearch,
} from "@/lib/shell-navigation.client";

function SearchIcon() {
  return (
    <svg
      aria-hidden="true"
      className="catalog-search__icon"
      fill="none"
      height="17"
      viewBox="0 0 20 20"
      width="17"
    >
      <circle cx="8.75" cy="8.75" r="5.75" stroke="currentColor" strokeWidth="1.6" />
      <path d="m13 13 4 4" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
    </svg>
  );
}

export function CatalogSearch() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initialQuery = pathname === "/packs" ? (searchParams.get("q") ?? "") : "";

  return (
    <CatalogSearchForm
      initialQuery={initialQuery}
      key={`${pathname}:${initialQuery}`}
    />
  );
}

function CatalogSearchForm({ initialQuery }: { initialQuery: string }) {
  const router = useRouter();
  const fieldRef = useRef<HTMLInputElement>(null);
  const [isPending, startTransition] = useTransition();
  const [query, setQuery] = useState(initialQuery);

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if (!shouldFocusCatalogSearch(event)) return;
      event.preventDefault();
      fieldRef.current?.focus();
      fieldRef.current?.select();
    }

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  function openResults() {
    const href = catalogSearchHref(query);
    startTransition(() => router.push(href));
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    openResults();
  }

  function handleFieldKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    openResults();
  }

  return (
    <form
      aria-busy={isPending}
      className="catalog-search"
      data-pending={isPending}
      onSubmit={submitSearch}
      role="search"
    >
      <div className="catalog-search__control">
        <SearchIcon />
        <label className="catalog-search__label" htmlFor="global-catalog-search">
          Search repacks
        </label>
        <input
          aria-keyshortcuts="Meta+K Control+K"
          autoComplete="off"
          className="catalog-search__field"
          id="global-catalog-search"
          maxLength={120}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleFieldKeyDown}
        placeholder="Search repacks, vendors, categories…"
          ref={fieldRef}
          type="search"
          value={query}
        />
        <span aria-hidden="true" className="catalog-search__shortcut">
          ⌘K
        </span>
      </div>
      <button className="sr-only" onClick={openResults} type="button">
        Search catalog
      </button>
      <span className="sr-only" aria-live="polite">
        {isPending ? "Opening All Repacks results" : ""}
      </span>
    </form>
  );
}

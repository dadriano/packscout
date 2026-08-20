"use client";

import { useEffect, useId, useRef, useState } from "react";
import type {
  PublicCollectible,
  PublicCollectibleDisplay,
} from "@packscout/contracts";
import { SavedCollectibleButton } from "@/components/auth/SavedItemButton.client";
import {
  formatCollectibleDescriptor,
  formatCollectibleIdentity,
} from "@/lib/collectible-identity";
import { shouldApplyDesiredCollectibleSearchResults } from "@/lib/desired-collectible-search-ui";
import styles from "./DesiredCollectibleSearch.module.css";

type CollectibleOption = Pick<
  PublicCollectible,
  | "publicCollectibleId"
  | "name"
  | "collectibleType"
  | "year"
  | "brand"
  | "setOrSeries"
  | "cardNumber"
  | "referenceNumber"
  | "grade"
  | "grader"
>;

type DesiredCollectibleSearchProps = Readonly<{
  selected: PublicCollectibleDisplay | null;
  pending?: boolean;
  onSelect: (publicCollectibleId: string | null) => void;
}>;

function readOptions(input: unknown): readonly CollectibleOption[] | null {
  if (typeof input !== "object" || input === null || !("ok" in input)) return null;
  const result = input as {
    ok?: unknown;
    data?: { matches?: unknown };
  };
  if (result.ok !== true || !Array.isArray(result.data?.matches)) return null;
  const options: CollectibleOption[] = [];
  for (const match of result.data.matches) {
    if (
      typeof match !== "object" ||
      match === null ||
      !("publicCollectibleId" in match) ||
      !("name" in match) ||
      !("collectibleType" in match) ||
      !("year" in match) ||
      !("brand" in match) ||
      !("setOrSeries" in match) ||
      !("cardNumber" in match) ||
      !("referenceNumber" in match) ||
      !("grade" in match) ||
      !("grader" in match) ||
      typeof match.publicCollectibleId !== "string" ||
      typeof match.name !== "string" ||
      typeof match.collectibleType !== "string" ||
      (match.year !== null && typeof match.year !== "number") ||
      [
        match.brand,
        match.setOrSeries,
        match.cardNumber,
        match.referenceNumber,
        match.grade,
        match.grader,
      ].some((value) => value !== null && typeof value !== "string")
    ) {
      return null;
    }
    options.push({
      publicCollectibleId: match.publicCollectibleId,
      name: match.name,
      collectibleType: match.collectibleType as PublicCollectible["collectibleType"],
      year: match.year as number | null,
      brand: match.brand as string | null,
      setOrSeries: match.setOrSeries as string | null,
      cardNumber: match.cardNumber as string | null,
      referenceNumber: match.referenceNumber as string | null,
      grade: match.grade as string | null,
      grader: match.grader as string | null,
    });
  }
  return options;
}

export function DesiredCollectibleSearch({
  selected,
  pending = false,
  onSelect,
}: DesiredCollectibleSearchProps) {
  const id = useId();
  const listboxId = `${id}-listbox`;
  const statusId = `${id}-status`;
  const rootRef = useRef<HTMLDivElement>(null);
  const searchControllerRef = useRef<AbortController | null>(null);
  const dismissedRef = useRef(false);
  const [search, setSearch] = useState(selected?.name ?? "");
  const [options, setOptions] = useState<readonly CollectibleOption[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "failed">(
    "idle",
  );
  const normalized = search.trim();
  const exactSelectedName = selected?.name === search;
  const searchable = normalized.length >= 2 && !exactSelectedName;
  const visibleOptions = searchable ? options : [];
  const open = visibleOptions.length > 0;
  const selectedIdentity = selected === null
    ? null
    : formatCollectibleIdentity(selected);

  useEffect(() => {
    if (!searchable) return;
    dismissedRef.current = false;
    const controller = new AbortController();
    searchControllerRef.current = controller;
    const timeout = window.setTimeout(() => {
      if (
        !shouldApplyDesiredCollectibleSearchResults({
          aborted: controller.signal.aborted,
          dismissed: dismissedRef.current,
        })
      ) {
        return;
      }
      setStatus("loading");
      void fetch(`/api/collectibles/search?q=${encodeURIComponent(normalized)}`, {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) return null;
          return readOptions(await response.json());
        })
        .then((matches) => {
          if (
            !shouldApplyDesiredCollectibleSearchResults({
              aborted: controller.signal.aborted,
              dismissed: dismissedRef.current,
            })
          ) {
            return;
          }
          if (matches === null) {
            setOptions([]);
            setStatus("failed");
            return;
          }
          setOptions(matches);
          setActiveIndex(matches.length > 0 ? 0 : -1);
          setStatus("ready");
        })
        .catch(() => {
          if (
            !shouldApplyDesiredCollectibleSearchResults({
              aborted: controller.signal.aborted,
              dismissed: dismissedRef.current,
            })
          ) {
            return;
          }
          setOptions([]);
          setStatus("failed");
        });
    }, 220);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
      if (searchControllerRef.current === controller) {
        searchControllerRef.current = null;
      }
    };
  }, [normalized, searchable]);

  function closeOptions() {
    dismissedRef.current = true;
    searchControllerRef.current?.abort();
    searchControllerRef.current = null;
    setOptions([]);
    setActiveIndex(-1);
    setStatus("idle");
  }

  useEffect(() => {
    if (!open) return;
    function closeOnOutsidePress(event: PointerEvent) {
      const root = rootRef.current;
      if (
        event.target instanceof Node &&
        root?.contains(event.target)
      ) {
        return;
      }
      closeOptions();
    }
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePress);
  }, [open]);

  function choose(option: CollectibleOption) {
    closeOptions();
    setSearch(option.name);
    onSelect(option.publicCollectibleId);
  }

  const statusCopy = !searchable && !selected
    ? "Type at least 2 characters, then choose an exact collectible."
    : status === "loading"
    ? "Searching collectibles…"
    : status === "failed"
      ? "Collectible search is temporarily unavailable."
      : status === "ready" && options.length === 0
        ? "No collectible matches found."
        : exactSelectedName && selected
          ? `Selected desired chase: ${selectedIdentity}.`
          : selected
            ? `Current desired chase remains ${selectedIdentity} until you choose a replacement or clear it.`
          : "Choose an exact collectible from the results.";

  return (
    <div className={styles.root} ref={rootRef}>
      <label className={styles.label} htmlFor={`${id}-input`}>
        Desired chase collectible
      </label>
      <div className={styles.control}>
        <input
          aria-activedescendant={
            open && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined
          }
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-describedby={statusId}
          aria-expanded={open}
          autoComplete="off"
          disabled={pending}
          id={`${id}-input`}
          maxLength={120}
          onChange={(event) => setSearch(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (!open) return;
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActiveIndex((index) => (index + 1) % visibleOptions.length);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex((index) =>
                index <= 0 ? visibleOptions.length - 1 : index - 1,
              );
            } else if (event.key === "Enter" && activeIndex >= 0) {
              event.preventDefault();
              choose(visibleOptions[activeIndex]!);
            } else if (event.key === "Escape") {
              closeOptions();
            }
          }}
          placeholder="Search a card, watch, coin, or collectible"
          role="combobox"
          type="search"
          value={search}
        />
        {selected ? (
          <button
            className={styles.clear}
            disabled={pending}
            onClick={() => {
              setSearch("");
              closeOptions();
              onSelect(null);
            }}
            type="button"
          >
            Clear
          </button>
        ) : null}
      </div>
      <p aria-live="polite" className={styles.status} id={statusId} role="status">
        {statusCopy}
      </p>
      {selected ? (
        <div className={styles.saveAction}>
          <SavedCollectibleButton
            publicCollectibleId={selected.publicCollectibleId}
          />
        </div>
      ) : null}
      {open ? (
        <ul className={styles.listbox} id={listboxId} role="listbox">
          {visibleOptions.map((option, index) => (
            <li
              aria-selected={index === activeIndex}
              className={styles.option}
              data-active={index === activeIndex ? "true" : "false"}
              id={`${id}-option-${index}`}
              key={option.publicCollectibleId}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(option)}
              role="option"
            >
              <strong>{option.name}</strong>
              <span>{formatCollectibleDescriptor(option)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

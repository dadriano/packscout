"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  PUBLIC_REPACK_PRICE_MAX_MINOR,
  PUBLIC_REPACK_PRICE_MIN_MINOR,
  type ContextualRepackFacets,
  type PublicRepackFilters,
} from "@packscout/contracts";
import {
  PRICE_FILTER_MAX_DOLLARS,
  PRICE_FILTER_MIN_DOLLARS,
  PRICE_FILTER_SLIDER_MAX_INDEX,
  PRICE_FILTER_SLIDER_MIN_INDEX,
  categoryFacetRows,
  clampPriceFilter,
  closerPriceThumb,
  focusPriceSliderThumb,
  formatFilterPrice,
  priceSliderIndexForBound,
  priceSliderIndexFromKeyboard,
  priceSliderPercent,
  priceSliderValueFromIndex,
  roundPriceFilterDollars,
  sliderValueFromPointer,
} from "./catalog-filters-presentation";
import styles from "./CatalogFilters.module.css";

type CatalogFiltersProps = Readonly<{
  accepted: PublicRepackFilters;
  facets: ContextualRepackFacets;
  pending?: boolean;
  showAvailabilityToggle?: boolean;
  onApply: (filters: PublicRepackFilters) => void;
  onReset: () => void;
}>;

function dollars(minorUnits: number): number {
  return roundPriceFilterDollars(minorUnits / 100);
}

function selectionSummary(values: readonly string[], fallback: string): string {
  if (values.length === 0) return fallback;
  if (values.length === 1) return "1 selected";
  return `${values.length} selected`;
}

function ApplyIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="14" viewBox="0 0 16 16" width="14">
      <path
        d="M3.5 8.2 6.6 11.3 12.5 4.8"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
    </svg>
  );
}

function ResetIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="14" viewBox="0 0 16 16" width="14">
      <path
        d="M3.2 8a4.8 4.8 0 0 1 8.1-3.4M12.8 8A4.8 4.8 0 0 1 4.7 11.4M3.2 3.6V8h4.4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.4"
      />
    </svg>
  );
}

function ClearFiltersIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="14" viewBox="0 0 16 16" width="14">
      <path
        d="M4 4l8 8M12 4 4 12"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </svg>
  );
}

function hasChosenFilters(filters: PublicRepackFilters): boolean {
  return (
    filters.vendors.length > 0 ||
    filters.categories.length > 0 ||
    filters.collectibleTypes.length > 0 ||
    filters.availability === "all" ||
    filters.price.mode === "narrowed"
  );
}

function draftStatusMessage(
  valid: boolean,
  changed: boolean,
  accepted: PublicRepackFilters,
): string {
  if (!valid) return "Enter a valid $1–$12,000 range.";
  if (changed) return "Filters have unapplied changes.";
  if (accepted.price.mode === "full") {
    return "Full price range includes repacks without a USD comparison price.";
  }
  return "Narrowed price range excludes repacks without a USD comparison price.";
}

function CatalogFiltersDraft({
  accepted,
  facets,
  pending = false,
  showAvailabilityToggle = true,
  onApply,
  onReset,
}: CatalogFiltersProps) {
  const [vendors, setVendors] = useState<readonly string[]>(accepted.vendors);
  const [categories, setCategories] = useState<readonly string[]>(accepted.categories);
  const [collectibleTypes, setCollectibleTypes] = useState<readonly string[]>(
    accepted.collectibleTypes,
  );
  const [availability, setAvailability] = useState<PublicRepackFilters["availability"]>(
    accepted.availability,
  );
  const [minimum, setMinimum] = useState(dollars(accepted.price.minMinor));
  const [maximum, setMaximum] = useState(dollars(accepted.price.maxMinor));
  const [activeThumb, setActiveThumb] = useState<"min" | "max">("max");
  const draggedThumbRef = useRef<"min" | "max" | null>(null);
  const minimumRangeRef = useRef<HTMLInputElement>(null);
  const maximumRangeRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLElement>(null);

  useEffect(() => {
    function closeOpenDisclosures(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      rootRef.current
        ?.querySelectorAll<HTMLDetailsElement>("details[open]")
        .forEach((details) => {
          if (!details.contains(target)) {
            details.open = false;
          }
        });
    }

    document.addEventListener("pointerdown", closeOpenDisclosures);
    return () => document.removeEventListener("pointerdown", closeOpenDisclosures);
  }, []);

  function handleDisclosureToggle(event: React.SyntheticEvent<HTMLDetailsElement>) {
    const current = event.currentTarget;
    if (!current.open) return;
    rootRef.current
      ?.querySelectorAll<HTMLDetailsElement>("details[open]")
      .forEach((details) => {
        if (details !== current) {
          details.open = false;
        }
      });
  }

  const draft = useMemo<PublicRepackFilters>(() => {
    const minMinor = Math.round(minimum * 100);
    const maxMinor = Math.round(maximum * 100);
    const full =
      minMinor === PUBLIC_REPACK_PRICE_MIN_MINOR &&
      maxMinor === PUBLIC_REPACK_PRICE_MAX_MINOR;
    return {
      vendors: [...vendors].sort(),
      categories: [...categories].sort(),
      collectibleTypes: [...collectibleTypes].sort() as PublicRepackFilters["collectibleTypes"],
      availability,
      price: full
        ? { mode: "full", minMinor, maxMinor }
        : { mode: "narrowed", minMinor, maxMinor },
    };
  }, [availability, categories, collectibleTypes, maximum, minimum, vendors]);

  const valid =
    Number.isFinite(minimum) &&
    Number.isFinite(maximum) &&
    minimum >= PUBLIC_REPACK_PRICE_MIN_MINOR / 100 &&
    maximum <= PUBLIC_REPACK_PRICE_MAX_MINOR / 100 &&
    minimum <= maximum;
  const changed = JSON.stringify(draft) !== JSON.stringify(accepted);
  const hasFilters = hasChosenFilters(draft);
  const statusMessage = draftStatusMessage(valid, changed, accepted);
  const nestedCategories = useMemo(
    () => categoryFacetRows(facets.categories),
    [facets.categories],
  );
  const minPercent = valid ? priceSliderPercent(minimum) : 0;
  const maxPercent = valid ? priceSliderPercent(maximum) : 100;

  function toggle(
    key: string,
    selected: readonly string[],
    update: (values: readonly string[]) => void,
  ) {
    update(
      selected.includes(key)
        ? selected.filter((value) => value !== key)
        : [...selected, key].sort(),
    );
  }

  function updateSliderThumb(
    thumb: "min" | "max",
    clientX: number,
    track: DOMRect,
  ) {
    const pointerValue = sliderValueFromPointer(clientX, track.left, track.width);
    if (thumb === "min") {
      setMinimum(clampPriceFilter(pointerValue, "min", maximum));
    } else {
      setMaximum(clampPriceFilter(pointerValue, "max", minimum));
    }
  }

  function handleSliderPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.target instanceof HTMLInputElement) return;
    const track = event.currentTarget.getBoundingClientRect();
    const pointerValue = sliderValueFromPointer(event.clientX, track.left, track.width);
    const thumb = closerPriceThumb(
      pointerValue,
      Number.isFinite(minimum) ? minimum : PRICE_FILTER_MIN_DOLLARS,
      Number.isFinite(maximum) ? maximum : PRICE_FILTER_MAX_DOLLARS,
    );
    focusPriceSliderThumb(thumb, minimumRangeRef.current, maximumRangeRef.current);
    draggedThumbRef.current = thumb;
    setActiveThumb(thumb);
    updateSliderThumb(thumb, event.clientX, track);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function handleSliderPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const thumb = draggedThumbRef.current;
    if (thumb === null) return;
    updateSliderThumb(
      thumb,
      event.clientX,
      event.currentTarget.getBoundingClientRect(),
    );
    event.preventDefault();
  }

  function handleSliderPointerEnd(event: React.PointerEvent<HTMLDivElement>) {
    if (draggedThumbRef.current === null) return;
    draggedThumbRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleSliderKeyDown(
    thumb: "min" | "max",
    event: React.KeyboardEvent<HTMLInputElement>,
  ) {
    const currentValue = thumb === "min" ? minimum : maximum;
    const nextIndex = priceSliderIndexFromKeyboard(
      event.key,
      priceSliderIndexForBound(currentValue, thumb),
    );
    if (nextIndex === null) return;

    event.preventDefault();
    setActiveThumb(thumb);
    const nextValue = priceSliderValueFromIndex(nextIndex);
    if (thumb === "min") {
      setMinimum(clampPriceFilter(nextValue, "min", maximum));
    } else {
      setMaximum(clampPriceFilter(nextValue, "max", minimum));
    }
  }

  return (
    <section aria-label="Catalog filters" className={styles.root} ref={rootRef}>
      <div className={styles.filterGrid}>
        <details className={styles.disclosure} onToggle={handleDisclosureToggle}>
          <summary>
            <span><span className={styles.label}>Vendor</span>{selectionSummary(vendors, "All vendors")}</span>
            <span aria-hidden="true">⌄</span>
          </summary>
          <fieldset className={styles.options}>
            <legend className="sr-only">Select vendors</legend>
            {facets.vendors.map((facet) => (
              <label key={facet.key}>
                <input
                  checked={vendors.includes(facet.key)}
                  onChange={() => toggle(facet.key, vendors, setVendors)}
                  type="checkbox"
                />
                <span>{facet.label}</span>
                <span className={styles.count}>{facet.repackCount}</span>
              </label>
            ))}
          </fieldset>
        </details>

        <details className={styles.disclosure} onToggle={handleDisclosureToggle}>
          <summary>
            <span><span className={styles.label}>Category</span>{selectionSummary(categories, "All categories")}</span>
            <span aria-hidden="true">⌄</span>
          </summary>
          <fieldset className={`${styles.options} ${styles.categoryOptions}`}>
            <legend className="sr-only">Select categories</legend>
            {nestedCategories.map(({ option, depth }) => (
              <label data-depth={Math.min(depth, 6)} key={option.key}>
                <input
                  checked={categories.includes(option.key)}
                  onChange={() => toggle(option.key, categories, setCategories)}
                  type="checkbox"
                />
                <span>{option.label}</span>
                <span className={styles.count}>{option.repackCount}</span>
              </label>
            ))}
          </fieldset>
        </details>

        <details className={styles.disclosure} onToggle={handleDisclosureToggle}>
          <summary>
            <span><span className={styles.label}>Collectible type</span>{selectionSummary(collectibleTypes, "All types")}</span>
            <span aria-hidden="true">⌄</span>
          </summary>
          <fieldset className={styles.options}>
            <legend className="sr-only">Select collectible types</legend>
            {facets.collectibleTypes.map((facet) => (
              <label key={facet.key}>
                <input
                  checked={collectibleTypes.includes(facet.key)}
                  onChange={() => toggle(facet.key, collectibleTypes, setCollectibleTypes)}
                  type="checkbox"
                />
                <span>{facet.label}</span>
                <span className={styles.count}>{facet.repackCount}</span>
              </label>
            ))}
          </fieldset>
        </details>

        <fieldset
          aria-describedby="catalog-filter-status"
          className={styles.priceGroup}
          style={{
            ["--price-min" as string]: String(minPercent),
            ["--price-max" as string]: String(maxPercent),
          }}
        >
          <legend className={styles.label}>Repack Price</legend>
          <div className={styles.sliderRow}>
            <div
              className={styles.slider}
              onPointerCancel={handleSliderPointerEnd}
              onPointerDown={handleSliderPointerDown}
              onPointerMove={handleSliderPointerMove}
              onPointerUp={handleSliderPointerEnd}
            >
              <div aria-hidden="true" className={styles.sliderTrack} />
              <input
                aria-invalid={!valid}
                aria-label="Minimum repack price"
                aria-valuetext={formatFilterPrice(minimum)}
                className={styles.minRange}
                data-active={activeThumb === "min" ? "true" : undefined}
                max={PRICE_FILTER_SLIDER_MAX_INDEX}
                min={PRICE_FILTER_SLIDER_MIN_INDEX}
                onKeyDown={(event) => handleSliderKeyDown("min", event)}
                onPointerDown={() => setActiveThumb("min")}
                ref={minimumRangeRef}
                onChange={(event) => {
                  setActiveThumb("min");
                  setMinimum(clampPriceFilter(
                    priceSliderValueFromIndex(event.currentTarget.valueAsNumber),
                    "min",
                    maximum,
                  ));
                }}
                step="1"
                type="range"
                value={priceSliderIndexForBound(minimum, "min")}
              />
              <input
                aria-invalid={!valid}
                aria-label="Maximum repack price"
                aria-valuetext={formatFilterPrice(maximum)}
                className={styles.maxRange}
                data-active={activeThumb === "max" ? "true" : undefined}
                max={PRICE_FILTER_SLIDER_MAX_INDEX}
                min={PRICE_FILTER_SLIDER_MIN_INDEX}
                onKeyDown={(event) => handleSliderKeyDown("max", event)}
                onPointerDown={() => setActiveThumb("max")}
                ref={maximumRangeRef}
                onChange={(event) => {
                  setActiveThumb("max");
                  setMaximum(clampPriceFilter(
                    priceSliderValueFromIndex(event.currentTarget.valueAsNumber),
                    "max",
                    minimum,
                  ));
                }}
                step="1"
                type="range"
                value={priceSliderIndexForBound(maximum, "max")}
              />
            </div>
            <div className={styles.priceFields}>
              <label className={styles.priceField}>
                <span className="sr-only">Minimum repack price in dollars</span>
                <span aria-hidden="true">$</span>
                <input
                  aria-invalid={!valid}
                  inputMode="numeric"
                  max={PRICE_FILTER_MAX_DOLLARS}
                  min={PRICE_FILTER_MIN_DOLLARS}
                  onChange={(event) =>
                    setMinimum(roundPriceFilterDollars(event.currentTarget.valueAsNumber))
                  }
                  step="1"
                  type="number"
                  value={Number.isFinite(minimum) ? minimum : ""}
                />
              </label>
              <label className={styles.priceField}>
                <span className="sr-only">Maximum repack price in dollars</span>
                <span aria-hidden="true">$</span>
                <input
                  aria-invalid={!valid}
                  inputMode="numeric"
                  max={PRICE_FILTER_MAX_DOLLARS}
                  min={PRICE_FILTER_MIN_DOLLARS}
                  onChange={(event) =>
                    setMaximum(roundPriceFilterDollars(event.currentTarget.valueAsNumber))
                  }
                  step="1"
                  type="number"
                  value={Number.isFinite(maximum) ? maximum : ""}
                />
              </label>
            </div>
          </div>
        </fieldset>

        <div className={styles.actionGroup}>
          <button
            aria-label={pending ? "Applying filters" : "Apply filters"}
            className={styles.apply}
            disabled={!valid || !changed || pending}
            onClick={() => onApply(draft)}
            title={pending ? "Applying filters" : "Apply filters"}
            type="button"
          >
            <ApplyIcon />
          </button>
          <button
            aria-label={hasFilters ? "Clear selected filters" : "Reset filters"}
            className={styles.reset}
            data-has-filters={hasFilters ? "true" : undefined}
            disabled={pending}
            onClick={onReset}
            title={hasFilters ? "Clear selected filters" : "Reset filters"}
            type="button"
          >
            {hasFilters ? <ClearFiltersIcon /> : <ResetIcon />}
          </button>
        </div>
      </div>

      {showAvailabilityToggle ? (
        <div className={styles.footerRow}>
          <label className={styles.availabilityToggle}>
            <input
              checked={availability === "all"}
              onChange={(event) =>
                setAvailability(event.currentTarget.checked ? "all" : "available")
              }
              type="checkbox"
            />
            <span>
              Include packs labeled Unavailable, Availability unknown, or Sold out
            </span>
          </label>
          <p
            aria-live="polite"
            className={!valid || changed ? styles.draftStatus : "sr-only"}
            id="catalog-filter-status"
            role="status"
          >
            {statusMessage}
          </p>
        </div>
      ) : (
        <p
          aria-live="polite"
          className={!valid || changed ? styles.draftStatus : "sr-only"}
          id="catalog-filter-status"
          role="status"
        >
          {statusMessage}
        </p>
      )}
    </section>
  );
}

export function CatalogFilters(props: CatalogFiltersProps) {
  const acceptedKey = JSON.stringify(props.accepted);
  return <CatalogFiltersDraft key={acceptedKey} {...props} />;
}

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
  categoryFacetRows,
  clampPriceFilter,
  closerPriceThumb,
  formatFilterPrice,
  sliderValueFromPointer,
} from "./catalog-filters-presentation";
import styles from "./CatalogFilters.module.css";

type CatalogFiltersProps = Readonly<{
  accepted: PublicRepackFilters;
  facets: ContextualRepackFacets;
  pending?: boolean;
  onApply: (filters: PublicRepackFilters) => void;
  onReset: () => void;
}>;

function dollars(minorUnits: number): number {
  return minorUnits / 100;
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

function draftStatusMessage(
  valid: boolean,
  changed: boolean,
  accepted: PublicRepackFilters,
): string {
  if (!valid) return "Enter a valid $10–$12,000 range.";
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
  const statusMessage = draftStatusMessage(valid, changed, accepted);
  const nestedCategories = useMemo(
    () => categoryFacetRows(facets.categories),
    [facets.categories],
  );
  const minPercent = valid
    ? ((minimum - PRICE_FILTER_MIN_DOLLARS) /
        (PRICE_FILTER_MAX_DOLLARS - PRICE_FILTER_MIN_DOLLARS)) *
      100
    : 0;
  const maxPercent = valid
    ? ((maximum - PRICE_FILTER_MIN_DOLLARS) /
        (PRICE_FILTER_MAX_DOLLARS - PRICE_FILTER_MIN_DOLLARS)) *
      100
    : 100;

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

  function handleSliderPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    const track = event.currentTarget.getBoundingClientRect();
    const pointerValue = sliderValueFromPointer(event.clientX, track.left, track.width);
    setActiveThumb(
      closerPriceThumb(
        pointerValue,
        Number.isFinite(minimum) ? minimum : PRICE_FILTER_MIN_DOLLARS,
        Number.isFinite(maximum) ? maximum : PRICE_FILTER_MAX_DOLLARS,
      ),
    );
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
            <label className={styles.priceField}>
              <span className="sr-only">Minimum repack price in dollars</span>
              <span aria-hidden="true">$</span>
              <input
                inputMode="decimal"
                max={PRICE_FILTER_MAX_DOLLARS}
                min={PRICE_FILTER_MIN_DOLLARS}
                onChange={(event) => setMinimum(event.currentTarget.valueAsNumber)}
                step="0.01"
                type="number"
                value={Number.isFinite(minimum) ? minimum : ""}
              />
            </label>
            <div
              className={styles.slider}
              onPointerDown={handleSliderPointerDown}
            >
              <div aria-hidden="true" className={styles.sliderTrack} />
              <input
                aria-label="Minimum repack price"
                aria-valuetext={formatFilterPrice(minimum)}
                className={styles.minRange}
                data-active={activeThumb === "min" ? "true" : undefined}
                max={PRICE_FILTER_MAX_DOLLARS}
                min={PRICE_FILTER_MIN_DOLLARS}
                onPointerDown={() => setActiveThumb("min")}
                onChange={(event) => {
                  setActiveThumb("min");
                  setMinimum(clampPriceFilter(event.currentTarget.valueAsNumber, "min", maximum));
                }}
                step="1"
                type="range"
                value={Number.isFinite(minimum) ? minimum : PRICE_FILTER_MIN_DOLLARS}
              />
              <input
                aria-invalid={!valid}
                aria-label="Maximum repack price"
                aria-valuetext={formatFilterPrice(maximum)}
                className={styles.maxRange}
                data-active={activeThumb === "max" ? "true" : undefined}
                max={PRICE_FILTER_MAX_DOLLARS}
                min={PRICE_FILTER_MIN_DOLLARS}
                onPointerDown={() => setActiveThumb("max")}
                onChange={(event) => {
                  setActiveThumb("max");
                  setMaximum(clampPriceFilter(event.currentTarget.valueAsNumber, "max", minimum));
                }}
                step="1"
                type="range"
                value={Number.isFinite(maximum) ? maximum : PRICE_FILTER_MAX_DOLLARS}
              />
            </div>
            <label className={styles.priceField}>
              <span className="sr-only">Maximum repack price in dollars</span>
              <span aria-hidden="true">$</span>
              <input
                aria-invalid={!valid}
                inputMode="decimal"
                max={PRICE_FILTER_MAX_DOLLARS}
                min={PRICE_FILTER_MIN_DOLLARS}
                onChange={(event) => setMaximum(event.currentTarget.valueAsNumber)}
                step="0.01"
                type="number"
                value={Number.isFinite(maximum) ? maximum : ""}
              />
            </label>
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
            aria-label="Reset filters"
            className={styles.reset}
            disabled={pending}
            onClick={onReset}
            title="Reset filters"
            type="button"
          >
            <ResetIcon />
          </button>
        </div>
      </div>

      <div className={styles.footerRow}>
        <label className={styles.availabilityToggle}>
          <input
            checked={availability === "all"}
            onChange={(event) =>
              setAvailability(event.currentTarget.checked ? "all" : "active")
            }
            type="checkbox"
          />
          <span>Include sold out</span>
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
    </section>
  );
}

export function CatalogFilters(props: CatalogFiltersProps) {
  const acceptedKey = JSON.stringify(props.accepted);
  return <CatalogFiltersDraft key={acceptedKey} {...props} />;
}

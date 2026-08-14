"use client";

import { useMemo, useState } from "react";
import {
  PUBLIC_REPACK_PRICE_MAX_MINOR,
  PUBLIC_REPACK_PRICE_MIN_MINOR,
  type ContextualRepackFacets,
  type PublicRepackFilters,
} from "@packscout/contracts";
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
  const [minimum, setMinimum] = useState(dollars(accepted.price.minMinor));
  const [maximum, setMaximum] = useState(dollars(accepted.price.maxMinor));

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
      price: full
        ? { mode: "full", minMinor, maxMinor }
        : { mode: "narrowed", minMinor, maxMinor },
    };
  }, [categories, collectibleTypes, maximum, minimum, vendors]);

  const valid =
    Number.isFinite(minimum) &&
    Number.isFinite(maximum) &&
    minimum >= PUBLIC_REPACK_PRICE_MIN_MINOR / 100 &&
    maximum <= PUBLIC_REPACK_PRICE_MAX_MINOR / 100 &&
    minimum <= maximum;
  const changed = JSON.stringify(draft) !== JSON.stringify(accepted);

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

  return (
    <section aria-label="Catalog filters" className={styles.root}>
      <div className={styles.filterGrid}>
        <details className={styles.disclosure}>
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

        <details className={styles.disclosure}>
          <summary>
            <span><span className={styles.label}>Category</span>{selectionSummary(categories, "All categories")}</span>
            <span aria-hidden="true">⌄</span>
          </summary>
          <fieldset className={styles.options}>
            <legend className="sr-only">Select categories</legend>
            {facets.categories.map((facet) => (
              <label key={facet.key}>
                <input
                  checked={categories.includes(facet.key)}
                  onChange={() => toggle(facet.key, categories, setCategories)}
                  type="checkbox"
                />
                <span>{facet.label}</span>
                <span className={styles.count}>{facet.repackCount}</span>
              </label>
            ))}
          </fieldset>
        </details>

        <details className={styles.disclosure}>
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

        <fieldset aria-describedby="catalog-price-help" className={styles.priceGroup}>
          <legend className={styles.label}>Repack Price</legend>
          <label>
            <span className="sr-only">Minimum repack price in dollars</span>
            <span aria-hidden="true">$</span>
            <input
              inputMode="decimal"
              max={PUBLIC_REPACK_PRICE_MAX_MINOR / 100}
              min={PUBLIC_REPACK_PRICE_MIN_MINOR / 100}
              onChange={(event) => setMinimum(event.currentTarget.valueAsNumber)}
              step="0.01"
              type="number"
              value={Number.isFinite(minimum) ? minimum : ""}
            />
          </label>
          <span aria-hidden="true">–</span>
          <label>
            <span className="sr-only">Maximum repack price in dollars</span>
            <span aria-hidden="true">$</span>
            <input
              aria-invalid={!valid}
              inputMode="decimal"
              max={PUBLIC_REPACK_PRICE_MAX_MINOR / 100}
              min={PUBLIC_REPACK_PRICE_MIN_MINOR / 100}
              onChange={(event) => setMaximum(event.currentTarget.valueAsNumber)}
              step="0.01"
              type="number"
              value={Number.isFinite(maximum) ? maximum : ""}
            />
          </label>
        </fieldset>
      </div>

      <div className={styles.actions}>
        <p className={styles.draftStatus} id="catalog-price-help">
          {!valid
            ? "Enter a valid $10–$12,000 range."
            : changed
              ? "Filters have unapplied changes."
              : accepted.price.mode === "full"
                ? "Full price range includes repacks without a USD comparison price."
                : "Narrowed price range excludes repacks without a USD comparison price."}
        </p>
        <button
          className={styles.apply}
          disabled={!valid || !changed || pending}
          onClick={() => onApply(draft)}
          type="button"
        >
          {pending ? "Applying…" : "Apply"}
        </button>
        <button className={styles.reset} disabled={pending} onClick={onReset} type="button">
          Reset
        </button>
      </div>
    </section>
  );
}

export function CatalogFilters(props: CatalogFiltersProps) {
  const acceptedKey = JSON.stringify(props.accepted);
  return <CatalogFiltersDraft key={acceptedKey} {...props} />;
}

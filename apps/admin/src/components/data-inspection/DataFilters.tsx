import { useState } from "react";
import type {
  CanonicalProviderRow,
  CanonicalProviderSummary,
} from "@packscout/contracts";
import { kindLabel } from "./kind-presentation";

/**
 * The Data section's filter bar.
 *
 * Draft-then-apply, like the catalog filters: typing does not refetch on every
 * keystroke, and the applied state is what the URL and the grid reflect. Reset
 * returns to the provider's default view rather than clearing the provider too,
 * because losing the provider is never what "reset filters" means.
 *
 * Record kind moved here from the summary cards. Cards are a good place to read
 * a number and a poor place to discover that clicking changes the table below.
 */

export interface AppliedDataFilters {
  readonly platformKey: string;
  readonly recordKind: string;
  readonly search: string;
}

export function DataFilters({
  providers,
  summary,
  applied,
  pending = false,
  onApply,
  onReset,
}: {
  providers: readonly CanonicalProviderRow[];
  summary: CanonicalProviderSummary | null;
  applied: AppliedDataFilters;
  pending?: boolean;
  onApply: (filters: AppliedDataFilters) => void;
  onReset: () => void;
}) {
  const [draft, setDraft] = useState<AppliedDataFilters>(applied);

  /**
   * The applied state is authoritative: a change from the URL, a reset, or a
   * provider switch must show up here rather than leaving a stale draft.
   *
   * Adjusted during render rather than in an effect. An effect would paint the
   * stale draft once before correcting it, and the repository's lint rule
   * refuses a synchronous set inside one.
   */
  const appliedSignature = `${applied.platformKey}|${applied.recordKind}|${applied.search}`;
  const [lastSignature, setLastSignature] = useState(appliedSignature);
  if (appliedSignature !== lastSignature) {
    setLastSignature(appliedSignature);
    setDraft(applied);
  }

  const dirty =
    draft.platformKey !== applied.platformKey ||
    draft.recordKind !== applied.recordKind ||
    draft.search !== applied.search;

  function countFor(kind: string): string {
    const entry = summary?.kinds.find((row) => row.recordKind === kind);
    if (!entry) return "";
    const value = entry.count.toLocaleString("en-US");
    return ` (${value}${entry.precision === "at_least" ? "+" : ""})`;
  }

  return (
    <form
      className="data-filters"
      aria-label="Record filters"
      onSubmit={(event) => {
        event.preventDefault();
        onApply(draft);
      }}
    >
      <label className="data-filters__field">
        <span>Provider</span>
        <select
          id="inspect-provider"
          value={draft.platformKey}
          onChange={(event) =>
            // A provider switch applies immediately: every other control is
            // scoped to it, so holding it as a draft would show counts and
            // kinds that belong to a different provider.
            onApply({ ...draft, platformKey: event.target.value, search: "" })
          }
        >
          <option value="" disabled>
            Select a provider
          </option>
          {providers.map((provider) => (
            <option key={provider.platformKey} value={provider.platformKey}>
              {provider.displayName} · {provider.state}
            </option>
          ))}
        </select>
      </label>

      <label className="data-filters__field">
        <span>Record kind</span>
        <select
          id="inspect-kind"
          value={draft.recordKind}
          disabled={!summary}
          onChange={(event) =>
            onApply({ ...draft, recordKind: event.target.value, search: "" })
          }
        >
          {(summary?.kinds ?? []).map((kind) => (
            <option key={kind.recordKind} value={kind.recordKind}>
              {kindLabel(kind.recordKind)}
              {countFor(kind.recordKind)}
            </option>
          ))}
        </select>
      </label>

      <label className="data-filters__field data-filters__field--grow">
        <span>External identifier</span>
        <input
          id="inspect-search"
          type="search"
          value={draft.search}
          placeholder="Exact id, or a leading fragment"
          onChange={(event) =>
            setDraft({ ...draft, search: event.target.value })
          }
        />
      </label>

      <div className="data-filters__actions">
        <button
          type="submit"
          className="admin-button"
          disabled={pending || !dirty}
        >
          Apply
        </button>
        <button
          type="button"
          className="admin-button admin-button-secondary"
          disabled={pending || (applied.search === "" && !dirty)}
          onClick={onReset}
        >
          Reset
        </button>
      </div>
    </form>
  );
}

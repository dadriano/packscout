import type { CanonicalProviderRow } from "@packscout/contracts";
import { Link } from "react-router-dom";

/**
 * The provider selector shared by every Data surface.
 *
 * All three surfaces name providers from the same roster and the same
 * `platformKey`, so Canonical, Published, and Compare cannot disagree about
 * which providers exist or what they are called.
 */
export function ProviderPicker({
  providers,
  selected,
  onSelect,
  crossLinks = true,
}: {
  providers: readonly CanonicalProviderRow[];
  selected: string | null;
  onSelect: (platformKey: string) => void;
  crossLinks?: boolean;
}) {
  return (
    <section className="inspect-providers" aria-labelledby="provider-picker-title">
      <header className="admin-section-header">
        <div>
          <span className="admin-kicker">Provider</span>
          <h2 id="provider-picker-title">Choose a provider</h2>
        </div>
      </header>
      <div className="inspect-providers__row">
        <label className="inspect-providers__field" htmlFor="inspect-provider">
          <span>Provider</span>
          <select
            id="inspect-provider"
            value={selected ?? ""}
            onChange={(event) => onSelect(event.target.value)}
          >
            <option value="" disabled>
              Select a provider
            </option>
            {providers.map((provider) => (
              <option key={provider.platformKey} value={provider.platformKey}>
                {provider.displayName} ({provider.platformKey}) · {provider.state}
              </option>
            ))}
          </select>
        </label>
        {crossLinks && selected ? (
          // Remediation lives on the surfaces that already own it. This page
          // only reads, so where an operator needs to act it hands them off.
          <nav className="inspect-providers__links" aria-label="Provider tools">
            <Link to="/providers">Provider configuration</Link>
            <Link to="/runs">Import runs</Link>
            <Link to="/quarantine">Quarantine</Link>
            <Link to="/background-work">Background work</Link>
          </nav>
        ) : null}
      </div>
    </section>
  );
}

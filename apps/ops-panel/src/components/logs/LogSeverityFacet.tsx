import {
  ALL_SEVERITIES,
  ERRORS_PRESET,
  isAllSeverities,
  isErrorsPreset,
  severityFacetWith,
  type SeverityFacet,
} from "../../logs/filter.ts";
import { LOG_SEVERITIES, type LogSeverity } from "../../logs/severity.ts";

/**
 * Which levels are allowed through, plus the one shortcut that matters.
 *
 * "Show me what is broken" is the question the panel is opened to answer, and
 * making an operator uncheck three boxes to ask it is friction at exactly the
 * wrong moment. The preset includes warnings deliberately: the warning is
 * usually the line that explains the error underneath it.
 */

const SEVERITY_LABEL: Readonly<Record<LogSeverity, string>> = Object.freeze({
  error: "Errors",
  warn: "Warnings",
  info: "Info",
  debug: "Debug",
  unknown: "Unclassified",
});

export interface LogSeverityFacetProps {
  facet: SeverityFacet;
  onChange: (facet: SeverityFacet) => void;
}

export function LogSeverityFacet({ facet, onChange }: LogSeverityFacetProps) {
  const errorsOnly = isErrorsPreset(facet);
  return (
    <fieldset className="panel-log-toolbar-row panel-log-fieldset">
      <legend>Severity</legend>
      {LOG_SEVERITIES.map((level) => (
        <label key={level} className="panel-log-control" data-severity={level}>
          <input
            type="checkbox"
            checked={facet[level] !== false}
            onChange={(event) =>
              onChange(severityFacetWith(facet, level, event.target.checked))
            }
          />
          {SEVERITY_LABEL[level]}
        </label>
      ))}
      <button
        type="button"
        className="panel-button"
        aria-pressed={errorsOnly}
        onClick={() => onChange(errorsOnly ? ALL_SEVERITIES : ERRORS_PRESET)}
      >
        {errorsOnly ? "Show all levels" : "Errors only"}
      </button>
      {isAllSeverities(facet) ? null : (
        <span className="panel-log-count">Severity filter active</span>
      )}
    </fieldset>
  );
}

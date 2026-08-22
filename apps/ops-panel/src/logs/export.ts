import type { FactsLookup, LogGroup, VisibleGroup } from "./line-groups.ts";

/**
 * Taking output out of the panel: to the clipboard, or to a file.
 *
 * Everything here works from *groups* rather than from rendered rows. A folded
 * stack trace is one event that happens to be drawn as one line, and copying
 * only that line would hand someone a message with no trace under it — the
 * single most annoying thing a log viewer can do. Expansion state is a display
 * choice and deliberately has no effect on what leaves the panel.
 *
 * In the unified view every line is prefixed with its service, because the
 * interleaving is the information: a paste that drops it turns two services'
 * output into one indecipherable sequence. With a single service in focus the
 * prefix is noise, so it is left off.
 *
 * The file carries a short header. An exported log usually ends up attached to
 * an issue, read by someone who was not there, and the three facts that make it
 * usable — what it covers, when it was taken, and whether a filter was hiding
 * anything — cost three lines.
 */

export interface ExportRenderOptions {
  /** Prefix each line with the service that wrote it. */
  prefixService: boolean;
}

function renderRows(
  group: LogGroup,
  facts: FactsLookup,
  { prefixService }: ExportRenderOptions,
): string[] {
  return [group.head, ...group.members].map((row) => {
    const text = facts(row).plainText;
    return prefixService ? `${row.service}  ${text}` : text;
  });
}

/** One group, whole: the head and every line folded under it. */
export function renderGroupText(
  group: LogGroup,
  facts: FactsLookup,
  options: ExportRenderOptions,
): string {
  return renderRows(group, facts, options).join("\n");
}

/** Everything the filter admits, in the order it is displayed. */
export function renderVisibleText(
  groups: readonly VisibleGroup[],
  facts: FactsLookup,
  options: ExportRenderOptions,
): string {
  return groups.flatMap((group) => renderRows(group, facts, options)).join("\n");
}

export interface ExportDocumentInput {
  groups: readonly VisibleGroup[];
  facts: FactsLookup;
  /** The focused service, or null when every visible service is included. */
  scope: string | null;
  at: Date;
  filterActive: boolean;
  matched: number;
  total: number;
}

export function renderExportDocument({
  groups,
  facts,
  scope,
  at,
  filterActive,
  matched,
  total,
}: ExportDocumentInput): string {
  const body = renderVisibleText(groups, facts, { prefixService: scope === null });
  const header = [
    `# PackScout log export — ${scope ?? "all visible services"}`,
    `# Taken ${at.toISOString()}`,
    filterActive
      ? `# Filtered: ${matched.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} buffered lines matched.`
      : `# Unfiltered: ${total.toLocaleString("en-US")} buffered lines.`,
  ];
  return `${[...header, "", ""].join("\n")}${body}\n`;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * A name that says what the file is without being opened, and that sorts.
 *
 * Local time rather than UTC: the operator matches this against a clock on the
 * same machine, and a name an hour away from what they remember is a name they
 * distrust.
 */
export function exportFileName(scope: string | null, at: Date): string {
  const stamp = [
    at.getFullYear(),
    twoDigits(at.getMonth() + 1),
    twoDigits(at.getDate()),
    "-",
    twoDigits(at.getHours()),
    twoDigits(at.getMinutes()),
    twoDigits(at.getSeconds()),
  ].join("");
  return `packscout-${scope ?? "all-services"}-${stamp}.log`;
}

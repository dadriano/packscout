import {
  PANEL_REQUEST_HEADER,
  PANEL_REQUEST_HEADER_VALUE,
  panelFetch,
  PanelRequestError,
} from "./panel-client.ts";
import {
  LOG_DOWNLOAD_PATH,
  LOG_GENERATION_CHANGED_CODE,
  LOG_HISTORY_PATH,
  type LogHistoryDirection,
  type LogHistoryPayload,
} from "./panel-types.ts";

/**
 * The browser's side of history reads.
 *
 * Two things are worth stating here rather than in each caller. A history
 * request always carries the generation the caller believes it is reading, so
 * the server can refuse rather than answer with a different file's bytes — the
 * refusal is what returns the reader to live instead of quietly inventing a
 * past. And a raw download goes through `fetch` rather than a plain link,
 * because the panel's privileged-request header cannot be attached to a
 * navigation; the file is streamed by the server and materialised by the
 * browser only at the moment it is saved.
 */

/** Lines one scrollback page asks for: a screenful several times over. */
export const HISTORY_PAGE_LINES = 300;

/** Lines a deep-search page reads at a time; larger, because none are rendered. */
export const SEARCH_PAGE_LINES = 2_000;

/** Lines of unfiltered context loaded around a search result. */
export const CONTEXT_LINES = 80;

export interface HistoryPageQuery {
  service: string;
  direction: LogHistoryDirection;
  /** Backward: read up to here. Forward: read from here. */
  cursor?: number | null;
  generation?: number | null;
  lines?: number;
}

export function historyPageUrl({
  service,
  direction,
  cursor,
  generation,
  lines,
}: HistoryPageQuery): string {
  const params = new URLSearchParams({ service, direction });
  if (cursor !== undefined && cursor !== null) params.set("cursor", String(cursor));
  if (generation !== undefined && generation !== null) {
    params.set("generation", String(generation));
  }
  if (lines !== undefined) params.set("lines", String(lines));
  return `${LOG_HISTORY_PATH}?${params.toString()}`;
}

export function fetchHistoryPage(
  query: HistoryPageQuery,
): Promise<LogHistoryPayload> {
  return panelFetch<LogHistoryPayload>(historyPageUrl(query));
}

/** True when the server refused because the file started a new generation. */
export function isGenerationChanged(error: unknown): boolean {
  return (
    error instanceof PanelRequestError && error.code === LOG_GENERATION_CHANGED_CODE
  );
}

export function rawLogUrl(service: string): string {
  return `${LOG_DOWNLOAD_PATH}?service=${encodeURIComponent(service)}`;
}

/**
 * Fetch a whole log file as an attachment. The server streams it; this is the
 * one place the panel holds a whole file at once, and only for as long as it
 * takes the browser to write it to disk.
 */
export async function fetchRawLogFile(service: string): Promise<Blob> {
  const response = await fetch(rawLogUrl(service), {
    credentials: "same-origin",
    headers: { [PANEL_REQUEST_HEADER]: PANEL_REQUEST_HEADER_VALUE },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: string; code?: string }
      | null;
    throw new PanelRequestError(
      payload?.error ?? "The panel could not download that log file.",
      response.status,
      payload?.code ?? "ops_panel_request_failed",
    );
  }
  return response.blob();
}

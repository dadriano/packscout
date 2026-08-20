import { panelStreamBudget, type StreamBudget } from "./stream-budget.ts";

/**
 * Subscribe to one of the panel's server-sent-event endpoints through the
 * shared per-tab budget. EventSource cannot attach request headers, which is
 * exactly the relaxation the server documents for stream endpoints; every
 * loopback check still applies on the server side.
 */

export interface PanelStreamOptions<T> {
  /** Budget key, for diagnosis; not sent to the server. */
  name: string;
  path: string;
  event: string;
  onMessage: (payload: T) => void;
  onOpen?: () => void;
  onError?: (error: unknown) => void;
  budget?: StreamBudget;
  createEventSource?: (path: string) => EventSource;
}

export function subscribeToPanelStream<T>({
  name,
  path,
  event,
  onMessage,
  onOpen,
  onError,
  budget = panelStreamBudget,
  createEventSource = (target) => new EventSource(target),
}: PanelStreamOptions<T>): () => void {
  let source: EventSource | undefined;

  const cancel = budget.request(name, () => {
    source = createEventSource(path);
    source.addEventListener("open", () => onOpen?.());
    source.addEventListener(event, (message) => {
      try {
        onMessage(JSON.parse((message as MessageEvent<string>).data) as T);
      } catch (error) {
        onError?.(error);
      }
    });
    source.addEventListener("error", (error) => onError?.(error));
  });

  return () => {
    source?.close();
    source = undefined;
    cancel();
  };
}

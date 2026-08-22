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
  /**
   * One event name, or several carried by the same connection. A surface that
   * needs two kinds of message subscribes once rather than opening a second
   * stream and spending another slot of the per-tab budget on the same endpoint.
   */
  event: string | readonly string[];
  onMessage: (payload: T, event: string) => void;
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

  const events = typeof event === "string" ? [event] : event;

  const cancel = budget.request(name, () => {
    source = createEventSource(path);
    source.addEventListener("open", () => onOpen?.());
    for (const eventName of events) {
      source.addEventListener(eventName, (message) => {
        try {
          onMessage(
            JSON.parse((message as MessageEvent<string>).data) as T,
            eventName,
          );
        } catch (error) {
          onError?.(error);
        }
      });
    }
    source.addEventListener("error", (error) => onError?.(error));
  });

  return () => {
    source?.close();
    source = undefined;
    cancel();
  };
}

import type { Request, Response } from "express";
import {
  createServerSentStream,
  SSE_HEADERS,
  type ServerSentStream,
} from "../core/sse.ts";

/**
 * Express adapter for the panel's server-sent-event conventions. Handlers get
 * an open stream and register their own release through `onTeardown`; the
 * connection's close event tears everything down exactly once.
 */
export function openEventStream(
  request: Request,
  response: Response,
  onTeardown?: () => void,
): ServerSentStream {
  for (const [name, value] of Object.entries(SSE_HEADERS)) {
    response.setHeader(name, value);
  }
  response.setHeader("x-content-type-options", "nosniff");
  response.flushHeaders();
  // Keep the socket alive for a long-lived stream.
  request.socket.setTimeout(0);
  request.socket.setNoDelay(true);
  request.socket.setKeepAlive(true);

  const stream = createServerSentStream({
    write: (chunk) => {
      response.write(chunk);
    },
    close: () => {
      response.end();
    },
    onTeardown,
  });

  request.on("close", () => stream.teardown());
  stream.open();
  return stream;
}

import { Router, type Response } from "express";
import { z } from "zod";
import {
  PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_FRAME_BYTES,
  PROVIDER_PROMOTION_BOOTSTRAP_STREAM_CONTENT_TYPE,
} from "@packscout/contracts";
import {
  ProviderPromotionBootstrapError,
  type ProviderPromotionBootstrapService,
} from "../promotion-job-provider-bootstrap.ts";

const requestSchema = z.object({
  providerId: z.string().regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  ),
  requestBudgetMilliseconds: z.number().int().min(100).max(30_000),
}).strict();

export interface ProviderPromotionBootstrapRouterDependencies {
  readonly bootstrap: Pick<ProviderPromotionBootstrapService, "stream">;
}

function writeFrame(
  response: Response,
  frame: unknown,
): boolean {
  const line = `${JSON.stringify(frame)}\n`;
  if (Buffer.byteLength(line, "utf8") >
    PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_FRAME_BYTES) {
    throw new ProviderPromotionBootstrapError(
      "PROVIDER_PROMOTION_BOOTSTRAP_UNAVAILABLE",
    );
  }
  return response.write(line);
}

function unavailable(): ProviderPromotionBootstrapError {
  return new ProviderPromotionBootstrapError(
    "PROVIDER_PROMOTION_BOOTSTRAP_UNAVAILABLE",
  );
}

export function waitForProviderPromotionBootstrapDrain(
  response: Response,
  signal: AbortSignal,
): Promise<void> {
  if (response.destroyed || signal.aborted) {
    return Promise.reject(unavailable());
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      response.off("drain", drained);
      response.off("close", closed);
      response.off("error", failed);
      signal.removeEventListener("abort", aborted);
    };
    const drained = () => { cleanup(); resolve(); };
    const rejectUnavailable = () => { cleanup(); reject(unavailable()); };
    const closed = rejectUnavailable;
    const failed = rejectUnavailable;
    const aborted = rejectUnavailable;
    response.once("drain", drained);
    response.once("close", closed);
    response.once("error", failed);
    signal.addEventListener("abort", aborted, { once: true });
    if (response.destroyed || signal.aborted) rejectUnavailable();
  });
}

/** Internal machine route; it does not accept browser sessions or routing. */
export function createProviderPromotionBootstrapRouter(
  dependencies: ProviderPromotionBootstrapRouterDependencies,
) {
  const router = Router();
  router.post("/", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const parsed = requestSchema.safeParse(request.body);
    const authorization = request.get("authorization");
    const bearer = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : null;
    if (!parsed.success || bearer === null) {
      response.status(401).json({
        error: "The provider promotion bootstrap request was rejected.",
        code: "PROVIDER_PROMOTION_BOOTSTRAP_UNAUTHORIZED",
      });
      return;
    }
    const ownership = new AbortController();
    const deadlineAt = Date.now() + parsed.data.requestBudgetMilliseconds;
    const abortForDeadline = () => ownership.abort(unavailable());
    const abortForDisconnect = () => {
      ownership.abort(unavailable());
      if (!response.destroyed) response.destroy();
    };
    const deadlineTimer = setTimeout(
      abortForDeadline,
      parsed.data.requestBudgetMilliseconds,
    );
    request.once("aborted", abortForDisconnect);
    response.once("close", abortForDisconnect);
    try {
      const frames = await dependencies.bootstrap.stream({
        providerId: parsed.data.providerId,
        bearerTokenBase64: bearer,
        signal: ownership.signal,
        deadlineAt,
      });
      if (ownership.signal.aborted) throw unavailable();
      if (response.destroyed) return;
      response.status(200);
      response.setHeader(
        "Content-Type",
        `${PROVIDER_PROMOTION_BOOTSTRAP_STREAM_CONTENT_TYPE}; charset=utf-8`,
      );
      response.flushHeaders();
      for await (const frame of frames) {
        if (ownership.signal.aborted || request.aborted || response.destroyed) {
          if (!response.destroyed) response.destroy();
          return;
        }
        if (!writeFrame(response, frame)) {
          await waitForProviderPromotionBootstrapDrain(
            response,
            ownership.signal,
          );
        }
      }
      response.end();
    } catch (error) {
      if (response.destroyed) return;
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const code = error instanceof ProviderPromotionBootstrapError
        ? error.code
        : "PROVIDER_PROMOTION_BOOTSTRAP_UNAVAILABLE";
      response.status(
        code === "PROVIDER_PROMOTION_BOOTSTRAP_UNAUTHORIZED" ? 401 : 503,
      ).json({
        error: code === "PROVIDER_PROMOTION_BOOTSTRAP_UNAUTHORIZED"
          ? "The provider promotion bootstrap request was rejected."
          : "Provider promotion bootstrap is temporarily unavailable.",
        code,
      });
    } finally {
      clearTimeout(deadlineTimer);
      request.off("aborted", abortForDisconnect);
      response.off("close", abortForDisconnect);
    }
  });
  return router;
}

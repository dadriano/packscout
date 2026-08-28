import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import {
  HardenedProviderRequestError,
  captureHardenedProviderResponse,
  type HardenedProviderRequestInput,
} from "./hardened-provider-request.ts";

const publicAddress = "93.184.216.34";

function input(
  overrides: Partial<HardenedProviderRequestInput> = {},
): HardenedProviderRequestInput {
  return {
    url: new URL("https://provider.invalid/v1/events"),
    allowedHosts: ["provider.invalid"],
    timeoutMilliseconds: 10_000,
    maximumResponseBytes: 1024,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function captureError(
  operation: Promise<unknown>,
): Promise<HardenedProviderRequestError> {
  try {
    await operation;
  } catch (error) {
    assert.ok(error instanceof HardenedProviderRequestError);
    return error;
  }
  assert.fail("expected hardened request failure");
}

test("hardened capture returns exact bytes at the cap and pins one DNS answer", async () => {
  const expected = new Uint8Array([0, 1, 2, 127, 128, 255]);
  let resolutions = 0;
  const capture = await captureHardenedProviderResponse(
    input({ maximumResponseBytes: expected.byteLength }),
    {
      resolveHost: async () => {
        resolutions += 1;
        return [publicAddress];
      },
      httpClient: async (url, init, destination) => {
        assert.equal(url.hostname, "provider.invalid");
        assert.equal(init.method, "GET");
        assert.equal(init.redirect, "manual");
        assert.deepEqual(destination, {
          hostname: "provider.invalid",
          addresses: [publicAddress],
        });
        return new Response(expected);
      },
    },
  );
  assert.equal(resolutions, 1);
  assert.deepEqual(capture.protectedBody, expected);
  assert.equal(capture.responseBytes, expected.byteLength);
});

test("declared and streamed overflow cancel the provider body", async () => {
  let declaredCancelled = false;
  const declared = await captureError(captureHardenedProviderResponse(
    input({ maximumResponseBytes: 4 }),
    {
      resolveHost: async () => [publicAddress],
      httpClient: async () => new Response(new ReadableStream({
        cancel() {
          declaredCancelled = true;
        },
      }), { headers: { "content-length": "5" } }),
    },
  ));
  assert.equal(declared.code, "response_too_large");
  assert.equal(declaredCancelled, true);

  let streamedCancelled = false;
  const streamed = await captureError(captureHardenedProviderResponse(
    input({ maximumResponseBytes: 4 }),
    {
      resolveHost: async () => [publicAddress],
      httpClient: async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.enqueue(new Uint8Array([4, 5, 6]));
        },
        cancel() {
          streamedCancelled = true;
        },
      })),
    },
  ));
  assert.equal(streamed.code, "response_too_large");
  assert.equal(streamedCancelled, true);
});

test("one lifetime covers a stalled response body and preserves parent cancellation", async () => {
  const controller = new AbortController();
  let bodyCancelled = false;
  let bodyReadStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    bodyReadStarted = resolve;
  });
  const operation = captureHardenedProviderResponse(
    input({ signal: controller.signal }),
    {
      resolveHost: async () => [publicAddress],
      httpClient: async () => {
        return new Response(new ReadableStream({
          pull() {
            bodyReadStarted();
          },
          cancel() {
            bodyCancelled = true;
          },
        }));
      },
    },
  );
  await started;
  controller.abort();
  const error = await captureError(operation);
  assert.equal(error.code, "cancelled");
  assert.equal(bodyCancelled, true);
});

test("request timeout remains active through a stalled response body", async () => {
  const keepAlive = setTimeout(() => undefined, 100);
  try {
    const error = await captureError(captureHardenedProviderResponse(
      input({ timeoutMilliseconds: 5 }),
      {
        resolveHost: async () => [publicAddress],
        httpClient: async () => new Response(new ReadableStream()),
      },
    ));
    assert.equal(error.code, "request_timeout");
    assert.equal(error.durationMilliseconds >= 0, true);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("redirects are never followed and their body is cancelled", async () => {
  let requestCount = 0;
  let bodyCancelled = false;
  const error = await captureError(captureHardenedProviderResponse(input(), {
    resolveHost: async () => [publicAddress],
    httpClient: async () => {
      requestCount += 1;
      return new Response(new ReadableStream({
        cancel() {
          bodyCancelled = true;
        },
      }), {
        status: 307,
        headers: { location: "https://attacker.invalid/steal" },
      });
    },
  }));
  assert.equal(error.code, "redirect_rejected");
  assert.equal(error.safeStatus, 307);
  assert.equal(requestCount, 1);
  assert.equal(bodyCancelled, true);
});

test("native transport does not follow a redirect or forward authorization", async () => {
  let redirectTargetRequests = 0;
  let forwardedAuthorization: string | undefined;
  const redirectTarget = createServer((request, response) => {
    redirectTargetRequests += 1;
    forwardedAuthorization = request.headers.authorization;
    response.end("must not be reached");
  });
  await new Promise<void>((resolve) =>
    redirectTarget.listen(0, "127.0.0.1", resolve)
  );
  const targetAddress = redirectTarget.address();
  assert.ok(targetAddress !== null && typeof targetAddress !== "string");

  const origin = createServer((_request, response) => {
    response.writeHead(302, {
      location: `http://127.0.0.1:${targetAddress.port}/steal`,
    });
    response.end("redirect-body");
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const originAddress = origin.address();
  assert.ok(originAddress !== null && typeof originAddress !== "string");
  try {
    const error = await captureError(captureHardenedProviderResponse(input({
      url: new URL(`http://127.0.0.1:${originAddress.port}/v1/events`),
      allowedHosts: ["127.0.0.1"],
      headers: { Authorization: "Bearer never-forward-this" },
      allowLocalHttp: true,
    })));
    assert.equal(error.code, "redirect_rejected");
    assert.equal(redirectTargetRequests, 0);
    assert.equal(forwardedAuthorization, undefined);
  } finally {
    await Promise.all([
      new Promise<void>((resolve, reject) => origin.close((error) =>
        error === undefined ? resolve() : reject(error)
      )),
      new Promise<void>((resolve, reject) => redirectTarget.close((error) =>
        error === undefined ? resolve() : reject(error)
      )),
    ]);
  }
});

test("destination and TLS failures expose only stable bounded errors", async () => {
  let requestCount = 0;
  const destination = await captureError(captureHardenedProviderResponse(input(), {
    resolveHost: async () => [publicAddress, "127.0.0.1"],
    httpClient: async () => {
      requestCount += 1;
      return new Response();
    },
  }));
  assert.equal(destination.code, "destination_not_allowed");
  assert.equal(requestCount, 0);

  const secret = "secret-certificate-detail";
  const tls = await captureError(captureHardenedProviderResponse(input(), {
    resolveHost: async () => [publicAddress],
    httpClient: async () => {
      const error = new Error(secret) as NodeJS.ErrnoException;
      error.code = "ERR_TLS_CERT_ALTNAME_INVALID";
      throw error;
    },
  }));
  assert.equal(tls.code, "tls_failed");
  assert.equal(JSON.stringify(tls).includes(secret), false);
  assert.equal(tls.message.includes(secret), false);
});

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import type { LookupAddress } from "node:dns";
import {
  buildPinnedProviderRequestOptions,
  requestPinnedProviderHttp,
} from "./pinned-provider-http-client.ts";

test("provider request options use only validated IPs while preserving HTTPS identity", async () => {
  const signal = new AbortController().signal;
  const options = buildPinnedProviderRequestOptions(
    new URL("https://provider.example:8443/feed?cursor=opaque"),
    {
      method: "GET",
      headers: { Accept: "application/json" },
      signal,
    },
    {
      hostname: "provider.example",
      addresses: ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"],
    },
  );

  assert.equal(options.hostname, "provider.example");
  assert.equal(options.servername, "provider.example");
  assert.equal(options.port, "8443");
  assert.equal(options.path, "/feed?cursor=opaque");
  assert.equal(options.signal, signal);
  assert.deepEqual(options.headers, {
    accept: "application/json",
    host: "provider.example:8443",
  });
  assert.equal(typeof options.checkServerIdentity, "function");
  assert.equal(options.autoSelectFamily, true);
  assert.equal(typeof options.lookup, "function");

  const lookup = options.lookup;
  assert.ok(lookup);
  const addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
    lookup("provider.example", { all: true }, (error, result) => {
      if (error) reject(error);
      else if (typeof result === "string") reject(new Error("Expected all pins."));
      else resolve(result);
    });
  });
  assert.deepEqual(addresses, [
    { address: "93.184.216.34", family: 4 },
    { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
  ]);
});

test("provider request options reject a pin for a different hostname", () => {
  assert.throws(
    () =>
      buildPinnedProviderRequestOptions(
        new URL("https://provider.example/feed"),
        { method: "GET" },
        {
          hostname: "attacker.example",
          addresses: ["93.184.216.34"],
        },
      ),
    /Validated provider destination is unavailable/,
  );
});

test("provider request falls back to another validated address without resolving DNS again", async () => {
  let observedHost = "";
  const server = createServer((request, response) => {
    observedHost = request.headers.host ?? "";
    response.end("validated-fallback");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await requestPinnedProviderHttp(
      new URL(`http://provider.example:${address.port}/feed`),
      { method: "GET" },
      {
        hostname: "provider.example",
        addresses: ["127.0.0.2", "127.0.0.1"],
      },
    );

    assert.equal(await response.text(), "validated-fallback");
    assert.equal(observedHost, `provider.example:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("bodyless responses are consumed so their connection can be reused", async () => {
  const statuses = [204, 205, 304, 200];
  let connectionCount = 0;
  const server = createServer((_request, response) => {
    const status = statuses.shift() ?? 500;
    response.writeHead(status);
    response.end(status === 200 ? "complete" : undefined);
  });
  server.on("connection", () => {
    connectionCount += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = new URL(`http://127.0.0.1:${address.port}/feed`);
    const destination = {
      hostname: "127.0.0.1",
      addresses: ["127.0.0.1"],
    } as const;

    const noContent = await requestPinnedProviderHttp(
      url,
      { method: "GET" },
      destination,
    );
    assert.equal(noContent.status, 204);
    assert.equal(noContent.body, null);
    await new Promise((resolve) => setImmediate(resolve));

    const resetContent = await requestPinnedProviderHttp(
      url,
      { method: "GET" },
      destination,
    );
    assert.equal(resetContent.status, 205);
    assert.equal(resetContent.body, null);
    await new Promise((resolve) => setImmediate(resolve));

    const notModified = await requestPinnedProviderHttp(
      url,
      { method: "GET" },
      destination,
    );
    assert.equal(notModified.status, 304);
    assert.equal(notModified.body, null);
    await new Promise((resolve) => setImmediate(resolve));

    const complete = await requestPinnedProviderHttp(
      url,
      { method: "GET" },
      destination,
    );
    assert.equal(await complete.text(), "complete");
    assert.equal(connectionCount, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("unsupported upstream status rejects the request instead of escaping the promise", async () => {
  const server = createServer((_request, response) => {
    response.statusCode = 700;
    response.end("unsupported-status");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await assert.rejects(
      requestPinnedProviderHttp(
        new URL(`http://127.0.0.1:${address.port}/feed`),
        { method: "GET" },
        { hostname: "127.0.0.1", addresses: ["127.0.0.1"] },
      ),
      /status.*range/i,
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("protocol upgrades are destroyed and reject instead of bypassing request timeout", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(101, {
      Connection: "Upgrade",
      Upgrade: "fixture-protocol",
    });
    response.flushHeaders();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await assert.rejects(
      requestPinnedProviderHttp(
        new URL(`http://127.0.0.1:${address.port}/feed`),
        { method: "GET" },
        { hostname: "127.0.0.1", addresses: ["127.0.0.1"] },
      ),
      /protocol upgrades are unsupported/i,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

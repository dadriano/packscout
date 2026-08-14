import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  buildContentSecurityPolicy,
  createCspNonce,
  hashImageOriginSet,
  readPublicSecurityConfiguration,
} from "./security-policy.server";

function expectedOriginHash(origins: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify([...origins].sort()))
    .digest("hex");
}

function directiveSources(policy: string, name: string): readonly string[] {
  const directive = policy
    .split("; ")
    .find((candidate) => candidate.startsWith(`${name} `));
  assert.ok(directive, `missing ${name} directive`);
  return directive.split(" ").slice(1);
}

test("builds a production nonce policy from only exact configured origins", () => {
  const imageOrigins = [
    "https://images-a.example",
    "https://images-b.example:8443",
  ];
  const configuration = readPublicSecurityConfiguration({
    NODE_ENV: "production",
    NEXT_PUBLIC_CONVEX_URL: "https://fixture-deployment.convex.cloud",
    PACKSCOUT_PUBLIC_IMAGE_ORIGINS: [...imageOrigins].reverse().join(","),
    PACKSCOUT_PUBLIC_ORIGIN_SET_HASH: expectedOriginHash(imageOrigins),
  });
  const policy = buildContentSecurityPolicy({
    nonce: "abcdefghijklmnopqrstuvwx",
    configuration,
  });

  assert.deepEqual(configuration.imageOrigins, imageOrigins);
  assert.deepEqual(directiveSources(policy, "connect-src"), [
    "'self'",
    "https://fixture-deployment.convex.cloud",
    "wss://fixture-deployment.convex.cloud",
  ]);
  assert.deepEqual(directiveSources(policy, "img-src"), [
    "'self'",
    "data:",
    ...imageOrigins,
  ]);
  assert.deepEqual(directiveSources(policy, "script-src"), [
    "'self'",
    "'nonce-abcdefghijklmnopqrstuvwx'",
    "'strict-dynamic'",
  ]);
  assert.equal(policy.includes("'unsafe-eval'"), false);
  assert.equal(policy.includes("script-src 'self' 'unsafe-inline'"), false);
  assert.equal(directiveSources(policy, "img-src").includes("https:"), false);
  assert.equal(directiveSources(policy, "connect-src").includes("wss:"), false);
  assert.equal(policy.includes("*.convex.cloud"), false);
});

test("allows exact cloud HTTPS/WSS and loopback HTTP/WS origins in development", () => {
  const loopbackConfiguration = readPublicSecurityConfiguration({
    NODE_ENV: "development",
    NEXT_PUBLIC_CONVEX_URL: "http://127.0.0.1:3210",
  });
  const loopbackPolicy = buildContentSecurityPolicy({
    nonce: "abcdefghijklmnopqrstuvwx",
    configuration: loopbackConfiguration,
  });

  assert.deepEqual(directiveSources(loopbackPolicy, "connect-src"), [
    "'self'",
    "http://127.0.0.1:3210",
    "ws://127.0.0.1:3210",
  ]);
  assert.equal(
    directiveSources(loopbackPolicy, "script-src").includes("'unsafe-eval'"),
    true,
  );

  const cloudConfiguration = readPublicSecurityConfiguration({
    NODE_ENV: "development",
    NEXT_PUBLIC_CONVEX_URL: "https://fixture-deployment.convex.cloud",
  });
  const cloudPolicy = buildContentSecurityPolicy({
    nonce: "abcdefghijklmnopqrstuvwx",
    configuration: cloudConfiguration,
  });
  assert.deepEqual(directiveSources(cloudPolicy, "connect-src"), [
    "'self'",
    "https://fixture-deployment.convex.cloud",
    "wss://fixture-deployment.convex.cloud",
  ]);

  assert.throws(
    () =>
      readPublicSecurityConfiguration({
        NODE_ENV: "development",
        NEXT_PUBLIC_CONVEX_URL: "http://localhost",
      }),
    /loopback origin with a port/,
  );

  for (const value of [
    "https://person:secret@fixture-deployment.convex.cloud",
    "https://fixture-deployment.convex.cloud/path",
    "https://fixture-deployment.convex.cloud?query=1",
    "https://fixture-deployment.convex.cloud#fragment",
    "https://fixture-deployment.convex.cloud:443",
    "https://fixture-deployment.convex.cloud:8443",
    "https://nested.fixture-deployment.convex.cloud",
  ]) {
    assert.throws(
      () =>
        readPublicSecurityConfiguration({
          NODE_ENV: "development",
          NEXT_PUBLIC_CONVEX_URL: value,
        }),
      /Development Convex URL|exact origins/,
      value,
    );
  }
});

test("keeps an unconfigured local or production-mode build self-only", () => {
  for (const nodeEnvironment of ["test", "production"] as const) {
    const configuration = readPublicSecurityConfiguration({
      NODE_ENV: nodeEnvironment,
    });
    const policy = buildContentSecurityPolicy({
      nonce: "abcdefghijklmnopqrstuvwx",
      configuration,
    });

    assert.equal(configuration.convexHttpOrigin, null);
    assert.equal(configuration.convexWebSocketOrigin, null);
    assert.deepEqual(configuration.imageOrigins, []);
    assert.deepEqual(directiveSources(policy, "connect-src"), ["'self'"]);
    assert.deepEqual(directiveSources(policy, "img-src"), ["'self'", "data:"]);
  }
});

test("fails closed for partial or malformed production configuration", () => {
  const emptyHash = expectedOriginHash([]);
  const exactHash = expectedOriginHash(["https://images.example"]);

  assert.throws(
    () =>
      readPublicSecurityConfiguration({
        NODE_ENV: "production",
        NEXT_PUBLIC_CONVEX_URL: "https://fixture-deployment.convex.cloud",
      }),
    /origin-set hash/,
  );
  assert.throws(
    () =>
      readPublicSecurityConfiguration({
        NODE_ENV: "production",
        PACKSCOUT_PUBLIC_ORIGIN_SET_HASH: emptyHash,
      }),
    /exact Convex origin/,
  );
  assert.throws(
    () =>
      readPublicSecurityConfiguration({
        NODE_ENV: "production",
        NEXT_PUBLIC_CONVEX_URL: "http://fixture-deployment.convex.cloud",
        PACKSCOUT_PUBLIC_ORIGIN_SET_HASH: emptyHash,
      }),
    /exact origins|use HTTPS/,
  );

  for (const value of [
    "https://localhost:3210",
    "https://fixture.team.convex.cloud",
    "https://fixture-deployment.convex.site",
    "https://fixture-deployment.convex.cloud/path",
    "https://person:secret@fixture-deployment.convex.cloud",
  ]) {
    assert.throws(
      () =>
        readPublicSecurityConfiguration({
          NODE_ENV: "production",
          NEXT_PUBLIC_CONVEX_URL: value,
          PACKSCOUT_PUBLIC_ORIGIN_SET_HASH: emptyHash,
        }),
      /Production Convex URL|exact origins/,
    );
  }

  for (const value of [
    "http://images.example",
    "https://*.example",
    "https://images.example/path",
    "https://person:secret@images.example",
  ]) {
    assert.throws(
      () =>
        readPublicSecurityConfiguration({
          NODE_ENV: "production",
          NEXT_PUBLIC_CONVEX_URL: "https://fixture-deployment.convex.cloud",
          PACKSCOUT_PUBLIC_IMAGE_ORIGINS: value,
          PACKSCOUT_PUBLIC_ORIGIN_SET_HASH: exactHash,
        }),
      /exact origins|origin-set hash/,
    );
  }

  assert.throws(
    () =>
      readPublicSecurityConfiguration({
        NODE_ENV: "production",
        NEXT_PUBLIC_CONVEX_URL: "https://fixture-deployment.convex.cloud",
        PACKSCOUT_PUBLIC_IMAGE_ORIGINS:
          "https://images.example,https://images.example",
        PACKSCOUT_PUBLIC_ORIGIN_SET_HASH: exactHash,
      }),
    /must be unique/,
  );
  assert.throws(
    () =>
      readPublicSecurityConfiguration({
        NODE_ENV: "production",
        NEXT_PUBLIC_CONVEX_URL: "https://fixture-deployment.convex.cloud",
        PACKSCOUT_PUBLIC_IMAGE_ORIGINS: "https://images.example",
        PACKSCOUT_PUBLIC_ORIGIN_SET_HASH: emptyHash,
      }),
    /does not match/,
  );
});

test("origin hashes are canonical and nonces are unpredictable per call", () => {
  const origins = ["https://b.example", "https://a.example"];
  assert.equal(hashImageOriginSet(origins), expectedOriginHash(origins));
  assert.equal(
    hashImageOriginSet(origins),
    hashImageOriginSet([...origins].reverse()),
  );
  assert.notEqual(hashImageOriginSet(origins), hashImageOriginSet(origins.slice(1)));

  const first = createCspNonce();
  const second = createCspNonce();
  assert.match(first, /^[A-Za-z0-9+/]{24}$/);
  assert.match(second, /^[A-Za-z0-9+/]{24}$/);
  assert.notEqual(first, second);
  assert.throws(
    () =>
      buildContentSecurityPolicy({
        nonce: "unsafe\nnonce",
        configuration: readPublicSecurityConfiguration({ NODE_ENV: "test" }),
      }),
    /nonce is invalid/,
  );
});

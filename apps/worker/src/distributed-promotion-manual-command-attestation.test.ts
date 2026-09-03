import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";
import test from "node:test";
import {
  canonicalDistributedPromotionManualCommandPayload,
  compactDistributedPromotionManualCommandAttestation,
  DISTRIBUTED_PROMOTION_MANUAL_COMMAND_REJECTION_CODE,
  DISTRIBUTED_PROMOTION_MANUAL_COMMAND_SCHEMA,
  Ed25519DistributedPromotionManualCommandVerifier,
  type DistributedPromotionManualCommandClaims,
} from "./distributed-promotion-manual-command-attestation.ts";

const issuedAt = Date.parse("2026-09-01T22:00:00.000Z");
const scopeIdentitySha256 = "a".repeat(64);
const commandId = randomBytes(16).toString("base64url");
const keys = generateKeyPairSync("ed25519");
const publicKeyPem = keys.publicKey.export({
  format: "pem",
  type: "spki",
}).toString();

function claims(
  overrides: Partial<DistributedPromotionManualCommandClaims> = {},
): DistributedPromotionManualCommandClaims {
  return {
    authority: "provider_publication",
    commandId,
    expiresAtMilliseconds: issuedAt + 5 * 60_000,
    issuedAtMilliseconds: issuedAt,
    requestedAtMilliseconds: issuedAt,
    scopeIdentitySha256,
    ...overrides,
  };
}

function attestation(
  input = claims(),
  privateKey: KeyObject = keys.privateKey,
): string {
  const payload = canonicalDistributedPromotionManualCommandPayload(input);
  return compactDistributedPromotionManualCommandAttestation(
    payload,
    sign(null, payload, privateKey),
  );
}

function rawAttestation(payload: Buffer, privateKey = keys.privateKey): string {
  return compactDistributedPromotionManualCommandAttestation(
    payload,
    sign(null, payload, privateKey),
  );
}

function verifier() {
  return new Ed25519DistributedPromotionManualCommandVerifier({ publicKeyPem });
}

function request(
  protectedCommandIdentity: string,
  overrides: Readonly<{
    authority?: "provider_publication" | "manifest_reconciliation";
    requestedAt?: Date;
    scopeIdentitySha256?: string;
  }> = {},
) {
  return {
    authority: overrides.authority ?? "provider_publication",
    scopeIdentitySha256: overrides.scopeIdentitySha256 ?? scopeIdentitySha256,
    protectedCommandIdentity,
    requestedAt: overrides.requestedAt ?? new Date(issuedAt + 60_000),
  };
}

function assertRejected(
  result: Awaited<ReturnType<ReturnType<typeof verifier>["verify"]>>,
) {
  assert.deepEqual(result, {
    state: "rejected",
    failureCode: DISTRIBUTED_PROMOTION_MANUAL_COMMAND_REJECTION_CODE,
  });
}

test("a valid authority-and-scope-bound command verifies locally", async () => {
  const providerToken = attestation();
  const providerResult = await verifier().verify(request(providerToken));
  assert.equal(providerResult.state, "verified");
  assert.match(
    providerResult.state === "verified" ? providerResult.deliveryIdentity : "",
    /^distributed-promotion-manual-v1:[0-9a-f]{64}$/u,
  );

  const manifestScope = "b".repeat(64);
  const manifestToken = attestation(claims({
    authority: "manifest_reconciliation",
    scopeIdentitySha256: manifestScope,
  }));
  const manifestResult = await verifier().verify(request(manifestToken, {
    authority: "manifest_reconciliation",
    scopeIdentitySha256: manifestScope,
  }));
  assert.equal(manifestResult.state, "verified");
});

test("replaying one signed command returns one stable delivery identity", async () => {
  const token = attestation();
  const instance = verifier();
  const first = await instance.verify(request(token));
  const replay = await instance.verify(request(token, {
    requestedAt: new Date(issuedAt + 4 * 60_000),
  }));

  assert.equal(first.state, "verified");
  assert.deepEqual(replay, first);
  assert.doesNotMatch(JSON.stringify(first), new RegExp(commandId, "u"));
});

test("authority and exact scope substitutions fail closed", async () => {
  const token = attestation();
  assertRejected(await verifier().verify(request(token, {
    authority: "manifest_reconciliation",
  })));
  assertRejected(await verifier().verify(request(token, {
    scopeIdentitySha256: "A".repeat(64),
  })));
  assertRejected(await verifier().verify(request(token, {
    scopeIdentitySha256: "b".repeat(64),
  })));
});

test("forged signatures and valid signatures from another key are rejected", async () => {
  const token = attestation();
  const [payload, signature] = token.split(".");
  assert.ok(payload && signature);
  const forgedSignature = `${signature.slice(0, -1)}${
    signature.endsWith("A") ? "B" : "A"
  }`;
  assertRejected(await verifier().verify(request(`${payload}.${forgedSignature}`)));

  const foreign = generateKeyPairSync("ed25519");
  assertRejected(await verifier().verify(request(attestation(
    claims({ commandId: randomBytes(16).toString("base64url") }),
    foreign.privateKey,
  ))));
});

test("only strict base64url and canonical exact-key payloads are accepted", async () => {
  const canonical = canonicalDistributedPromotionManualCommandPayload(claims());
  const wire = JSON.parse(canonical.toString("utf8")) as Record<string, unknown>;
  const nonCanonical = Buffer.from(JSON.stringify({
    v: wire.v,
    s: wire.s,
    r: wire.r,
    i: wire.i,
    h: wire.h,
    e: wire.e,
    c: wire.c,
    a: wire.a,
  }), "utf8");
  assertRejected(await verifier().verify(request(rawAttestation(nonCanonical))));

  const withExtraKey = Buffer.from(JSON.stringify({ ...wire, x: 1 }), "utf8");
  assertRejected(await verifier().verify(request(rawAttestation(withExtraKey))));

  const token = attestation();
  const [payload, signature] = token.split(".");
  assert.ok(payload && signature);
  assertRejected(await verifier().verify(request(`${payload}=.${signature}`)));
  assertRejected(await verifier().verify(request(`${payload}.${signature}=`)));
  assertRejected(await verifier().verify(request(`${payload}+.${signature}`)));
  assertRejected(await verifier().verify(request(` ${token}`)));
  assertRejected(await verifier().verify(request(`${token}.extra`)));
});

test("schema, version, and opaque 128-bit command identity are signed", async () => {
  const base = JSON.parse(
    canonicalDistributedPromotionManualCommandPayload(claims()).toString("utf8"),
  ) as Record<string, unknown>;
  for (const changed of [
    { ...base, h: `${DISTRIBUTED_PROMOTION_MANUAL_COMMAND_SCHEMA}.v2` },
    { ...base, v: 2 },
    { ...base, c: "short" },
  ]) {
    assertRejected(await verifier().verify(request(rawAttestation(
      Buffer.from(JSON.stringify(changed), "utf8"),
    ))));
  }
});

test("lifetime, signed request time, expiry, and clock skew stay bounded", async () => {
  const instance = verifier();
  assertRejected(await instance.verify(request(attestation(claims({
    expiresAtMilliseconds: issuedAt + 5 * 60_000 + 1,
  })))));
  assertRejected(await instance.verify(request(attestation(claims({
    requestedAtMilliseconds: issuedAt - 1,
  })))));
  assertRejected(await instance.verify(request(attestation(claims({
    requestedAtMilliseconds: issuedAt + 5 * 60_000 + 1,
  })))));
  assertRejected(await instance.verify(request(attestation(), {
    requestedAt: new Date(issuedAt - 30_001),
  })));
  assertRejected(await instance.verify(request(attestation(), {
    requestedAt: new Date(issuedAt + 5 * 60_000 + 30_001),
  })));

  const boundRequestAt = issuedAt + 2 * 60_000;
  const requestBoundToken = attestation(claims({
    requestedAtMilliseconds: boundRequestAt,
  }));
  assertRejected(await instance.verify(request(requestBoundToken, {
    requestedAt: new Date(boundRequestAt - 30_001),
  })));
  assert.equal((await instance.verify(request(requestBoundToken, {
    requestedAt: new Date(boundRequestAt),
  }))).state, "verified");

  assert.equal((await instance.verify(request(attestation(), {
    requestedAt: new Date(issuedAt - 30_000),
  }))).state, "verified");
  assert.equal((await instance.verify(request(attestation(), {
    requestedAt: new Date(issuedAt + 5 * 60_000 + 30_000),
  }))).state, "verified");
});

test("malformed or oversized bearer material returns one non-leaking result", async () => {
  const privateKeyPem = keys.privateKey.export({
    format: "pem",
    type: "pkcs8",
  }).toString();
  const instance = verifier();
  for (const token of [
    "not-a-command",
    "a".repeat(513),
    `${Buffer.from("{secret-json", "utf8").toString("base64url")}.abc`,
  ]) {
    const result = await instance.verify(request(token));
    assertRejected(result);
    const rendered = JSON.stringify(result);
    assert.doesNotMatch(rendered, /secret-json|BEGIN|PRIVATE|not-a-command/u);
  }
  assert.throws(
    () => new Ed25519DistributedPromotionManualCommandVerifier({
      publicKeyPem: privateKeyPem,
    }),
    (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.equal(
        error.message,
        "Manual command verifier configuration is invalid.",
      );
      assert.doesNotMatch(error.message, /BEGIN|PRIVATE|[A-Za-z0-9+/]{32}/u);
      return true;
    },
  );
});

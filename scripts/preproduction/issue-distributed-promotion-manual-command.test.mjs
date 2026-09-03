import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const scriptPath = fileURLToPath(new URL(
  "./issue-distributed-promotion-manual-command.mts",
  import.meta.url,
));
const verifierUrl = pathToFileURL(fileURLToPath(new URL(
  "../../apps/worker/src/distributed-promotion-manual-command-attestation.ts",
  import.meta.url,
))).href;
const scopeIdentitySha256 = "a".repeat(64);
const keys = generateKeyPairSync("ed25519");
const privateKeyPem = keys.privateKey.export({
  format: "pem",
  type: "pkcs8",
}).toString();
const publicKeyPem = keys.publicKey.export({
  format: "pem",
  type: "spki",
}).toString();

function issue(overrides = {}) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      scriptPath,
      "--authority",
      "provider_publication",
      "--scope-identity-sha256",
      scopeIdentitySha256,
      ...(overrides.argv ?? []),
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PACKSCOUT_RUNTIME_ENVIRONMENT: "preproduction",
        PACKSCOUT_DISTRIBUTED_PROMOTION_MANUAL_PRIVATE_KEY_PEM: privateKeyPem,
        ...(overrides.environment ?? {}),
      },
      timeout: 20_000,
    },
  );
}

test("preproduction issuer creates unique commands accepted by the public-key verifier", () => {
  const first = issue();
  const second = issue();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const firstToken = first.stdout.trim();
  const secondToken = second.stdout.trim();
  assert.match(firstToken, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
  assert.ok(firstToken.length <= 512);
  assert.notEqual(firstToken, secondToken);
  assert.equal(first.stderr, "");

  const verificationSource = `
    import { Ed25519DistributedPromotionManualCommandVerifier } from ${
      JSON.stringify(verifierUrl)
    };
    const verifier = new Ed25519DistributedPromotionManualCommandVerifier({
      publicKeyPem: process.env.TEST_PUBLIC_KEY_PEM,
    });
    const result = await verifier.verify({
      authority: "provider_publication",
      scopeIdentitySha256: process.env.TEST_SCOPE,
      protectedCommandIdentity: process.env.TEST_TOKEN,
      requestedAt: new Date(),
    });
    process.stdout.write(JSON.stringify(result));
  `;
  const verified = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", verificationSource],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        TEST_PUBLIC_KEY_PEM: publicKeyPem,
        TEST_SCOPE: scopeIdentitySha256,
        TEST_TOKEN: firstToken,
      },
      timeout: 20_000,
    },
  );
  assert.equal(verified.status, 0, verified.stderr);
  const result = JSON.parse(verified.stdout);
  assert.equal(result.state, "verified");
  assert.match(
    result.deliveryIdentity,
    /^distributed-promotion-manual-v1:[0-9a-f]{64}$/u,
  );
});

test("issuer is fail-closed outside preproduction and never prints key details", () => {
  for (const result of [
    issue({
      environment: { PACKSCOUT_RUNTIME_ENVIRONMENT: "production" },
    }),
    issue({ argv: ["--lifetime-seconds", "301"] }),
    issue({
      environment: {
        PACKSCOUT_DISTRIBUTED_PROMOTION_MANUAL_PRIVATE_KEY_PEM:
          "-----BEGIN PRIVATE KEY-----\noperator-secret\n-----END PRIVATE KEY-----",
      },
    }),
  ]) {
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      "The preproduction manual promotion command could not be issued safely.\n",
    );
    assert.doesNotMatch(result.stderr, /operator-secret|BEGIN|PRIVATE|MII/u);
  }
});

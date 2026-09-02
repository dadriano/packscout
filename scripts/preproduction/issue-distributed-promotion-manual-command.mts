#!/usr/bin/env -S node --import tsx

import {
  createPrivateKey,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  canonicalDistributedPromotionManualCommandPayload,
  compactDistributedPromotionManualCommandAttestation,
  DISTRIBUTED_PROMOTION_MANUAL_COMMAND_MAXIMUM_LIFETIME_MS,
  type DistributedPromotionManualCommandClaims,
} from "../../apps/worker/src/distributed-promotion-manual-command-attestation.ts";

const PRIVATE_KEY_ENVIRONMENT_NAME =
  "PACKSCOUT_DISTRIBUTED_PROMOTION_MANUAL_PRIVATE_KEY_PEM";
const MAXIMUM_PRIVATE_KEY_PEM_BYTES = 4_096;
const PRIVATE_KEY_BEGIN = "-----BEGIN PRIVATE KEY-----";
const PRIVATE_KEY_END = "-----END PRIVATE KEY-----";
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export class DistributedPromotionManualCommandIssuerError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("The preproduction manual promotion command could not be issued safely.");
    this.name = "DistributedPromotionManualCommandIssuerError";
    this.code = code;
  }
}

function refuse(code: string): never {
  throw new DistributedPromotionManualCommandIssuerError(code);
}

function parsePositiveInteger(value: string): number {
  if (!/^[1-9][0-9]{0,8}$/u.test(value)) {
    return refuse("MANUAL_COMMAND_ISSUER_ARGUMENT_INVALID");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return refuse("MANUAL_COMMAND_ISSUER_ARGUMENT_INVALID");
  }
  return parsed;
}

function loadPrivateKey(privateKeyPem: string): KeyObject {
  const trimmed = privateKeyPem.trim();
  if (
    Buffer.byteLength(privateKeyPem, "utf8") > MAXIMUM_PRIVATE_KEY_PEM_BYTES ||
    !trimmed.startsWith(`${PRIVATE_KEY_BEGIN}\n`) ||
    !trimmed.endsWith(`\n${PRIVATE_KEY_END}`) ||
    /[\0\r]/u.test(trimmed)
  ) return refuse("MANUAL_COMMAND_ISSUER_PRIVATE_KEY_INVALID");
  try {
    const key = createPrivateKey(trimmed);
    if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
      return refuse("MANUAL_COMMAND_ISSUER_PRIVATE_KEY_INVALID");
    }
    return key;
  } catch {
    return refuse("MANUAL_COMMAND_ISSUER_PRIVATE_KEY_INVALID");
  }
}

export interface DistributedPromotionManualCommandIssuerConfiguration {
  readonly authority: DistributedPromotionManualCommandClaims["authority"];
  readonly lifetimeMilliseconds: number;
  readonly privateKeyPem: string;
  readonly scopeIdentitySha256: string;
}

export function parseDistributedPromotionManualCommandIssuerConfiguration(
  input: Readonly<{
    argv: readonly string[];
    environment: Readonly<Record<string, string | undefined>>;
  }>,
): DistributedPromotionManualCommandIssuerConfiguration {
  if (input.environment.PACKSCOUT_RUNTIME_ENVIRONMENT !== "preproduction") {
    return refuse("MANUAL_COMMAND_ISSUER_ENVIRONMENT_FORBIDDEN");
  }
  let authority: DistributedPromotionManualCommandClaims["authority"] | null =
    null;
  let scopeIdentitySha256: string | null = null;
  let lifetimeSeconds =
    DISTRIBUTED_PROMOTION_MANUAL_COMMAND_MAXIMUM_LIFETIME_MS / 1_000;
  const seen = new Set<string>();
  for (let index = 0; index < input.argv.length; index += 2) {
    const name = input.argv[index];
    const value = input.argv[index + 1];
    if (
      name === undefined || value === undefined || !name.startsWith("--") ||
      value.startsWith("--") || seen.has(name)
    ) return refuse("MANUAL_COMMAND_ISSUER_ARGUMENT_INVALID");
    seen.add(name);
    if (name === "--authority") {
      if (value !== "provider_publication" &&
        value !== "manifest_reconciliation") {
        return refuse("MANUAL_COMMAND_ISSUER_ARGUMENT_INVALID");
      }
      authority = value;
    } else if (name === "--scope-identity-sha256") {
      if (!SHA256_PATTERN.test(value)) {
        return refuse("MANUAL_COMMAND_ISSUER_ARGUMENT_INVALID");
      }
      scopeIdentitySha256 = value;
    } else if (name === "--lifetime-seconds") {
      lifetimeSeconds = parsePositiveInteger(value);
    } else {
      return refuse("MANUAL_COMMAND_ISSUER_ARGUMENT_INVALID");
    }
  }
  const privateKeyPem = input.environment[PRIVATE_KEY_ENVIRONMENT_NAME];
  if (
    authority === null || scopeIdentitySha256 === null ||
    privateKeyPem === undefined || privateKeyPem.length < 1 ||
    lifetimeSeconds * 1_000 >
      DISTRIBUTED_PROMOTION_MANUAL_COMMAND_MAXIMUM_LIFETIME_MS
  ) return refuse("MANUAL_COMMAND_ISSUER_CONFIGURATION_INVALID");
  return {
    authority,
    lifetimeMilliseconds: lifetimeSeconds * 1_000,
    privateKeyPem,
    scopeIdentitySha256,
  };
}

/** Issues one opaque, short-lived capability. The private key never leaves
 * this preproduction-only process and is never included in returned errors. */
export function issueDistributedPromotionManualCommand(input: Readonly<{
  configuration: DistributedPromotionManualCommandIssuerConfiguration;
  now?: () => Date;
  randomCommandId?: () => string;
}>): string {
  const now = (input.now ?? (() => new Date()))();
  const issuedAtMilliseconds = now.getTime();
  if (!Number.isSafeInteger(issuedAtMilliseconds) || issuedAtMilliseconds < 0) {
    return refuse("MANUAL_COMMAND_ISSUER_CLOCK_INVALID");
  }
  const commandId = (input.randomCommandId ??
    (() => randomBytes(16).toString("base64url")))();
  const payload = canonicalDistributedPromotionManualCommandPayload({
    authority: input.configuration.authority,
    commandId,
    expiresAtMilliseconds:
      issuedAtMilliseconds + input.configuration.lifetimeMilliseconds,
    issuedAtMilliseconds,
    requestedAtMilliseconds: issuedAtMilliseconds,
    scopeIdentitySha256: input.configuration.scopeIdentitySha256,
  });
  const signature = sign(
    null,
    payload,
    loadPrivateKey(input.configuration.privateKeyPem),
  );
  return compactDistributedPromotionManualCommandAttestation(payload, signature);
}

export function runDistributedPromotionManualCommandIssuer(
  input: Readonly<{
    argv: readonly string[];
    environment: Readonly<Record<string, string | undefined>>;
    write: (value: string) => void;
  }>,
): void {
  const configuration = parseDistributedPromotionManualCommandIssuerConfiguration(
    input,
  );
  input.write(`${issueDistributedPromotionManualCommand({ configuration })}\n`);
}

const executedPath = process.argv[1];
if (
  executedPath !== undefined &&
  pathToFileURL(executedPath).href === import.meta.url
) {
  try {
    runDistributedPromotionManualCommandIssuer({
      argv: process.argv.slice(2),
      environment: process.env,
      write: (value) => process.stdout.write(value),
    });
  } catch {
    process.stderr.write(
      "The preproduction manual promotion command could not be issued safely.\n",
    );
    process.exitCode = 1;
  }
}

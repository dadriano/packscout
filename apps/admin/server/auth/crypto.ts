import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import argon2 from "argon2";
import type {
  LoginBucketKeyer,
  OpaqueRandomSource,
  PasswordHasher,
  SecretDigest,
} from "@packscout/services";

function createHmacDigest(secret: string, purpose: string): SecretDigest {
  const digest = (value: string) =>
    createHmac("sha256", secret).update(purpose).update("\0").update(value).digest("base64url");
  return {
    digest,
    matches(value, expected) {
      const actual = Buffer.from(digest(value));
      const stored = Buffer.from(expected);
      return actual.length === stored.length && timingSafeEqual(actual, stored);
    },
  };
}

export function createNodeAuthSecurity(secret: string): {
  random: OpaqueRandomSource;
  passwordHasher: PasswordHasher;
  sessionDigest: SecretDigest;
  csrfDigest: SecretDigest;
  bucketKeyer: LoginBucketKeyer;
} {
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("Session hashing secret must contain at least 32 bytes.");
  }
  const bucketDigest = createHmacDigest(secret, "login-rate-limit");
  return {
    random: {
      id: randomUUID,
      token: (byteLength) => randomBytes(byteLength).toString("base64url"),
    },
    passwordHasher: {
      algorithm: "argon2id",
      hash: (password) =>
        argon2.hash(password, {
          type: argon2.argon2id,
          memoryCost: 65_536,
          timeCost: 3,
          parallelism: 1,
        }),
      verify: (passwordHash, password) => argon2.verify(passwordHash, password),
    },
    sessionDigest: createHmacDigest(secret, "session-token"),
    csrfDigest: createHmacDigest(secret, "csrf-token"),
    bucketKeyer: {
      keys: ({ normalizedEmail, networkIdentifier }) => ({
        account: `email:${bucketDigest.digest(normalizedEmail)}`,
        network: `network:${bucketDigest.digest(networkIdentifier)}`,
      }),
    },
  };
}

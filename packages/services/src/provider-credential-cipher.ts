import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

export interface EncryptedProviderCredential {
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly authTag: Uint8Array;
  readonly keyVersion: number;
}

export interface ProviderCredentialScope {
  readonly organizationId: string;
  readonly providerId: string;
  readonly revisionId: string;
}

export interface ProviderCredentialCipher {
  encrypt(
    plaintext: string,
    scope: ProviderCredentialScope,
  ): EncryptedProviderCredential;
  decrypt(
    encrypted: EncryptedProviderCredential,
    scope: ProviderCredentialScope,
  ): string;
}

export interface ProviderCredentialKeyring {
  readonly primaryVersion: number;
  readonly keys: ReadonlyMap<number, Uint8Array>;
}

function additionalAuthenticatedData(scope: ProviderCredentialScope): Buffer {
  return Buffer.from(
    `packscout-provider-credential:v1\u0000${scope.organizationId}\u0000${scope.providerId}\u0000${scope.revisionId}`,
    "utf8",
  );
}

export class AesGcmProviderCredentialCipher implements ProviderCredentialCipher {
  readonly #primaryVersion: number;
  readonly #keys: ReadonlyMap<number, Buffer>;

  constructor(keyring: ProviderCredentialKeyring) {
    const keys = new Map<number, Buffer>();
    for (const [version, key] of keyring.keys) {
      if (!Number.isInteger(version) || version < 1 || key.byteLength !== 32) {
        throw new Error("Provider credential keyring is invalid.");
      }
      keys.set(version, Buffer.from(key));
    }
    if (!keys.has(keyring.primaryVersion)) {
      throw new Error("Provider credential primary key version is unavailable.");
    }
    this.#primaryVersion = keyring.primaryVersion;
    this.#keys = keys;
  }

  encrypt(
    plaintext: string,
    scope: ProviderCredentialScope,
  ): EncryptedProviderCredential {
    if (plaintext.length === 0 || /[\r\n]/.test(plaintext)) {
      throw new Error("Provider credential is invalid.");
    }
    const nonce = randomBytes(12);
    const cipher = createCipheriv(
      "aes-256-gcm",
      this.#keys.get(this.#primaryVersion)!,
      nonce,
    );
    cipher.setAAD(additionalAuthenticatedData(scope));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    return Object.freeze({
      ciphertext,
      nonce,
      authTag: cipher.getAuthTag(),
      keyVersion: this.#primaryVersion,
    });
  }

  decrypt(
    encrypted: EncryptedProviderCredential,
    scope: ProviderCredentialScope,
  ): string {
    const key = this.#keys.get(encrypted.keyVersion);
    if (!key) throw new Error("Provider credential key version is unavailable.");
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        encrypted.nonce,
      );
      decipher.setAAD(additionalAuthenticatedData(scope));
      decipher.setAuthTag(encrypted.authTag);
      return Buffer.concat([
        decipher.update(encrypted.ciphertext),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new Error("Provider credential could not be decrypted.");
    }
  }
}

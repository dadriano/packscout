import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

export interface ScopedAesGcmCiphertext {
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly authTag: Uint8Array;
  readonly keyVersion: number;
}

export interface ScopedAesGcmKeyring {
  readonly primaryVersion: number;
  readonly keys: ReadonlyMap<number, Uint8Array>;
}

export class ScopedAesGcmCipher {
  readonly #domain: string;
  readonly #primaryVersion: number;
  readonly #keys: ReadonlyMap<number, Buffer>;

  constructor(domain: string, keyring: ScopedAesGcmKeyring) {
    if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(domain)) {
      throw new Error("Credential cipher domain is invalid.");
    }
    const keys = new Map<number, Buffer>();
    for (const [version, key] of keyring.keys) {
      if (!Number.isInteger(version) || version < 1 || key.byteLength !== 32) {
        throw new Error("Credential cipher keyring is invalid.");
      }
      keys.set(version, Buffer.from(key));
    }
    if (!keys.has(keyring.primaryVersion)) {
      throw new Error("Credential cipher primary key version is unavailable.");
    }
    this.#domain = domain;
    this.#primaryVersion = keyring.primaryVersion;
    this.#keys = keys;
  }

  encrypt(plaintext: string, scope: readonly string[]): ScopedAesGcmCiphertext {
    if (
      plaintext.length === 0 ||
      Buffer.byteLength(plaintext, "utf8") > 32_768 ||
      scope.length === 0 ||
      scope.some((value) =>
        value.trim().length === 0 ||
        value.includes("\0") ||
        /[\r\n]/u.test(value)
      )
    ) {
      throw new Error("Credential cipher input is invalid.");
    }
    const nonce = randomBytes(12);
    const cipher = createCipheriv(
      "aes-256-gcm",
      this.#keys.get(this.#primaryVersion)!,
      nonce,
    );
    cipher.setAAD(this.#additionalAuthenticatedData(scope));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    return Object.freeze({
      ciphertext: new Uint8Array(ciphertext),
      nonce: new Uint8Array(nonce),
      authTag: new Uint8Array(cipher.getAuthTag()),
      keyVersion: this.#primaryVersion,
    });
  }

  decrypt(encrypted: ScopedAesGcmCiphertext, scope: readonly string[]): string {
    const key = this.#keys.get(encrypted.keyVersion);
    if (!key) throw new Error("Credential cipher key version is unavailable.");
    if (
      encrypted.nonce.byteLength !== 12 ||
      encrypted.authTag.byteLength !== 16 ||
      encrypted.ciphertext.byteLength === 0 ||
      encrypted.ciphertext.byteLength > 32_768
    ) {
      throw new Error("Credential cipher payload is invalid.");
    }
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        encrypted.nonce,
      );
      decipher.setAAD(this.#additionalAuthenticatedData(scope));
      decipher.setAuthTag(encrypted.authTag);
      return Buffer.concat([
        decipher.update(encrypted.ciphertext),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new Error("Credential cipher payload could not be decrypted.");
    }
  }

  #additionalAuthenticatedData(scope: readonly string[]): Buffer {
    return Buffer.from(`${this.#domain}\u0000${scope.join("\u0000")}`, "utf8");
  }
}

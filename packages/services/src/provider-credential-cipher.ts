import {
  ScopedAesGcmCipher,
  type ScopedAesGcmCiphertext,
  type ScopedAesGcmKeyring,
} from "./scoped-aes-gcm-cipher.ts";

export type EncryptedProviderCredential = ScopedAesGcmCiphertext;

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

export type ProviderCredentialKeyring = ScopedAesGcmKeyring;

export class AesGcmProviderCredentialCipher implements ProviderCredentialCipher {
  readonly #cipher: ScopedAesGcmCipher;

  constructor(keyring: ProviderCredentialKeyring) {
    this.#cipher = new ScopedAesGcmCipher(
      "packscout-provider-credential:v1",
      keyring,
    );
  }

  encrypt(
    plaintext: string,
    scope: ProviderCredentialScope,
  ): EncryptedProviderCredential {
    if (plaintext.length === 0 || /[\r\n]/u.test(plaintext)) {
      throw new Error("Provider credential is invalid.");
    }
    return this.#cipher.encrypt(plaintext, [
      scope.organizationId,
      scope.providerId,
      scope.revisionId,
    ]);
  }

  decrypt(
    encrypted: EncryptedProviderCredential,
    scope: ProviderCredentialScope,
  ): string {
    try {
      return this.#cipher.decrypt(encrypted, [
        scope.organizationId,
        scope.providerId,
        scope.revisionId,
      ]);
    } catch {
      throw new Error("Provider credential could not be decrypted.");
    }
  }
}

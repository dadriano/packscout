import {
  ScopedAesGcmCipher,
  type ScopedAesGcmCiphertext,
  type ScopedAesGcmKeyring,
} from "./scoped-aes-gcm-cipher.ts";

export type EncryptedSourceConnectionConfiguration = ScopedAesGcmCiphertext;

export interface SourceConnectionConfigurationScope {
  readonly organizationId: string;
  readonly connectionProfileId: string;
  readonly connectionRevisionId: string;
}

export interface SourceConnectionConfigurationCipher {
  encrypt(
    plaintext: string,
    scope: SourceConnectionConfigurationScope,
  ): EncryptedSourceConnectionConfiguration;
  decrypt(
    encrypted: EncryptedSourceConnectionConfiguration,
    scope: SourceConnectionConfigurationScope,
  ): string;
}

export class AesGcmSourceConnectionConfigurationCipher
  implements SourceConnectionConfigurationCipher {
  readonly #cipher: ScopedAesGcmCipher;

  constructor(keyring: ScopedAesGcmKeyring) {
    this.#cipher = new ScopedAesGcmCipher(
      "packscout-source-connection-configuration.v1",
      keyring,
    );
  }

  encrypt(
    plaintext: string,
    scope: SourceConnectionConfigurationScope,
  ): EncryptedSourceConnectionConfiguration {
    return this.#cipher.encrypt(plaintext, this.#scope(scope));
  }

  decrypt(
    encrypted: EncryptedSourceConnectionConfiguration,
    scope: SourceConnectionConfigurationScope,
  ): string {
    return this.#cipher.decrypt(encrypted, this.#scope(scope));
  }

  #scope(scope: SourceConnectionConfigurationScope): readonly string[] {
    return [
      scope.organizationId,
      scope.connectionProfileId,
      scope.connectionRevisionId,
    ];
  }
}

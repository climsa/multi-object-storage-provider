import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

import {
  providerCredentialPayloadSchema,
  type ProviderCredentialPayload,
} from "@mosp/shared";

import type { KeyEncryptionKeyProvider } from "./key-encryption-key-provider.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const DATA_KEY_LENGTH = 32;
const FORMAT_VERSION = 1;

export interface EncryptedProviderCredential {
  algorithm: typeof ALGORITHM;
  authTag: Uint8Array;
  encryptedDataKey: Uint8Array;
  encryptedPayload: Uint8Array;
  formatVersion: typeof FORMAT_VERSION;
  iv: Uint8Array;
  keyVersion: string;
}

export class ProviderCredentialCipher {
  public constructor(
    private readonly keyEncryptionKeyProvider: KeyEncryptionKeyProvider,
  ) {}

  public async encrypt(
    providerConnectionId: string,
    input: ProviderCredentialPayload,
  ): Promise<EncryptedProviderCredential> {
    const credential = providerCredentialPayloadSchema.parse(input);
    const dataKey = randomBytes(DATA_KEY_LENGTH);
    const iv = randomBytes(IV_LENGTH);

    try {
      const cipher = createCipheriv(ALGORITHM, dataKey, iv);
      cipher.setAAD(this.additionalAuthenticatedData(providerConnectionId));
      const encryptedPayload = Buffer.concat([
        cipher.update(JSON.stringify(credential), "utf8"),
        cipher.final(),
      ]);
      const wrappedDataKey = await this.keyEncryptionKeyProvider.wrapKey(dataKey);

      return {
        algorithm: ALGORITHM,
        authTag: Uint8Array.from(cipher.getAuthTag()),
        encryptedDataKey: wrappedDataKey.encryptedDataKey,
        encryptedPayload: Uint8Array.from(encryptedPayload),
        formatVersion: FORMAT_VERSION,
        iv: Uint8Array.from(iv),
        keyVersion: wrappedDataKey.keyVersion,
      };
    } finally {
      dataKey.fill(0);
    }
  }

  public async decrypt(
    providerConnectionId: string,
    encrypted: EncryptedProviderCredential,
  ): Promise<ProviderCredentialPayload> {
    if (
      encrypted.algorithm !== ALGORITHM ||
      encrypted.formatVersion !== FORMAT_VERSION ||
      encrypted.iv.byteLength !== IV_LENGTH
    ) {
      throw new Error("Unsupported provider credential envelope");
    }

    const dataKey = await this.keyEncryptionKeyProvider.unwrapKey(
      encrypted.encryptedDataKey,
      encrypted.keyVersion,
    );

    try {
      const decipher = createDecipheriv(ALGORITHM, dataKey, encrypted.iv);
      decipher.setAAD(this.additionalAuthenticatedData(providerConnectionId));
      decipher.setAuthTag(Buffer.from(encrypted.authTag));
      const payload = Buffer.concat([
        decipher.update(encrypted.encryptedPayload),
        decipher.final(),
      ]);

      return providerCredentialPayloadSchema.parse(
        JSON.parse(payload.toString("utf8")),
      );
    } catch {
      throw new Error("Unable to decrypt provider credential");
    } finally {
      dataKey.fill(0);
    }
  }

  /** Re-wraps a credential under the provider's current key-encryption-key version. */
  public async reEncrypt(
    providerConnectionId: string,
    encrypted: EncryptedProviderCredential,
  ): Promise<EncryptedProviderCredential> {
    const credential = await this.decrypt(providerConnectionId, encrypted);
    return this.encrypt(providerConnectionId, credential);
  }

  private additionalAuthenticatedData(providerConnectionId: string): Buffer {
    return Buffer.from(
      `mosp/provider-credential/v${FORMAT_VERSION}/${providerConnectionId}`,
      "utf8",
    );
  }
}

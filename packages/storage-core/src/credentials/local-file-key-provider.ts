import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import type {
  KeyEncryptionKeyProvider,
  WrappedDataKey,
} from "./key-encryption-key-provider.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const DATA_KEY_LENGTH = 32;

/** Development-only key provider backed by a Docker Secret-compatible file. */
export class LocalFileKeyEncryptionKeyProvider
  implements KeyEncryptionKeyProvider
{
  public constructor(
    private readonly keyFilePath: string,
    private readonly keyVersion = "local-v1",
    private readonly previousKeyFiles: Readonly<Record<string, string>> = {},
  ) {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(this.keyVersion)) {
      throw new Error("Key-encryption-key version is invalid");
    }
    for (const version of Object.keys(this.previousKeyFiles)) {
      if (!/^[A-Za-z0-9._-]{1,100}$/.test(version)) {
        throw new Error("Previous key-encryption-key version is invalid");
      }
    }
  }

  public async wrapKey(dataKey: Uint8Array): Promise<WrappedDataKey> {
    if (dataKey.byteLength !== DATA_KEY_LENGTH) {
      throw new Error("Data key must contain exactly 32 bytes");
    }

    const keyEncryptionKey = await this.readKeyEncryptionKey(this.keyFilePath);
    try {
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv(ALGORITHM, keyEncryptionKey, iv);
      cipher.setAAD(this.additionalAuthenticatedData(this.keyVersion));

      const ciphertext = Buffer.concat([
        cipher.update(dataKey),
        cipher.final(),
      ]);
      const authTag = cipher.getAuthTag();

      return {
        encryptedDataKey: Uint8Array.from(
          Buffer.concat([iv, authTag, ciphertext]),
        ),
        keyVersion: this.keyVersion,
      };
    } finally {
      keyEncryptionKey.fill(0);
    }
  }

  public async unwrapKey(
    encryptedDataKey: Uint8Array,
    keyVersion: string,
  ): Promise<Uint8Array> {
    const keyFilePath = keyVersion === this.keyVersion
      ? this.keyFilePath
      : this.previousKeyFiles[keyVersion];
    if (!keyFilePath) {
      throw new Error("Unsupported key-encryption-key version");
    }

    if (encryptedDataKey.byteLength !== IV_LENGTH + AUTH_TAG_LENGTH + DATA_KEY_LENGTH) {
      throw new Error("Invalid encrypted data-key envelope");
    }

    const envelope = Buffer.from(encryptedDataKey);
    const iv = envelope.subarray(0, IV_LENGTH);
    const authTag = envelope.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = envelope.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    const keyEncryptionKey = await this.readKeyEncryptionKey(keyFilePath);

    try {
      const decipher = createDecipheriv(ALGORITHM, keyEncryptionKey, iv);
      decipher.setAAD(this.additionalAuthenticatedData(keyVersion));
      decipher.setAuthTag(authTag);

      return Uint8Array.from(
        Buffer.concat([decipher.update(ciphertext), decipher.final()]),
      );
    } catch {
      throw new Error("Unable to unwrap provider credential data key");
    } finally {
      keyEncryptionKey.fill(0);
    }
  }

  private additionalAuthenticatedData(keyVersion: string): Buffer {
    return Buffer.from(`mosp/provider-data-key/v1/${keyVersion}`, "utf8");
  }

  private async readKeyEncryptionKey(keyFilePath: string): Promise<Buffer> {
    const fileStats = await stat(keyFilePath);
    if ((fileStats.mode & 0o077) !== 0) {
      throw new Error("Key-encryption-key file must not be group/world readable");
    }
    const encodedKey = (await readFile(keyFilePath, "utf8")).trim();
    const key = Buffer.from(encodedKey, "base64url");

    if (key.byteLength !== DATA_KEY_LENGTH) {
      key.fill(0);
      throw new Error("Key-encryption-key file must contain 32 base64url bytes");
    }

    return key;
  }
}

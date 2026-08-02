import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalFileKeyEncryptionKeyProvider } from "./local-file-key-provider.js";
import { ProviderCredentialCipher } from "./provider-credential-cipher.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
});

async function createCipher() {
  const directory = await mkdtemp(join(tmpdir(), "mosp-credential-test-"));
  temporaryDirectories.push(directory);
  const keyPath = join(directory, "provider-kek");
  await writeFile(keyPath, randomBytes(32).toString("base64url"), {
    mode: 0o600,
  });

  return new ProviderCredentialCipher(
    new LocalFileKeyEncryptionKeyProvider(keyPath),
  );
}

describe("ProviderCredentialCipher", () => {
  it("round-trips provider credentials without plaintext in the envelope", async () => {
    const cipher = await createCipher();
    const providerConnectionId = "5c9ec9bf-7aec-4b49-aa7f-033b51e97eaf";
    const credential = {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
      sessionToken: "test-session-token",
    };

    const encrypted = await cipher.encrypt(providerConnectionId, credential);
    const serializedEnvelope = Buffer.concat([
      Buffer.from(encrypted.encryptedPayload),
      Buffer.from(encrypted.encryptedDataKey),
    ]).toString("utf8");

    expect(serializedEnvelope).not.toContain(credential.accessKeyId);
    expect(serializedEnvelope).not.toContain(credential.secretAccessKey);
    await expect(cipher.decrypt(providerConnectionId, encrypted)).resolves.toEqual(
      credential,
    );
  });

  it("rejects an envelope moved to another provider connection", async () => {
    const cipher = await createCipher();
    const encrypted = await cipher.encrypt("provider-a", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    await expect(cipher.decrypt("provider-b", encrypted)).rejects.toThrow(
      "Unable to decrypt provider credential",
    );
  });

  it("rejects tampered ciphertext", async () => {
    const cipher = await createCipher();
    const encrypted = await cipher.encrypt("provider-a", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });
    const tamperedPayload = Uint8Array.from(encrypted.encryptedPayload);
    tamperedPayload[0] = (tamperedPayload[0] ?? 0) ^ 1;

    await expect(
      cipher.decrypt("provider-a", {
        ...encrypted,
        encryptedPayload: tamperedPayload,
      }),
    ).rejects.toThrow("Unable to decrypt provider credential");
  });

  it("decrypts a previous key version and re-encrypts with the current version", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mosp-credential-rotation-test-"));
    temporaryDirectories.push(directory);
    const previousKeyPath = join(directory, "provider-kek-v1");
    const currentKeyPath = join(directory, "provider-kek-v2");
    await writeFile(previousKeyPath, randomBytes(32).toString("base64url"), { mode: 0o600 });
    await writeFile(currentKeyPath, randomBytes(32).toString("base64url"), { mode: 0o600 });

    const previousCipher = new ProviderCredentialCipher(
      new LocalFileKeyEncryptionKeyProvider(previousKeyPath, "local-v1"),
    );
    const currentCipher = new ProviderCredentialCipher(
      new LocalFileKeyEncryptionKeyProvider(currentKeyPath, "local-v2", {
        "local-v1": previousKeyPath,
      }),
    );
    const credential = {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    };
    const oldEnvelope = await previousCipher.encrypt("provider-a", credential);
    const rotatedEnvelope = await currentCipher.reEncrypt("provider-a", oldEnvelope);

    expect(rotatedEnvelope.keyVersion).toBe("local-v2");
    await expect(currentCipher.decrypt("provider-a", rotatedEnvelope)).resolves.toEqual(credential);
    await expect(
      new ProviderCredentialCipher(
        new LocalFileKeyEncryptionKeyProvider(currentKeyPath, "local-v2"),
      ).decrypt("provider-a", oldEnvelope),
    ).rejects.toThrow("Unsupported key-encryption-key version");
  });

  it("rejects a key file with broad permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mosp-credential-permissions-test-"));
    temporaryDirectories.push(directory);
    const keyPath = join(directory, "provider-kek");
    await writeFile(keyPath, randomBytes(32).toString("base64url"), { mode: 0o644 });

    await expect(
      new ProviderCredentialCipher(
        new LocalFileKeyEncryptionKeyProvider(keyPath),
      ).encrypt("provider-a", {
        accessKeyId: "test-access-key",
        secretAccessKey: "test-secret-key",
      }),
    ).rejects.toThrow("must not be group/world readable");
  });
});

import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@mosp/db";
import {
  ApiCredentialAuthenticationError,
  ApiCredentialAuthenticator,
  hashApiCredentialSecret,
  parseApiCredentialToken,
} from "./api-credential.js";

const credentialId = "10000000-0000-4000-8000-000000000004";
const organizationId = "10000000-0000-4000-8000-000000000002";
const namespaceId = "10000000-0000-4000-8000-000000000003";
const secret = "mosp_secret_abcdefghijklmnopqrstuvwxyz123456";
const keyId = "mosp_public-key";

function createDatabase(overrides: Record<string, unknown> = {}) {
  return {
    apiCredential: {
      findUnique: vi.fn().mockResolvedValue({
        id: credentialId,
        organizationId,
        namespaceId,
        secretHash: hashApiCredentialSecret(secret),
        status: "ACTIVE",
        expiresAt: null,
        ...overrides,
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  } as unknown as PrismaClient;
}

describe("API credential authentication", () => {
  it("parses the public key and secret token format", () => {
    expect(parseApiCredentialToken(`${keyId}.${secret}`)).toEqual({ keyId, secret });
    expect(parseApiCredentialToken("mosp_public-key.invalid")).toBeNull();
    expect(parseApiCredentialToken("not-a-credential")).toBeNull();
  });

  it("verifies the secret and records last use", async () => {
    const now = new Date("2030-01-01T00:00:00.000Z");
    const database = createDatabase();
    const identity = await new ApiCredentialAuthenticator(database, () => now).authenticate(
      `${keyId}.${secret}`,
    );

    expect(identity).toEqual({
      credentialId,
      namespaceId,
      organizationId,
      principalId: credentialId,
      principalType: "API_CREDENTIAL",
    });
    expect(database.apiCredential.updateMany).toHaveBeenCalledWith({
      where: { id: credentialId, status: "ACTIVE" },
      data: { lastUsedAt: now },
    });
  });

  it("rejects invalid, revoked, expired, and concurrently revoked credentials", async () => {
    const invalidDatabase = createDatabase();
    await expect(
      new ApiCredentialAuthenticator(invalidDatabase).authenticate(`${keyId}.mosp_secret_wrong`),
    ).rejects.toBeInstanceOf(ApiCredentialAuthenticationError);

    const revokedDatabase = createDatabase({ status: "REVOKED" });
    await expect(
      new ApiCredentialAuthenticator(revokedDatabase).authenticate(`${keyId}.${secret}`),
    ).rejects.toBeInstanceOf(ApiCredentialAuthenticationError);

    const expiredDatabase = createDatabase({ expiresAt: new Date("2020-01-01T00:00:00.000Z") });
    await expect(
      new ApiCredentialAuthenticator(expiredDatabase, () => new Date("2030-01-01T00:00:00.000Z")).authenticate(
        `${keyId}.${secret}`,
      ),
    ).rejects.toBeInstanceOf(ApiCredentialAuthenticationError);

    const concurrentDatabase = createDatabase();
    vi.mocked(concurrentDatabase.apiCredential.updateMany).mockResolvedValue({ count: 0 });
    await expect(
      new ApiCredentialAuthenticator(concurrentDatabase).authenticate(`${keyId}.${secret}`),
    ).rejects.toBeInstanceOf(ApiCredentialAuthenticationError);
  });
});

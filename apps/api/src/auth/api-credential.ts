import { createHash, timingSafeEqual } from "node:crypto";

import type { PrismaClient } from "@mosp/db";

export interface ApiCredentialIdentity {
  credentialId: string;
  namespaceId: string;
  organizationId: string;
  principalId: string;
  principalType: "API_CREDENTIAL";
}

export class ApiCredentialAuthenticationError extends Error {
  public constructor() {
    super("UNAUTHENTICATED");
    this.name = "ApiCredentialAuthenticationError";
  }
}

const DUMMY_SECRET_HASH = "0".repeat(64);

export function parseApiCredentialToken(
  token: string | null | undefined,
): { keyId: string; secret: string } | null {
  if (!token) return null;
  const separator = token.indexOf(".");
  if (separator <= 0 || separator === token.length - 1) return null;

  const keyId = token.slice(0, separator);
  const secret = token.slice(separator + 1);
  if (
    keyId.length > 100 ||
    secret.length < 20 ||
    secret.length > 512 ||
    !/^mosp_[A-Za-z0-9_-]+$/.test(keyId) ||
    !/^mosp_secret_[A-Za-z0-9_-]+$/.test(secret)
  ) {
    return null;
  }
  return { keyId, secret };
}

export function hashApiCredentialSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export class ApiCredentialAuthenticator {
  public constructor(
    private readonly database: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async authenticate(token: string | null | undefined): Promise<ApiCredentialIdentity> {
    const parsed = parseApiCredentialToken(token);
    if (!parsed) throw new ApiCredentialAuthenticationError();

    const credential = await this.database.apiCredential.findUnique({
      where: { keyId: parsed.keyId },
      select: {
        id: true,
        organizationId: true,
        namespaceId: true,
        secretHash: true,
        status: true,
        expiresAt: true,
      },
    });

    const actualHash = Buffer.from(hashApiCredentialSecret(parsed.secret), "utf8");
    const expectedHash = this.safeExpectedHash(credential?.secretHash);
    const validSecret = timingSafeEqual(actualHash, expectedHash);
    const currentTime = this.now();
    if (
      !credential ||
      !validSecret ||
      credential.status !== "ACTIVE" ||
      (credential.expiresAt !== null && credential.expiresAt <= currentTime)
    ) {
      throw new ApiCredentialAuthenticationError();
    }

    const updated = await this.database.apiCredential.updateMany({
      where: { id: credential.id, status: "ACTIVE" },
      data: { lastUsedAt: currentTime },
    });
    if (updated.count !== 1) throw new ApiCredentialAuthenticationError();

    return {
      credentialId: credential.id,
      namespaceId: credential.namespaceId,
      organizationId: credential.organizationId,
      principalId: credential.id,
      principalType: "API_CREDENTIAL",
    };
  }

  private safeExpectedHash(secretHash: string | undefined): Buffer {
    if (!secretHash || !/^[a-f0-9]{64}$/.test(secretHash)) {
      return Buffer.from(DUMMY_SECRET_HASH, "utf8");
    }
    return Buffer.from(secretHash, "utf8");
  }
}

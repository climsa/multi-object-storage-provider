import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@mosp/db";
import { ApiCredentialService } from "./service.js";

const organizationId = "10000000-0000-4000-8000-000000000002";
const namespaceId = "10000000-0000-4000-8000-000000000003";
const actorId = "10000000-0000-4000-8000-000000000001";

describe("ApiCredentialService", () => {
  it("stores only a hash and returns the generated secret once", async () => {
    const create = vi.fn().mockImplementation(({ data }) => ({
      ...data,
      id: "10000000-0000-4000-8000-000000000004",
      lastUsedAt: null,
      revokedAt: null,
      createdAt: new Date("2030-01-01T00:00:00.000Z"),
      updatedAt: new Date("2030-01-01T00:00:00.000Z"),
      namespace: { id: namespaceId, name: "Archive", slug: "archive" },
    }));
    const transaction = {
      virtualNamespace: {
        findFirst: vi.fn().mockResolvedValue({ id: namespaceId, status: "ACTIVE" }),
      },
      apiCredential: { create },
      activityLog: { create: vi.fn().mockResolvedValue(undefined) },
    };
    const database = {
      $transaction: vi.fn((callback) => callback(transaction)),
    } as unknown as PrismaClient;

    const result = await new ApiCredentialService(database).create(
      organizationId,
      { namespaceId },
      { actorId, requestId: "request-id" },
    );

    const stored = create.mock.calls.at(0)![0].data;
    expect(result.secret).toMatch(/^mosp_secret_/);
    expect(stored.secret).toBeUndefined();
    expect(stored.secretHash).toHaveLength(64);
    expect(stored.secretHash).not.toBe(result.secret);
    expect(result.credential.keyId).toBe(stored.keyId);
  });
});

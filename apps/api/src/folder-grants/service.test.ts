import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@mosp/db";
import { FolderGrantService } from "./service.js";

const organizationId = "10000000-0000-4000-8000-000000000002";
const namespaceId = "10000000-0000-4000-8000-000000000003";
const roleId = "10000000-0000-4000-8000-000000000004";

describe("FolderGrantService", () => {
  it("matches a prefix on a path boundary, not a string prefix alone", async () => {
    const findRole = vi.fn().mockResolvedValue({ id: roleId });
    const findGrants = vi.fn().mockResolvedValue([{ prefix: "photos" }]);
    const database = {
      role: { findFirst: findRole },
      apiCredential: { findFirst: vi.fn() },
      folderGrant: { findMany: findGrants },
    } as unknown as PrismaClient;
    const service = new FolderGrantService(database);

    await expect(
      service.canAccess({
        organizationId,
        namespaceId,
        principalType: "ROLE",
        principalId: roleId,
        action: "read",
        key: "photos/image.jpg",
      }),
    ).resolves.toBe(true);
    await expect(
      service.canAccess({
        organizationId,
        namespaceId,
        principalType: "ROLE",
        principalId: roleId,
        action: "read",
        key: "photos-old/image.jpg",
      }),
    ).resolves.toBe(false);
    expect(findGrants).toHaveBeenCalledTimes(2);
  });

  it("denies access for an inactive API credential", async () => {
    const database = {
      role: { findFirst: vi.fn() },
      apiCredential: { findFirst: vi.fn().mockResolvedValue(null) },
      folderGrant: { findMany: vi.fn() },
    } as unknown as PrismaClient;

    await expect(
      new FolderGrantService(database).canAccess({
        organizationId,
        namespaceId,
        principalType: "API_CREDENTIAL",
        principalId: roleId,
        action: "read",
        key: "photos/image.jpg",
      }),
    ).resolves.toBe(false);
    expect(database.folderGrant.findMany).not.toHaveBeenCalled();
  });
});

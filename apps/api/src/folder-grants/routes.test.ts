import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../app.js";
import type { AuthService } from "../auth/service.js";
import type { OrganizationAccessRepository } from "../auth/organization-access.js";
import type { FolderGrantService } from "./service.js";

const organizationId = "10000000-0000-4000-8000-000000000002";
const namespaceId = "10000000-0000-4000-8000-000000000003";
const roleId = "10000000-0000-4000-8000-000000000004";
const grantId = "10000000-0000-4000-8000-000000000005";
const user = {
  id: "10000000-0000-4000-8000-000000000001",
  email: "owner@example.com",
};

function createFolderGrantApp(permissions: string[]) {
  const authService = {
    session: vi.fn().mockResolvedValue(user),
  } as unknown as AuthService;
  const organizationAccess = {
    findUserAccess: vi.fn().mockResolvedValue({
      membershipStatus: "ACTIVE",
      permissions: new Set(permissions),
    }),
  } as unknown as OrganizationAccessRepository;
  const folderGrantService = {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({
      id: grantId,
      namespaceId,
      prefix: "photos",
      actions: ["read"],
    }),
    delete: vi.fn().mockResolvedValue(undefined),
  } as unknown as FolderGrantService;

  return {
    app: createApp({
      folderGrants: { authService, folderGrantService, organizationAccess },
    }),
    folderGrantService,
  };
}

describe("folder grant routes", () => {
  it("lists grants with the read permission", async () => {
    const { app, folderGrantService } = createFolderGrantApp(["folder_grants:read"]);
    const response = await request(app)
      .get("/v1/folder-grants")
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ grants: [] });
    expect(folderGrantService.list).toHaveBeenCalledWith(organizationId, {});
  });

  it("normalizes a safe prefix and deduplicates actions", async () => {
    const { app, folderGrantService } = createFolderGrantApp(["folder_grants:manage"]);
    const response = await request(app)
      .post("/v1/folder-grants")
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId)
      .send({
        namespaceId,
        principalType: "ROLE",
        principalId: roleId,
        prefix: "/photos/",
        actions: ["read", "read", "write"],
      });

    expect(response.status).toBe(201);
    expect(folderGrantService.create).toHaveBeenCalledWith(
      organizationId,
      {
        namespaceId,
        principalType: "ROLE",
        principalId: roleId,
        prefix: "photos",
        actions: ["read", "write"],
      },
      expect.objectContaining({ actorId: user.id }),
    );
  });

  it("rejects traversal prefixes before the service", async () => {
    const { app, folderGrantService } = createFolderGrantApp(["folder_grants:manage"]);
    const response = await request(app)
      .post("/v1/folder-grants")
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId)
      .send({
        namespaceId,
        principalType: "ROLE",
        principalId: roleId,
        prefix: "photos/../private",
        actions: ["read"],
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "invalid_folder_grant_request" });
    expect(folderGrantService.create).not.toHaveBeenCalled();
  });

  it("requires manage permission for deletion", async () => {
    const { app, folderGrantService } = createFolderGrantApp(["folder_grants:read"]);
    const response = await request(app)
      .delete(`/v1/folder-grants/${grantId}`)
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId);

    expect(response.status).toBe(403);
    expect(folderGrantService.delete).not.toHaveBeenCalled();
  });
});

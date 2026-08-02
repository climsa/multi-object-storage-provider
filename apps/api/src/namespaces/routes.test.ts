import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../app.js";
import type { AuthService } from "../auth/service.js";
import type { OrganizationAccessRepository } from "../auth/organization-access.js";
import type { NamespaceService } from "./service.js";

const organizationId = "10000000-0000-4000-8000-000000000002";
const namespaceId = "10000000-0000-4000-8000-000000000003";
const bucketId = "10000000-0000-4000-8000-000000000004";
const user = {
  id: "10000000-0000-4000-8000-000000000001",
  email: "owner@example.com",
};

function createNamespaceApp(permissions: string[]) {
  const authService = {
    session: vi.fn().mockResolvedValue(user),
  } as unknown as AuthService;
  const organizationAccess = {
    findUserAccess: vi.fn().mockResolvedValue({
      membershipStatus: "ACTIVE",
      permissions: new Set(permissions),
    }),
  } as unknown as OrganizationAccessRepository;
  const namespaceService = {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue({ id: namespaceId }),
    create: vi.fn().mockResolvedValue({
      id: namespaceId,
      quotaBytes: "1000000000",
      maxObjectSizeBytes: null,
      placementPolicy: { targets: [] },
    }),
    update: vi.fn().mockResolvedValue({ id: namespaceId }),
    delete: vi.fn().mockResolvedValue(undefined),
    addTarget: vi.fn().mockResolvedValue({
      id: namespaceId,
      placementPolicy: { targets: [{ bucketConnectionId: bucketId }] },
    }),
    updatePolicy: vi.fn().mockResolvedValue({ id: namespaceId }),
  } as unknown as NamespaceService;

  return {
    app: createApp({
      namespaces: { authService, namespaceService, organizationAccess },
    }),
    namespaceService,
  };
}

describe("namespace routes", () => {
  it("lists namespaces with the read permission", async () => {
    const { app, namespaceService } = createNamespaceApp(["namespaces:read"]);
    const response = await request(app)
      .get("/v1/namespaces")
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ namespaces: [] });
    expect(namespaceService.list).toHaveBeenCalledWith(organizationId);
  });

  it("creates a namespace with a string quota to preserve BIGINT precision", async () => {
    const { app, namespaceService } = createNamespaceApp(["namespaces:create"]);
    const response = await request(app)
      .post("/v1/namespaces")
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId)
      .send({
        name: "Archive",
        slug: "archive",
        quotaBytes: "9223372036854775807",
      });

    expect(response.status).toBe(201);
    expect(namespaceService.create).toHaveBeenCalledWith(
      organizationId,
      {
        name: "Archive",
        slug: "archive",
        quotaBytes: "9223372036854775807",
        defaultTransferMode: "DIRECT",
        versioningMode: "DISABLED",
      },
      expect.objectContaining({ actorId: user.id }),
    );
  });

  it("rejects invalid quota input before calling the service", async () => {
    const { app, namespaceService } = createNamespaceApp(["namespaces:create"]);
    const response = await request(app)
      .post("/v1/namespaces")
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId)
      .send({ name: "Archive", slug: "archive", quotaBytes: 100 });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "invalid_namespace_request" });
    expect(namespaceService.create).not.toHaveBeenCalled();
  });

  it("requires placement policy management for adding a target", async () => {
    const { app, namespaceService } = createNamespaceApp(["namespaces:read"]);
    const response = await request(app)
      .post(`/v1/namespaces/${namespaceId}/targets`)
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId)
      .send({ bucketConnectionId: bucketId });

    expect(response.status).toBe(403);
    expect(namespaceService.addTarget).not.toHaveBeenCalled();
  });

  it("adds a placement target with the placement management permission", async () => {
    const { app, namespaceService } = createNamespaceApp([
      "placement_policies:manage",
    ]);
    const response = await request(app)
      .post(`/v1/namespaces/${namespaceId}/targets`)
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId)
      .send({ bucketConnectionId: bucketId, weight: 200 });

    expect(response.status).toBe(201);
    expect(namespaceService.addTarget).toHaveBeenCalledWith(
      organizationId,
      namespaceId,
      {
        bucketConnectionId: bucketId,
        priorityTier: 0,
        weight: 200,
        thresholdPercent: 100,
        enabled: true,
      },
      expect.objectContaining({ actorId: user.id }),
    );
  });
});

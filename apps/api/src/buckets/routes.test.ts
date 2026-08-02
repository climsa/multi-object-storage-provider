import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../app.js";
import type { AuthService } from "../auth/service.js";
import type { OrganizationAccessRepository } from "../auth/organization-access.js";
import type { ProviderConnectionService } from "../providers/service.js";
import type { BucketConnectionService } from "./service.js";

const organizationId = "10000000-0000-4000-8000-000000000002";
const providerId = "10000000-0000-4000-8000-000000000003";
const bucketId = "10000000-0000-4000-8000-000000000004";
const user = {
  id: "10000000-0000-4000-8000-000000000001",
  email: "owner@example.com",
};

function createBucketApp(permissions: string[]) {
  const authService = {
    session: vi.fn().mockResolvedValue(user),
  } as unknown as AuthService;
  const organizationAccess = {
    findUserAccess: vi.fn().mockResolvedValue({
      membershipStatus: "ACTIVE",
      permissions: new Set(permissions),
    }),
  } as unknown as OrganizationAccessRepository;
  const providerService = {} as ProviderConnectionService;
  const bucketService = {
    listAccessibleBuckets: vi.fn().mockResolvedValue(["photos", "backups"]),
    listConnections: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue({
      id: bucketId,
      bucketName: "photos",
      providerConnectionId: providerId,
      status: "ACTIVE",
      createdAt: "2030-01-01T00:00:00.000Z",
    }),
    import: vi.fn().mockResolvedValue({
      id: bucketId,
      bucketName: "photos",
      providerConnectionId: providerId,
      status: "ACTIVE",
      createdAt: "2030-01-01T00:00:00.000Z",
    }),
    updateStatus: vi.fn().mockResolvedValue({
      id: bucketId,
      bucketName: "photos",
      providerConnectionId: providerId,
      status: "DISABLED",
      createdAt: "2030-01-01T00:00:00.000Z",
    }),
    delete: vi.fn().mockResolvedValue(undefined),
  } as unknown as BucketConnectionService;

  return {
    app: createApp({
      buckets: { authService, bucketService, organizationAccess, providerService },
      providers: {
        authService,
        bucketService,
        organizationAccess,
        providerService,
      },
    }),
    bucketService,
  };
}

describe("bucket routes", () => {
  it("lists accessible provider buckets with the read permission", async () => {
    const { app, bucketService } = createBucketApp(["buckets:read"]);
    const response = await request(app)
      .get(`/v1/providers/${providerId}/buckets`)
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ bucketNames: ["photos", "backups"] });
    expect(bucketService.listAccessibleBuckets).toHaveBeenCalledWith(
      organizationId,
      providerId,
    );
  });

  it("imports a bucket only with the import permission", async () => {
    const { app, bucketService } = createBucketApp(["buckets:import"]);
    const response = await request(app)
      .post("/v1/buckets/import")
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId)
      .send({ providerConnectionId: providerId, bucketName: "photos" });

    expect(response.status).toBe(201);
    expect(response.body.bucket.secretAccessKey).toBeUndefined();
    expect(bucketService.import).toHaveBeenCalledOnce();
  });

  it("returns one bucket connection with the read permission", async () => {
    const { app, bucketService } = createBucketApp(["buckets:read"]);
    const response = await request(app)
      .get(`/v1/buckets/${bucketId}`)
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId);

    expect(response.status).toBe(200);
    expect(response.body.bucket.id).toBe(bucketId);
    expect(bucketService.get).toHaveBeenCalledWith(organizationId, bucketId);
  });

  it("rejects bucket import without the import permission", async () => {
    const { app, bucketService } = createBucketApp(["buckets:read"]);
    const response = await request(app)
      .post("/v1/buckets/import")
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId)
      .send({ providerConnectionId: providerId, bucketName: "photos" });

    expect(response.status).toBe(403);
    expect(bucketService.import).not.toHaveBeenCalled();
  });

  it("updates bucket connection status with the manage permission", async () => {
    const { app, bucketService } = createBucketApp(["buckets:manage"]);
    const response = await request(app)
      .patch(`/v1/buckets/${bucketId}`)
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId)
      .send({ status: "DISABLED" });

    expect(response.status).toBe(200);
    expect(response.body.bucket.status).toBe("DISABLED");
    expect(bucketService.updateStatus).toHaveBeenCalledOnce();
  });

  it("deletes a bucket connection with the manage permission", async () => {
    const { app, bucketService } = createBucketApp(["buckets:manage"]);
    const response = await request(app)
      .delete(`/v1/buckets/${bucketId}`)
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId);

    expect(response.status).toBe(204);
    expect(bucketService.delete).toHaveBeenCalledOnce();
  });
});

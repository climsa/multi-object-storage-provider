import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../app.js";
import { InMemoryRateLimiter } from "../security/rate-limit.js";
import type { AuthService } from "../auth/service.js";
import type { OrganizationAccessRepository } from "../auth/organization-access.js";
import type { BucketConnectionService } from "../buckets/service.js";
import type { ProviderConnectionService } from "./service.js";

const organizationId = "10000000-0000-4000-8000-000000000002";
const providerId = "10000000-0000-4000-8000-000000000003";
const user = {
  id: "10000000-0000-4000-8000-000000000001",
  email: "owner@example.com",
};

function createProviderApp(
  permissions: string[] = ["providers:create", "providers:read", "providers:test"],
  rateLimiter?: InMemoryRateLimiter,
) {
  const authService = {
    session: vi.fn().mockResolvedValue(user),
  } as unknown as AuthService;
  const organizationAccess = {
    findUserAccess: vi.fn().mockResolvedValue({
      membershipStatus: "ACTIVE",
      permissions: new Set(permissions),
    }),
  } as unknown as OrganizationAccessRepository;
  const providerService = {
    create: vi.fn().mockResolvedValue({
      id: providerId,
      displayName: "Test S3",
      type: "GENERIC_S3",
      endpoint: "https://s3.example.com/",
      region: "us-east-1",
      addressingMode: "PATH_STYLE",
      status: "PENDING",
      lastHealthCheckedAt: null,
    }),
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue({
      id: providerId,
      displayName: "Test S3",
      type: "GENERIC_S3",
      endpoint: "https://s3.example.com/",
      region: "us-east-1",
      addressingMode: "PATH_STYLE",
      status: "PENDING",
      lastHealthCheckedAt: null,
    }),
    update: vi.fn().mockResolvedValue({
      id: providerId,
      displayName: "Updated S3",
      type: "GENERIC_S3",
      endpoint: "https://s3.example.com/",
      region: "us-east-1",
      addressingMode: "PATH_STYLE",
      status: "PENDING",
      lastHealthCheckedAt: null,
    }),
    delete: vi.fn().mockResolvedValue(undefined),
    test: vi.fn().mockResolvedValue({ bucketNames: [], capabilities: [], ok: true }),
  } as unknown as ProviderConnectionService;
  const bucketService = {
    listAccessibleBuckets: vi.fn().mockResolvedValue([]),
  } as unknown as BucketConnectionService;
  const providerDependencies = {
    authService,
    bucketService,
    organizationAccess,
    providerService,
    ...(rateLimiter ? { rateLimiter } : {}),
  };

  return {
    app: createApp({ providers: providerDependencies }),
    providerService,
  };
}

describe("provider routes", () => {
  it("rejects requests without bearer authentication", async () => {
    const { app } = createProviderApp();
    const response = await request(app)
      .get("/v1/providers")
      .set("x-organization-id", organizationId);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "unauthenticated" });
  });

  it("enforces organization permission before creating a provider", async () => {
    const { app, providerService } = createProviderApp(["providers:read"]);
    const response = await request(app)
      .post("/v1/providers")
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId)
      .send({
        displayName: "Test S3",
        type: "GENERIC_S3",
        endpoint: "https://s3.example.com",
        region: "us-east-1",
        addressingMode: "PATH_STYLE",
        accessKeyId: "access",
        secretAccessKey: "secret",
      });

    expect(response.status).toBe(403);
    expect(providerService.create).not.toHaveBeenCalled();
  });

  it("creates a provider without returning credentials", async () => {
    const { app, providerService } = createProviderApp();
    const response = await request(app)
      .post("/v1/providers")
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId)
      .send({
        displayName: "Test S3",
        type: "GENERIC_S3",
        endpoint: "https://s3.example.com",
        region: "us-east-1",
        addressingMode: "PATH_STYLE",
        accessKeyId: "access",
        secretAccessKey: "secret",
      });

    expect(response.status).toBe(201);
    expect(response.body.provider.accessKeyId).toBeUndefined();
    expect(response.body.provider.secretAccessKey).toBeUndefined();
    expect(providerService.create).toHaveBeenCalledOnce();
  });

  it("returns a single provider without exposing credentials", async () => {
    const { app, providerService } = createProviderApp(["providers:read"]);
    const response = await request(app)
      .get(`/v1/providers/${providerId}`)
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId);

    expect(response.status).toBe(200);
    expect(response.body.provider.id).toBe(providerId);
    expect(response.body.provider.secretAccessKey).toBeUndefined();
    expect(providerService.get).toHaveBeenCalledWith(organizationId, providerId);
  });

  it("updates a provider only with the update permission", async () => {
    const { app, providerService } = createProviderApp(["providers:update"]);
    const response = await request(app)
      .patch(`/v1/providers/${providerId}`)
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId)
      .send({ displayName: "Updated S3" });

    expect(response.status).toBe(200);
    expect(response.body.provider.displayName).toBe("Updated S3");
    expect(providerService.update).toHaveBeenCalledOnce();
  });

  it("rejects partial provider credential rotation", async () => {
    const { app, providerService } = createProviderApp(["providers:update"]);
    const response = await request(app)
      .patch(`/v1/providers/${providerId}`)
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId)
      .send({ accessKeyId: "new-access" });

    expect(response.status).toBe(400);
    expect(providerService.update).not.toHaveBeenCalled();
  });

  it("deletes a provider only with the delete permission", async () => {
    const { app, providerService } = createProviderApp(["providers:delete"]);
    const response = await request(app)
      .delete(`/v1/providers/${providerId}`)
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId);

    expect(response.status).toBe(204);
    expect(providerService.delete).toHaveBeenCalledOnce();
  });

  it("rate-limits repeated provider reads", async () => {
    const { app, providerService } = createProviderApp(
      ["providers:read"],
      new InMemoryRateLimiter(1, 60_000),
    );
    const auth = { Authorization: "Bearer access-token", "x-organization-id": organizationId };

    await request(app).get("/v1/providers").set(auth);
    const response = await request(app).get("/v1/providers").set(auth);

    expect(response.status).toBe(429);
    expect(providerService.list).toHaveBeenCalledOnce();
  });

  it("returns a safe outage response when provider testing fails", async () => {
    const { app, providerService } = createProviderApp();
    vi.mocked(providerService.test).mockResolvedValue({
      bucketNames: [],
      capabilities: [],
      ok: false,
    });

    const response = await request(app)
      .post(`/v1/providers/${providerId}/test`)
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId)
      .send({});

    expect(response.status).toBe(502);
    expect(response.body).toEqual({ bucketNames: [], capabilities: [], ok: false });
    expect(JSON.stringify(response.body)).not.toContain("provider");
  });
});

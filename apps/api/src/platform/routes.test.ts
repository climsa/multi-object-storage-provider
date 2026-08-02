import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../app.js";
import type { AuthService } from "../auth/service.js";
import type { OrganizationAccessRepository } from "../auth/organization-access.js";
import type { PlatformService } from "./service.js";

const user = { id: "10000000-0000-4000-8000-000000000001", email: "platform@example.com" };

function createPlatformApp(permissions: string[] = ["platform:read", "platform:manage"]) {
  const authService = { session: vi.fn().mockResolvedValue(user) } as unknown as AuthService;
  const organizationAccess = {
    findGlobalAccess: vi.fn().mockResolvedValue({ permissions: new Set(permissions) }),
  } as unknown as OrganizationAccessRepository;
  const platformService = {
    listOrganizations: vi.fn().mockResolvedValue([{ id: "20000000-0000-4000-8000-000000000001", name: "Example", slug: "example", status: "ACTIVE", createdAt: "2030-01-01T00:00:00.000Z" }]),
    getSettings: vi.fn().mockResolvedValue([{ key: "maintenance_mode", value: false, version: 0, updatedAt: null, updatedBy: null }]),
    updateSettings: vi.fn().mockResolvedValue([{ key: "maintenance_mode", value: true, version: 1, updatedAt: "2030-01-01T00:00:00.000Z", updatedBy: user }]),
  } as unknown as PlatformService;
  return {
    app: createApp({ platform: { authService, organizationAccess, platformService } }),
    platformService,
  };
}

describe("platform routes", () => {
  it("rejects a global settings request without bearer authentication", async () => {
    const { app } = createPlatformApp();
    const response = await request(app).get("/v1/platform/settings");
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "unauthenticated" });
  });

  it("requires the platform read permission", async () => {
    const { app, platformService } = createPlatformApp([]);
    const response = await request(app).get("/v1/platform/settings").set("Authorization", "Bearer token");
    expect(response.status).toBe(403);
    expect(platformService.getSettings).not.toHaveBeenCalled();
  });

  it("updates settings only with platform manage permission", async () => {
    const { app, platformService } = createPlatformApp(["platform:read"]);
    const response = await request(app)
      .put("/v1/platform/settings")
      .set("Authorization", "Bearer token")
      .send({ values: { maintenance_mode: true } });
    expect(response.status).toBe(403);
    expect(platformService.updateSettings).not.toHaveBeenCalled();
  });

  it("updates settings with an audit request id", async () => {
    const { app, platformService } = createPlatformApp();
    const response = await request(app)
      .put("/v1/platform/settings")
      .set("Authorization", "Bearer token")
      .set("x-request-id", "platform-settings-test")
      .send({ values: { maintenance_mode: true }, expectedVersions: { maintenance_mode: 0 } });
    expect(response.status).toBe(200);
    expect(platformService.updateSettings).toHaveBeenCalledWith(
      { values: { maintenance_mode: true }, expectedVersions: { maintenance_mode: 0 } },
      { actorId: user.id, requestId: "platform-settings-test" },
    );
  });

  it("accepts bounded proxy settings through the platform contract", async () => {
    const { app, platformService } = createPlatformApp();
    const response = await request(app)
      .put("/v1/platform/settings")
      .set("Authorization", "Bearer token")
      .send({
        values: {
          proxy_max_object_size_bytes: "5242880",
          proxy_transfer_timeout_seconds: 45,
        },
      });

    expect(response.status).toBe(200);
    expect(platformService.updateSettings).toHaveBeenCalledWith(
      { values: { proxy_max_object_size_bytes: "5242880", proxy_transfer_timeout_seconds: 45 } },
      { actorId: user.id, requestId: expect.any(String) },
    );
  });

  it("rejects proxy settings outside safe bounds", async () => {
    const { app, platformService } = createPlatformApp();
    const response = await request(app)
      .put("/v1/platform/settings")
      .set("Authorization", "Bearer token")
      .send({ values: { proxy_transfer_timeout_seconds: 301 } });

    expect(response.status).toBe(400);
    expect(platformService.updateSettings).not.toHaveBeenCalled();
  });
});

import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../app.js";
import type { AuthService } from "../auth/service.js";
import type { OrganizationAccessRepository } from "../auth/organization-access.js";
import type { ObjectExplorerService } from "./service.js";

const organizationId = "10000000-0000-4000-8000-000000000002";
const user = { id: "10000000-0000-4000-8000-000000000001", email: "owner@example.com" };

function createExplorerApp(permissions: string[]) {
  const authService = { session: vi.fn().mockResolvedValue(user) } as unknown as AuthService;
  const organizationAccess = {
    findUserAccess: vi.fn().mockResolvedValue({ membershipStatus: "ACTIVE", permissions: new Set(permissions) }),
  } as unknown as OrganizationAccessRepository;
  const objectExplorerService = {
    listNamespaces: vi.fn().mockResolvedValue([{ id: "namespace-id", name: "Camera", slug: "camera", status: "ACTIVE" }]),
    list: vi.fn().mockResolvedValue([]),
    listFolders: vi.fn().mockResolvedValue([]),
    createFolder: vi.fn().mockResolvedValue({ prefix: "photos/" }),
    upload: vi.fn().mockResolvedValue({ key: "photos/image.jpg", sizeBytes: "3" }),
    presignDownload: vi.fn().mockResolvedValue({ expiresAt: "2026-01-01T00:15:00.000Z", url: "https://storage.example/download" }),
    delete: vi.fn().mockResolvedValue(undefined),
  } as unknown as ObjectExplorerService;
  return {
    app: createApp({ objectExplorer: { authService, organizationAccess, objectExplorerService } }),
    objectExplorerService,
  };
}

describe("object explorer routes", () => {
  it("lists namespaces only with the object list permission", async () => {
    const { app, objectExplorerService } = createExplorerApp(["objects:list"]);
    const response = await request(app)
      .get("/v1/object-explorer/namespaces")
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId);

    expect(response.status).toBe(200);
    expect(response.body.namespaces).toHaveLength(1);
    expect(objectExplorerService.listNamespaces).toHaveBeenCalledWith(organizationId);
  });

  it("rejects object listing without permission", async () => {
    const { app, objectExplorerService } = createExplorerApp([]);
    const response = await request(app)
      .get("/v1/object-explorer/camera/objects")
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId);

    expect(response.status).toBe(403);
    expect(objectExplorerService.list).not.toHaveBeenCalled();
  });

  it("validates object prefixes before calling the list service", async () => {
    const { app, objectExplorerService } = createExplorerApp(["objects:list"]);
    const response = await request(app)
      .get("/v1/object-explorer/camera/objects?prefix=folder%2F..%2Fsecret.txt")
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId);

    expect(response.status).toBe(400);
    expect(objectExplorerService.list).not.toHaveBeenCalled();
  });

  it("returns a presigned transfer only with read permission", async () => {
    const { app, objectExplorerService } = createExplorerApp(["objects:read"]);
    const response = await request(app)
      .get("/v1/object-explorer/camera/download/folder/photo.jpg")
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId);

    expect(response.status).toBe(200);
    expect(response.body.transfer.url).toBe("https://storage.example/download");
    expect(objectExplorerService.presignDownload).toHaveBeenCalledWith(organizationId, "camera", "folder/photo.jpg");
  });

  it("requires write permission for folder creation", async () => {
    const { app, objectExplorerService } = createExplorerApp(["objects:list"]);
    const response = await request(app)
      .post("/v1/object-explorer/camera/folders")
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId)
      .send({ prefix: "photos/" });

    expect(response.status).toBe(403);
    expect(objectExplorerService.createFolder).not.toHaveBeenCalled();
  });

  it("creates a folder with the write permission", async () => {
    const { app, objectExplorerService } = createExplorerApp(["objects:write"]);
    const response = await request(app)
      .post("/v1/object-explorer/camera/folders")
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId)
      .send({ prefix: "photos/" });

    expect(response.status).toBe(201);
    expect(objectExplorerService.createFolder).toHaveBeenCalledWith(
      organizationId,
      "camera",
      "photos/",
      user.id,
      expect.any(String),
    );
  });

  it("requires a content length for admin uploads", async () => {
    const { app, objectExplorerService } = createExplorerApp(["objects:write"]);
    const response = await request(app)
      .put("/v1/object-explorer/camera/objects/photos/image.jpg")
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId)
      .set("x-mosp-content-length", "not-a-number")
      .set("content-type", "text/plain")
      .send("abc");

    expect(response.status).toBe(411);
    expect(objectExplorerService.upload).not.toHaveBeenCalled();
  });

  it("accepts a bounded upload with the write permission", async () => {
    const { app, objectExplorerService } = createExplorerApp(["objects:write"]);
    const response = await request(app)
      .put("/v1/object-explorer/camera/objects/photos/image.jpg")
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId)
      .set("x-mosp-content-length", "3")
      .set("content-type", "application/octet-stream")
      .send("abc");

    expect(response.status).toBe(201);
    expect(objectExplorerService.upload).toHaveBeenCalledWith(
      organizationId,
      "camera",
      "photos/image.jpg",
      expect.anything(),
      3n,
      null,
      user.id,
      expect.any(String),
    );
  });
});

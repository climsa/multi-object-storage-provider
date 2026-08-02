import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../app.js";
import type { AuthService } from "../auth/service.js";
import type { OrganizationAccessRepository } from "../auth/organization-access.js";
import type { ApiCredentialService } from "./service.js";

const organizationId = "10000000-0000-4000-8000-000000000002";
const namespaceId = "10000000-0000-4000-8000-000000000003";
const credentialId = "10000000-0000-4000-8000-000000000004";
const user = {
  id: "10000000-0000-4000-8000-000000000001",
  email: "owner@example.com",
};

function createCredentialApp(permissions: string[]) {
  const authService = {
    session: vi.fn().mockResolvedValue(user),
  } as unknown as AuthService;
  const organizationAccess = {
    findUserAccess: vi.fn().mockResolvedValue({
      membershipStatus: "ACTIVE",
      permissions: new Set(permissions),
    }),
  } as unknown as OrganizationAccessRepository;
  const summary = {
    id: credentialId,
    keyId: "mosp_public-key",
    namespace: { id: namespaceId, name: "Archive", slug: "archive" },
    status: "ACTIVE",
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    createdById: user.id,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
  };
  const apiCredentialService = {
    list: vi.fn().mockResolvedValue([summary]),
    create: vi.fn().mockResolvedValue({ credential: summary, secret: "one-time-secret" }),
    rotate: vi.fn().mockResolvedValue({ credential: summary, secret: "rotated-secret" }),
    revoke: vi.fn().mockResolvedValue({ ...summary, status: "REVOKED" }),
  } as unknown as ApiCredentialService;

  return {
    app: createApp({
      apiCredentials: { apiCredentialService, authService, organizationAccess },
    }),
    apiCredentialService,
  };
}

describe("api credential routes", () => {
  it("lists metadata without returning a secret", async () => {
    const { app, apiCredentialService } = createCredentialApp([
      "api_credentials:read",
    ]);
    const response = await request(app)
      .get("/v1/api-credentials")
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId);

    expect(response.status).toBe(200);
    expect(response.body.credentials[0].secret).toBeUndefined();
    expect(apiCredentialService.list).toHaveBeenCalledWith(organizationId);
  });

  it("returns the generated secret on create", async () => {
    const { app, apiCredentialService } = createCredentialApp([
      "api_credentials:create",
    ]);
    const response = await request(app)
      .post("/v1/api-credentials")
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId)
      .send({ namespaceId });

    expect(response.status).toBe(201);
    expect(response.body.secret).toBe("one-time-secret");
    expect(apiCredentialService.create).toHaveBeenCalledWith(
      organizationId,
      { namespaceId },
      expect.objectContaining({ actorId: user.id }),
    );
  });

  it("requires the dedicated rotate permission", async () => {
    const { app, apiCredentialService } = createCredentialApp([
      "api_credentials:read",
    ]);
    const response = await request(app)
      .post(`/v1/api-credentials/${credentialId}/rotate`)
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId)
      .send({});

    expect(response.status).toBe(403);
    expect(apiCredentialService.rotate).not.toHaveBeenCalled();
  });

  it("rotates and returns the replacement secret", async () => {
    const { app, apiCredentialService } = createCredentialApp([
      "api_credentials:rotate",
    ]);
    const response = await request(app)
      .post(`/v1/api-credentials/${credentialId}/rotate`)
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId)
      .send({});

    expect(response.status).toBe(200);
    expect(response.body.secret).toBe("rotated-secret");
    expect(apiCredentialService.rotate).toHaveBeenCalledOnce();
  });

  it("revokes a credential with the revoke permission", async () => {
    const { app, apiCredentialService } = createCredentialApp([
      "api_credentials:revoke",
    ]);
    const response = await request(app)
      .post(`/v1/api-credentials/${credentialId}/revoke`)
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId);

    expect(response.status).toBe(200);
    expect(response.body.credential.status).toBe("REVOKED");
    expect(response.body.credential.secret).toBeUndefined();
    expect(apiCredentialService.revoke).toHaveBeenCalledOnce();
  });
});

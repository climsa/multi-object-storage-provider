import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../app.js";
import type { AuthService } from "../auth/service.js";
import type { OrganizationAccessRepository } from "../auth/organization-access.js";
import type { UsageService } from "../usage/service.js";
import type { OrganizationService } from "./service.js";

const organizationId = "10000000-0000-4000-8000-000000000002";
const otherOrganizationId = "10000000-0000-4000-8000-000000000005";
const membershipId = "10000000-0000-4000-8000-000000000006";
const roleId = "10000000-0000-4000-8000-000000000007";
const user = {
  id: "10000000-0000-4000-8000-000000000001",
  email: "owner@example.com",
};

function createOrganizationApp(permissions: string[]) {
  const authService = {
    session: vi.fn().mockResolvedValue(user),
  } as unknown as AuthService;
  const organizationAccess = {
    findUserAccess: vi.fn().mockResolvedValue({
      membershipStatus: "ACTIVE",
      permissions: new Set(permissions),
    }),
  } as unknown as OrganizationAccessRepository;
  const organizationService = {
    get: vi.fn().mockResolvedValue({
      id: organizationId,
      name: "Example organization",
      slug: "example",
      status: "ACTIVE",
    }),
    update: vi.fn().mockResolvedValue({
      id: organizationId,
      name: "Renamed organization",
      slug: "example",
      status: "ACTIVE",
    }),
    listActivityLogs: vi.fn().mockResolvedValue({
      items: [
        {
          id: "42",
          action: "roles.create",
          entityType: "Role",
          entityId: roleId,
          metadata: { name: "Storage Reader" },
          requestId: "request-42",
          createdAt: "2030-01-01T00:00:00.000Z",
          actor: user,
        },
      ],
      nextCursor: "42",
    }),
    listMembers: vi.fn().mockResolvedValue([
      {
        id: membershipId,
        userId: user.id,
        email: user.email,
        status: "ACTIVE",
        roles: ["Organization Owner"],
      },
    ]),
    listRoles: vi.fn().mockResolvedValue([
      { id: roleId, name: "Organization Owner", isSystem: true, permissionKeys: [] },
    ]),
    createRole: vi.fn().mockResolvedValue({
      id: roleId,
      name: "Storage Reader",
      isSystem: false,
      permissionKeys: ["providers:read"],
    }),
    updateRole: vi.fn().mockResolvedValue({
      id: roleId,
      name: "Storage Admin",
      isSystem: false,
      permissionKeys: ["providers:read", "providers:test"],
    }),
    deleteRole: vi.fn().mockResolvedValue(undefined),
    addMember: vi.fn().mockResolvedValue({
      id: membershipId,
      userId: "10000000-0000-4000-8000-000000000008",
      email: "member@example.com",
      status: "INVITED",
      roles: [],
    }),
    updateMemberStatus: vi.fn().mockResolvedValue({
      id: membershipId,
      userId: user.id,
      email: user.email,
      status: "DISABLED",
      roles: ["Organization Owner"],
    }),
    assignRole: vi.fn().mockResolvedValue({
      id: membershipId,
      userId: user.id,
      email: user.email,
      status: "ACTIVE",
      roles: ["Organization Owner"],
    }),
  } as unknown as OrganizationService;
  const usageService = {
    list: vi.fn().mockResolvedValue({
      namespaces: [],
      nextCursor: null,
      totals: {
        usedBytes: "0",
        reservedBytes: "0",
        objectCount: "0",
        activeUploadCount: 0,
        requestCount: "0",
        ingressBytes: "0",
        egressBytes: "0",
      },
    }),
  } as unknown as UsageService;

  return {
    app: createApp({
      organizations: { authService, organizationAccess, organizationService, usageService },
    }),
    organizationService,
    usageService,
  };
}

describe("organization routes", () => {
  it("requires the path organization to match the authorized organization", async () => {
    const { app, organizationService } = createOrganizationApp(["organizations:read"]);
    const response = await request(app)
      .get(`/v1/organizations/${otherOrganizationId}`)
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId);

    expect(response.status).toBe(400);
    expect(organizationService.get).not.toHaveBeenCalled();
  });

  it("returns organization members only with the member read permission", async () => {
    const { app, organizationService } = createOrganizationApp(["members:read"]);
    const response = await request(app)
      .get(`/v1/organizations/${organizationId}/members`)
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId);

    expect(response.status).toBe(200);
    expect(response.body.members[0].email).toBe(user.email);
    expect(organizationService.listMembers).toHaveBeenCalledWith(organizationId);
  });

  it("returns paginated activity logs only with audit read permission", async () => {
    const { app, organizationService } = createOrganizationApp(["audit:read"]);
    const response = await request(app)
      .get(`/v1/organizations/${organizationId}/activity-logs`)
      .query({ limit: "2", cursor: "10", action: "roles.create" })
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId);

    expect(response.status).toBe(200);
    expect(response.body.activityLogs[0].id).toBe("42");
    expect(response.body.nextCursor).toBe("42");
    expect(organizationService.listActivityLogs).toHaveBeenCalledWith(
      organizationId,
      { limit: 2, cursor: "10", action: "roles.create" },
    );
  });

  it("rejects invalid activity log pagination", async () => {
    const { app, organizationService } = createOrganizationApp(["audit:read"]);
    const response = await request(app)
      .get(`/v1/organizations/${organizationId}/activity-logs`)
      .query({ limit: "101" })
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId);

    expect(response.status).toBe(400);
    expect(organizationService.listActivityLogs).not.toHaveBeenCalled();
  });

  it("returns usage only with the usage read permission and matching organization", async () => {
    const { app, usageService } = createOrganizationApp(["usage:read"]);
    const response = await request(app)
      .get(`/v1/organizations/${organizationId}/usage`)
      .query({ limit: "10" })
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId);

    expect(response.status).toBe(200);
    expect(response.body.usage.totals.usedBytes).toBe("0");
    expect(usageService.list).toHaveBeenCalledWith(organizationId, { limit: 10 });
  });

  it("rejects usage access from another organization without calling the service", async () => {
    const { app, usageService } = createOrganizationApp(["usage:read"]);
    const response = await request(app)
      .get(`/v1/organizations/${otherOrganizationId}/usage`)
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId);

    expect(response.status).toBe(400);
    expect(usageService.list).not.toHaveBeenCalled();
  });

  it("exports usage as bounded CSV with a continuation cursor", async () => {
    const { app, usageService } = createOrganizationApp(["usage:read"]);
    vi.mocked(usageService.list).mockResolvedValue({
      namespaces: [],
      nextCursor: "10000000-0000-4000-8000-000000000004",
      totals: {
        usedBytes: "0",
        reservedBytes: "0",
        objectCount: "0",
        activeUploadCount: 0,
        requestCount: "0",
        ingressBytes: "0",
        egressBytes: "0",
      },
    });

    const response = await request(app)
      .get(`/v1/organizations/${organizationId}/usage/export`)
      .query({ limit: "2" })
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.headers["x-next-cursor"]).toBe("10000000-0000-4000-8000-000000000004");
    expect(response.text).toContain("namespace_id");
    expect(usageService.list).toHaveBeenCalledWith(organizationId, { limit: 2 });
  });

  it("updates member status with the update permission", async () => {
    const { app, organizationService } = createOrganizationApp(["members:update"]);
    const response = await request(app)
      .patch(`/v1/organizations/${organizationId}/members/${membershipId}`)
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId)
      .send({ status: "DISABLED" });

    expect(response.status).toBe(200);
    expect(response.body.member.status).toBe("DISABLED");
    expect(organizationService.updateMemberStatus).toHaveBeenCalledOnce();
  });

  it("lists organization roles with the role read permission", async () => {
    const { app, organizationService } = createOrganizationApp(["roles:read"]);
    const response = await request(app)
      .get(`/v1/organizations/${organizationId}/roles`)
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId);

    expect(response.status).toBe(200);
    expect(response.body.roles[0].id).toBe(roleId);
    expect(organizationService.listRoles).toHaveBeenCalledWith(organizationId);
  });

  it("adds an existing user as an invited member", async () => {
    const { app, organizationService } = createOrganizationApp(["members:create"]);
    const response = await request(app)
      .post(`/v1/organizations/${organizationId}/members`)
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId)
      .send({ email: "member@example.com", roleId });

    expect(response.status).toBe(201);
    expect(response.body.member.status).toBe("INVITED");
    expect(organizationService.addMember).toHaveBeenCalledWith(
      organizationId,
      { email: "member@example.com", roleId },
      expect.anything(),
    );
  });

  it("assigns a role only with the role assignment permission", async () => {
    const { app, organizationService } = createOrganizationApp(["roles:assign"]);
    const response = await request(app)
      .post(`/v1/organizations/${organizationId}/members/${membershipId}/roles`)
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId)
      .send({ roleId });

    expect(response.status).toBe(200);
    expect(response.body.member.roles).toContain("Organization Owner");
    expect(organizationService.assignRole).toHaveBeenCalledOnce();
  });

  it("creates a custom role with the role create permission", async () => {
    const { app, organizationService } = createOrganizationApp(["roles:create", "permissions:manage"]);
    const response = await request(app)
      .post(`/v1/organizations/${organizationId}/roles`)
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId)
      .send({ name: "Storage Reader", permissionKeys: ["providers:read"] });

    expect(response.status).toBe(201);
    expect(response.body.role.permissionKeys).toEqual(["providers:read"]);
    expect(organizationService.createRole).toHaveBeenCalledOnce();
  });

  it("requires permission management authority to set role permissions", async () => {
    const { app, organizationService } = createOrganizationApp(["roles:create"]);
    const response = await request(app)
      .post(`/v1/organizations/${organizationId}/roles`)
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId)
      .send({ name: "Storage Reader", permissionKeys: ["providers:read"] });

    expect(response.status).toBe(403);
    expect(organizationService.createRole).not.toHaveBeenCalled();
  });

  it("updates a custom role with the role update permission", async () => {
    const { app, organizationService } = createOrganizationApp(["roles:update", "permissions:manage"]);
    const response = await request(app)
      .patch(`/v1/organizations/${organizationId}/roles/${roleId}`)
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId)
      .send({ name: "Storage Admin", permissionKeys: ["providers:read", "providers:test"] });

    expect(response.status).toBe(200);
    expect(response.body.role.name).toBe("Storage Admin");
    expect(organizationService.updateRole).toHaveBeenCalledOnce();
  });

  it("deletes a role with the role delete permission", async () => {
    const { app, organizationService } = createOrganizationApp(["roles:delete"]);
    const response = await request(app)
      .delete(`/v1/organizations/${organizationId}/roles/${roleId}`)
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId);

    expect(response.status).toBe(204);
    expect(organizationService.deleteRole).toHaveBeenCalledOnce();
  });
});

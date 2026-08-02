import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../app.js";
import type { AuthService } from "../auth/service.js";
import type { OrganizationAccessRepository } from "../auth/organization-access.js";
import type { MigrationService } from "./service.js";

const organizationId = "10000000-0000-4000-8000-000000000002";
const userId = "10000000-0000-4000-8000-000000000001";
const migration = {
  id: "10000000-0000-4000-8000-000000000010",
  namespaceId: "10000000-0000-4000-8000-000000000003",
  sourceBucketConnectionId: "10000000-0000-4000-8000-000000000011",
  targetBucketConnectionId: "10000000-0000-4000-8000-000000000012",
  state: "CREATED",
  totalItems: 1,
  completedItems: 0,
  failedItems: 0,
  lastError: null,
  startedAt: null,
  completedAt: null,
  createdAt: "2030-01-01T00:00:00.000Z",
  updatedAt: "2030-01-01T00:00:00.000Z",
};

function createMigrationApp() {
  const authService = {
    session: vi.fn().mockResolvedValue({ id: userId, email: "admin@example.com" }),
  } as unknown as AuthService;
  const organizationAccess = {
    findUserAccess: vi.fn().mockResolvedValue({
      membershipStatus: "ACTIVE",
      permissions: new Set(["migrations:create", "migrations:read", "migrations:control"]),
    }),
  } as unknown as OrganizationAccessRepository;
  const migrationService = {
    list: vi.fn().mockResolvedValue([migration]),
    get: vi.fn().mockResolvedValue(migration),
    create: vi.fn().mockResolvedValue(migration),
    control: vi.fn().mockResolvedValue({ ...migration, state: "RUNNING" }),
  } as unknown as MigrationService;
  return {
    app: createApp({ migrations: { authService, organizationAccess, migrationService } }),
    migrationService,
  };
}

describe("migration routes", () => {
  it("requires organization scope and forwards a bounded create request", async () => {
    const { app, migrationService } = createMigrationApp();
    const response = await request(app)
      .post("/v1/migrations")
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId)
      .send({
        namespaceId: migration.namespaceId,
        sourceBucketConnectionId: migration.sourceBucketConnectionId,
        targetBucketConnectionId: migration.targetBucketConnectionId,
      });

    expect(response.status).toBe(201);
    expect(migrationService.create).toHaveBeenCalledWith(
      organizationId,
      {
        namespaceId: migration.namespaceId,
        sourceBucketConnectionId: migration.sourceBucketConnectionId,
        targetBucketConnectionId: migration.targetBucketConnectionId,
      },
      expect.objectContaining({ actorId: userId }),
    );
  });

  it("does not expose a migration outside the organization scope", async () => {
    const { app, migrationService } = createMigrationApp();
    const response = await request(app)
      .get(`/v1/migrations/${migration.id}`)
      .set("Authorization", "Bearer access-token")
      .set("x-organization-id", organizationId);

    expect(response.status).toBe(200);
    expect(migrationService.get).toHaveBeenCalledWith(organizationId, migration.id);
  });
});

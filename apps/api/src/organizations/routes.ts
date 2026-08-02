import { Router, type Request, type Response } from "express";
import { z, ZodError } from "zod";

import {
  activityLogQuerySchema,
  memberAddRequestSchema,
  memberStatusUpdateRequestSchema,
  organizationUpdateRequestSchema,
  roleAssignmentRequestSchema,
  roleCreateRequestSchema,
  roleUpdateRequestSchema,
} from "@mosp/shared";

import { authorize } from "../auth/authorize.js";
import { type AuthService } from "../auth/service.js";
import { type OrganizationAccessRepository } from "../auth/organization-access.js";
import { requestIdFromHeader } from "../security/request-id.js";
import { UsageService, type UsageQuery } from "../usage/service.js";
import {
  MemberNotFound,
  OrganizationNotFound,
  OrganizationService,
  PermissionNotFound,
  RoleInUse,
  RoleNotFound,
  SystemRoleProtected,
  UserNotFound,
} from "./service.js";

export interface OrganizationRouteDependencies {
  authService: AuthService;
  organizationAccess: OrganizationAccessRepository;
  organizationService: OrganizationService;
  usageService?: UsageService;
}

const usageQuerySchema = z
  .object({
    cursor: z.string().uuid().optional(),
    limit: z
      .string()
      .regex(/^\d{1,3}$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(100))
      .optional(),
  })
  .strict()
  .transform((input): UsageQuery => input.cursor
    ? { cursor: input.cursor, limit: input.limit ?? 50 }
    : { limit: input.limit ?? 50 });

function organizationId(request: Request): string | null {
  const parsed = z.string().uuid().safeParse(request.params.organizationId);
  return parsed.success ? parsed.data : null;
}

function membershipId(request: Request): string | null {
  const parsed = z.string().uuid().safeParse(request.params.membershipId);
  return parsed.success ? parsed.data : null;
}

function roleId(request: Request): string | null {
  const parsed = z.string().uuid().safeParse(request.params.roleId);
  return parsed.success ? parsed.data : null;
}

function assertPathScope(pathId: string | null, authorizedId: string): string | null {
  return pathId && pathId === authorizedId ? pathId : null;
}

function sendOrganizationError(
  response: Response,
  error: unknown,
  conflictError = "organization_conflict",
): void {
  if (error instanceof ZodError) {
    response.status(400).json({ error: "invalid_organization_request" });
    return;
  }
  if (error instanceof OrganizationNotFound) {
    response.status(404).json({ error: "organization_not_found" });
    return;
  }
  if (error instanceof MemberNotFound) {
    response.status(404).json({ error: "member_not_found" });
    return;
  }
  if (error instanceof UserNotFound) {
    response.status(404).json({ error: "user_not_found" });
    return;
  }
  if (error instanceof RoleNotFound) {
    response.status(404).json({ error: "role_not_found" });
    return;
  }
  if (error instanceof PermissionNotFound) {
    response.status(400).json({ error: "invalid_role_permissions" });
    return;
  }
  if (error instanceof RoleInUse) {
    response.status(409).json({ error: "role_in_use" });
    return;
  }
  if (error instanceof SystemRoleProtected) {
    response.status(409).json({ error: "system_role_protected" });
    return;
  }
  if (error instanceof Error && error.message === "UNAUTHENTICATED") {
    response.status(401).json({ error: "unauthenticated" });
    return;
  }
  if (error instanceof Error && error.message === "FORBIDDEN") {
    response.status(403).json({ error: "forbidden" });
    return;
  }
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  ) {
    response.status(409).json({ error: conflictError });
    return;
  }
  response.status(500).json({ error: "internal_error" });
}

export function createOrganizationRouter(
  dependencies: OrganizationRouteDependencies,
) {
  const router = Router();

  router.get("/:organizationId", async (request, response) => {
    try {
      const context = await authorize(request, dependencies, "organizations:read");
      const id = assertPathScope(organizationId(request), context.organizationId);
      if (!id) {
        response.status(400).json({ error: "invalid_organization_request" });
        return;
      }
      response.json({ organization: await dependencies.organizationService.get(id) });
    } catch (error) {
      sendOrganizationError(response, error);
    }
  });

  router.patch("/:organizationId", async (request, response) => {
    try {
      const context = await authorize(request, dependencies, "organizations:update");
      const id = assertPathScope(organizationId(request), context.organizationId);
      if (!id) {
        response.status(400).json({ error: "invalid_organization_request" });
        return;
      }
      const input = organizationUpdateRequestSchema.parse(request.body);
      const organization = await dependencies.organizationService.update(
        id,
        input,
        {
          actorId: context.userId,
          requestId: requestIdFromHeader(request.header("x-request-id")),
        },
      );
      response.json({ organization });
    } catch (error) {
      sendOrganizationError(response, error);
    }
  });

  router.get("/:organizationId/activity-logs", async (request, response) => {
    try {
      const context = await authorize(request, dependencies, "audit:read");
      const id = assertPathScope(organizationId(request), context.organizationId);
      if (!id) {
        response.status(400).json({ error: "invalid_organization_request" });
        return;
      }
      const query = activityLogQuerySchema.parse(request.query);
      const page = await dependencies.organizationService.listActivityLogs(id, query);
      response.json({ activityLogs: page.items, nextCursor: page.nextCursor });
    } catch (error) {
      sendOrganizationError(response, error);
    }
  });

  const usageService = dependencies.usageService;
  if (usageService) {
    router.get("/:organizationId/usage", async (request, response) => {
      try {
        const context = await authorize(request, dependencies, "usage:read");
        const id = assertPathScope(organizationId(request), context.organizationId);
        if (!id) {
          response.status(400).json({ error: "invalid_organization_request" });
          return;
        }
        const query = usageQuerySchema.parse(request.query);
        response.json({ usage: await usageService.list(id, query) });
      } catch (error) {
        sendOrganizationError(response, error);
      }
    });

    router.get("/:organizationId/usage/export", async (request, response) => {
      try {
        const context = await authorize(request, dependencies, "usage:read");
        const id = assertPathScope(organizationId(request), context.organizationId);
        if (!id) {
          response.status(400).json({ error: "invalid_organization_request" });
          return;
        }
        const query = usageQuerySchema.parse(request.query);
        const page = await usageService.list(id, query);
        response.type("text/csv");
        response.setHeader(
          "Content-Disposition",
          `attachment; filename="usage-${id}.csv"`,
        );
        if (page.nextCursor) response.setHeader("X-Next-Cursor", page.nextCursor);
        response.send(UsageService.toCsv(page));
      } catch (error) {
        sendOrganizationError(response, error);
      }
    });
  }

  router.get("/:organizationId/members", async (request, response) => {
    try {
      const context = await authorize(request, dependencies, "members:read");
      const id = assertPathScope(organizationId(request), context.organizationId);
      if (!id) {
        response.status(400).json({ error: "invalid_organization_request" });
        return;
      }
      response.json({ members: await dependencies.organizationService.listMembers(id) });
    } catch (error) {
      sendOrganizationError(response, error);
    }
  });

  router.get("/:organizationId/roles", async (request, response) => {
    try {
      const context = await authorize(request, dependencies, "roles:read");
      const id = assertPathScope(organizationId(request), context.organizationId);
      if (!id) {
        response.status(400).json({ error: "invalid_organization_request" });
        return;
      }
      response.json({ roles: await dependencies.organizationService.listRoles(id) });
    } catch (error) {
      sendOrganizationError(response, error);
    }
  });

  router.post("/:organizationId/roles", async (request, response) => {
    try {
      const context = await authorize(request, dependencies, "roles:create");
      const id = assertPathScope(organizationId(request), context.organizationId);
      if (!id) {
        response.status(400).json({ error: "invalid_organization_request" });
        return;
      }
      const input = roleCreateRequestSchema.parse(request.body);
      if (input.permissionKeys.length > 0) {
        await authorize(request, dependencies, "permissions:manage");
      }
      const role = await dependencies.organizationService.createRole(
        id,
        input,
        {
          actorId: context.userId,
          requestId: requestIdFromHeader(request.header("x-request-id")),
        },
      );
      response.status(201).json({ role });
    } catch (error) {
      sendOrganizationError(response, error, "role_already_exists");
    }
  });

  router.patch("/:organizationId/roles/:roleId", async (request, response) => {
    try {
      const context = await authorize(request, dependencies, "roles:update");
      const orgId = assertPathScope(organizationId(request), context.organizationId);
      const id = roleId(request);
      if (!orgId || !id) {
        response.status(400).json({ error: "invalid_organization_request" });
        return;
      }
      const input = roleUpdateRequestSchema.parse(request.body);
      if (input.permissionKeys !== undefined) {
        await authorize(request, dependencies, "permissions:manage");
      }
      const role = await dependencies.organizationService.updateRole(
        orgId,
        id,
        input,
        {
          actorId: context.userId,
          requestId: requestIdFromHeader(request.header("x-request-id")),
        },
      );
      response.json({ role });
    } catch (error) {
      sendOrganizationError(response, error, "role_already_exists");
    }
  });

  router.delete("/:organizationId/roles/:roleId", async (request, response) => {
    try {
      const context = await authorize(request, dependencies, "roles:delete");
      const orgId = assertPathScope(organizationId(request), context.organizationId);
      const id = roleId(request);
      if (!orgId || !id) {
        response.status(400).json({ error: "invalid_organization_request" });
        return;
      }
      await dependencies.organizationService.deleteRole(orgId, id, {
        actorId: context.userId,
        requestId: requestIdFromHeader(request.header("x-request-id")),
      });
      response.status(204).end();
    } catch (error) {
      sendOrganizationError(response, error);
    }
  });

  router.post("/:organizationId/members", async (request, response) => {
    try {
      const context = await authorize(request, dependencies, "members:create");
      const id = assertPathScope(organizationId(request), context.organizationId);
      if (!id) {
        response.status(400).json({ error: "invalid_organization_request" });
        return;
      }
      const member = await dependencies.organizationService.addMember(
        id,
        memberAddRequestSchema.parse(request.body),
        {
          actorId: context.userId,
          requestId: requestIdFromHeader(request.header("x-request-id")),
        },
      );
      response.status(201).json({ member });
    } catch (error) {
      sendOrganizationError(response, error);
    }
  });

  router.patch("/:organizationId/members/:membershipId", async (request, response) => {
    try {
      const context = await authorize(request, dependencies, "members:update");
      const orgId = assertPathScope(organizationId(request), context.organizationId);
      const memberId = membershipId(request);
      if (!orgId || !memberId) {
        response.status(400).json({ error: "invalid_organization_request" });
        return;
      }
      const input = memberStatusUpdateRequestSchema.parse(request.body);
      const member = await dependencies.organizationService.updateMemberStatus(
        orgId,
        memberId,
        input,
        {
          actorId: context.userId,
          requestId: requestIdFromHeader(request.header("x-request-id")),
        },
      );
      response.json({ member });
    } catch (error) {
      sendOrganizationError(response, error);
    }
  });

  router.post("/:organizationId/members/:membershipId/roles", async (request, response) => {
    try {
      const context = await authorize(request, dependencies, "roles:assign");
      const orgId = assertPathScope(organizationId(request), context.organizationId);
      const memberId = membershipId(request);
      if (!orgId || !memberId) {
        response.status(400).json({ error: "invalid_organization_request" });
        return;
      }
      const member = await dependencies.organizationService.assignRole(
        orgId,
        memberId,
        roleAssignmentRequestSchema.parse(request.body),
        {
          actorId: context.userId,
          requestId: requestIdFromHeader(request.header("x-request-id")),
        },
      );
      response.json({ member });
    } catch (error) {
      sendOrganizationError(response, error);
    }
  });

  return router;
}

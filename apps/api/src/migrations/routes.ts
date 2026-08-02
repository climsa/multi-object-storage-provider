import { Router, type Request, type Response } from "express";
import { z, ZodError } from "zod";

import { migrationControlRequestSchema, migrationCreateRequestSchema } from "@mosp/shared";

import { authorize } from "../auth/authorize.js";
import type { AuthService } from "../auth/service.js";
import type { OrganizationAccessRepository } from "../auth/organization-access.js";
import { requestIdFromHeader } from "../security/request-id.js";
import {
  MigrationConflict,
  MigrationInvalidTarget,
  MigrationNotFound,
  MigrationService,
  MigrationTooLarge,
} from "./service.js";

export interface MigrationRouteDependencies {
  authService: AuthService;
  organizationAccess: OrganizationAccessRepository;
  migrationService: MigrationService;
}

function migrationId(request: Request): string | null {
  const parsed = z.string().uuid().safeParse(request.params.migrationId);
  return parsed.success ? parsed.data : null;
}

function sendMigrationError(response: Response, error: unknown): void {
  if (error instanceof ZodError || error instanceof MigrationInvalidTarget) {
    response.status(400).json({ error: "invalid_migration_request" });
    return;
  }
  if (error instanceof MigrationNotFound) {
    response.status(404).json({ error: "migration_not_found" });
    return;
  }
  if (error instanceof MigrationConflict) {
    response.status(409).json({ error: "migration_conflict" });
    return;
  }
  if (error instanceof MigrationTooLarge) {
    response.status(413).json({ error: "migration_too_large" });
    return;
  }
  if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "P2002") {
    response.status(409).json({ error: "migration_conflict" });
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
  response.status(500).json({ error: "internal_error" });
}

export function createMigrationRouter(dependencies: MigrationRouteDependencies) {
  const router = Router();

  router.get("/", async (request, response) => {
    try {
      const context = await authorize(request, dependencies, "migrations:read");
      response.json({ migrations: await dependencies.migrationService.list(context.organizationId) });
    } catch (error) {
      sendMigrationError(response, error);
    }
  });

  router.post("/", async (request, response) => {
    try {
      const context = await authorize(request, dependencies, "migrations:create");
      const migration = await dependencies.migrationService.create(
        context.organizationId,
        migrationCreateRequestSchema.parse(request.body),
        { actorId: context.userId, requestId: requestIdFromHeader(request.header("x-request-id")) },
      );
      response.status(201).json({ migration });
    } catch (error) {
      sendMigrationError(response, error);
    }
  });

  router.get("/:migrationId", async (request, response) => {
    try {
      const context = await authorize(request, dependencies, "migrations:read");
      const id = migrationId(request);
      if (!id) {
        response.status(400).json({ error: "invalid_migration_request" });
        return;
      }
      response.json({ migration: await dependencies.migrationService.get(context.organizationId, id) });
    } catch (error) {
      sendMigrationError(response, error);
    }
  });

  router.post("/:migrationId/control", async (request, response) => {
    try {
      const context = await authorize(request, dependencies, "migrations:control");
      const id = migrationId(request);
      if (!id) {
        response.status(400).json({ error: "invalid_migration_request" });
        return;
      }
      const input = migrationControlRequestSchema.parse(request.body);
      response.json({
        migration: await dependencies.migrationService.control(
          context.organizationId,
          id,
          input.action,
          { actorId: context.userId, requestId: requestIdFromHeader(request.header("x-request-id")) },
        ),
      });
    } catch (error) {
      sendMigrationError(response, error);
    }
  });

  return router;
}

import { Router, type Request, type Response } from "express";
import { z, ZodError } from "zod";

import {
  platformOrganizationQuerySchema,
  platformSettingsUpdateRequestSchema,
} from "@mosp/shared";

import { authorizePlatform } from "../auth/authorize.js";
import { type AuthService } from "../auth/service.js";
import { type OrganizationAccessRepository } from "../auth/organization-access.js";
import { requestIdFromHeader } from "../security/request-id.js";
import { PlatformService, PlatformSettingVersionConflict } from "./service.js";

export interface PlatformRouteDependencies {
  authService: AuthService;
  organizationAccess: OrganizationAccessRepository;
  platformService: PlatformService;
}

function sendPlatformError(response: Response, error: unknown): void {
  if (error instanceof ZodError) {
    response.status(400).json({ error: "invalid_platform_request" });
    return;
  }
  if (error instanceof PlatformSettingVersionConflict) {
    response.status(409).json({ error: "platform_setting_version_conflict" });
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

export function createPlatformRouter(dependencies: PlatformRouteDependencies) {
  const router = Router();

  router.get("/organizations", async (request, response) => {
    try {
      await authorizePlatform(request, dependencies, "platform:read");
      response.json({
        organizations: await dependencies.platformService.listOrganizations(
          platformOrganizationQuerySchema.parse(request.query),
        ),
      });
    } catch (error) {
      sendPlatformError(response, error);
    }
  });

  router.get("/settings", async (request, response) => {
    try {
      await authorizePlatform(request, dependencies, "platform:read");
      response.json({ settings: await dependencies.platformService.getSettings() });
    } catch (error) {
      sendPlatformError(response, error);
    }
  });

  router.put("/settings", async (request: Request, response: Response) => {
    try {
      const context = await authorizePlatform(request, dependencies, "platform:manage");
      const settings = await dependencies.platformService.updateSettings(
        platformSettingsUpdateRequestSchema.parse(request.body),
        {
          actorId: context.userId,
          requestId: requestIdFromHeader(request.header("x-request-id")),
        },
      );
      response.json({ settings });
    } catch (error) {
      sendPlatformError(response, error);
    }
  });

  return router;
}

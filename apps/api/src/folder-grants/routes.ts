import { Router, type Request, type Response } from "express";
import { z, ZodError } from "zod";

import {
  folderGrantCreateRequestSchema,
  folderGrantQuerySchema,
} from "@mosp/shared";

import { authorize } from "../auth/authorize.js";
import { type AuthService } from "../auth/service.js";
import { type OrganizationAccessRepository } from "../auth/organization-access.js";
import { requestIdFromHeader } from "../security/request-id.js";
import {
  FolderGrantCredentialNotActive,
  FolderGrantExpiryInvalid,
  FolderGrantNamespaceNotFound,
  FolderGrantNotFound,
  FolderGrantPrincipalNotFound,
  FolderGrantPrefixInvalid,
  FolderGrantService,
} from "./service.js";

export interface FolderGrantRouteDependencies {
  authService: AuthService;
  folderGrantService: FolderGrantService;
  organizationAccess: OrganizationAccessRepository;
}

function grantId(request: Request): string | null {
  const parsed = z.string().uuid().safeParse(request.params.grantId);
  return parsed.success ? parsed.data : null;
}

function sendFolderGrantError(response: Response, error: unknown): void {
  if (
    error instanceof ZodError ||
    error instanceof FolderGrantExpiryInvalid ||
    error instanceof FolderGrantPrefixInvalid
  ) {
    response.status(400).json({ error: "invalid_folder_grant_request" });
    return;
  }
  if (error instanceof FolderGrantNotFound) {
    response.status(404).json({ error: "folder_grant_not_found" });
    return;
  }
  if (error instanceof FolderGrantNamespaceNotFound) {
    response.status(404).json({ error: "grant_namespace_not_found" });
    return;
  }
  if (error instanceof FolderGrantPrincipalNotFound) {
    response.status(404).json({ error: "grant_principal_not_found" });
    return;
  }
  if (error instanceof FolderGrantCredentialNotActive) {
    response.status(409).json({ error: "grant_credential_not_active" });
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
    response.status(409).json({ error: "folder_grant_conflict" });
    return;
  }
  response.status(500).json({ error: "internal_error" });
}

export function createFolderGrantRouter(dependencies: FolderGrantRouteDependencies) {
  const router = Router();

  router.get("/", async (request, response) => {
    try {
      const context = await authorize(request, dependencies, "folder_grants:read");
      response.json({
        grants: await dependencies.folderGrantService.list(
          context.organizationId,
          folderGrantQuerySchema.parse(request.query),
        ),
      });
    } catch (error) {
      sendFolderGrantError(response, error);
    }
  });

  router.post("/", async (request, response) => {
    try {
      const context = await authorize(request, dependencies, "folder_grants:manage");
      const grant = await dependencies.folderGrantService.create(
        context.organizationId,
        folderGrantCreateRequestSchema.parse(request.body),
        {
          actorId: context.userId,
          requestId: requestIdFromHeader(request.header("x-request-id")),
        },
      );
      response.status(201).json({ grant });
    } catch (error) {
      sendFolderGrantError(response, error);
    }
  });

  router.delete("/:grantId", async (request, response) => {
    try {
      const context = await authorize(request, dependencies, "folder_grants:manage");
      const id = grantId(request);
      if (!id) {
        response.status(400).json({ error: "invalid_folder_grant_request" });
        return;
      }
      await dependencies.folderGrantService.delete(context.organizationId, id, {
        actorId: context.userId,
        requestId: requestIdFromHeader(request.header("x-request-id")),
      });
      response.status(204).end();
    } catch (error) {
      sendFolderGrantError(response, error);
    }
  });

  return router;
}

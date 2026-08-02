import { Router, type Request, type Response } from "express";
import { z, ZodError } from "zod";

import {
  apiCredentialCreateRequestSchema,
  apiCredentialRotateRequestSchema,
} from "@mosp/shared";

import { authorize } from "../auth/authorize.js";
import { type AuthService } from "../auth/service.js";
import { type OrganizationAccessRepository } from "../auth/organization-access.js";
import { requestIdFromHeader } from "../security/request-id.js";
import {
  ApiCredentialExpiryInvalid,
  ApiCredentialNamespaceDisabled,
  ApiCredentialNamespaceNotFound,
  ApiCredentialNotActive,
  ApiCredentialNotFound,
  ApiCredentialService,
} from "./service.js";

export interface ApiCredentialRouteDependencies {
  apiCredentialService: ApiCredentialService;
  authService: AuthService;
  organizationAccess: OrganizationAccessRepository;
}

function credentialId(request: Request): string | null {
  const parsed = z.string().uuid().safeParse(request.params.credentialId);
  return parsed.success ? parsed.data : null;
}

function sendApiCredentialError(response: Response, error: unknown): void {
  if (error instanceof ZodError || error instanceof ApiCredentialExpiryInvalid) {
    response.status(400).json({ error: "invalid_api_credential_request" });
    return;
  }
  if (error instanceof ApiCredentialNotFound) {
    response.status(404).json({ error: "api_credential_not_found" });
    return;
  }
  if (error instanceof ApiCredentialNamespaceNotFound) {
    response.status(404).json({ error: "credential_namespace_not_found" });
    return;
  }
  if (error instanceof ApiCredentialNamespaceDisabled) {
    response.status(409).json({ error: "credential_namespace_disabled" });
    return;
  }
  if (error instanceof ApiCredentialNotActive) {
    response.status(409).json({ error: "api_credential_not_active" });
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
    response.status(409).json({ error: "api_credential_conflict" });
    return;
  }
  response.status(500).json({ error: "internal_error" });
}

export function createApiCredentialRouter(
  dependencies: ApiCredentialRouteDependencies,
) {
  const router = Router();

  router.get("/", async (request, response) => {
    try {
      const context = await authorize(request, dependencies, "api_credentials:read");
      response.json({
        credentials: await dependencies.apiCredentialService.list(context.organizationId),
      });
    } catch (error) {
      sendApiCredentialError(response, error);
    }
  });

  router.post("/", async (request, response) => {
    try {
      const context = await authorize(request, dependencies, "api_credentials:create");
      const result = await dependencies.apiCredentialService.create(
        context.organizationId,
        apiCredentialCreateRequestSchema.parse(request.body),
        {
          actorId: context.userId,
          requestId: requestIdFromHeader(request.header("x-request-id")),
        },
      );
      response.status(201).json(result);
    } catch (error) {
      sendApiCredentialError(response, error);
    }
  });

  router.post("/:credentialId/rotate", async (request, response) => {
    try {
      const context = await authorize(request, dependencies, "api_credentials:rotate");
      const id = credentialId(request);
      if (!id) {
        response.status(400).json({ error: "invalid_api_credential_request" });
        return;
      }
      const result = await dependencies.apiCredentialService.rotate(
        context.organizationId,
        id,
        apiCredentialRotateRequestSchema.parse(request.body ?? {}),
        {
          actorId: context.userId,
          requestId: requestIdFromHeader(request.header("x-request-id")),
        },
      );
      response.json(result);
    } catch (error) {
      sendApiCredentialError(response, error);
    }
  });

  router.post("/:credentialId/revoke", async (request, response) => {
    try {
      const context = await authorize(request, dependencies, "api_credentials:revoke");
      const id = credentialId(request);
      if (!id) {
        response.status(400).json({ error: "invalid_api_credential_request" });
        return;
      }
      const credential = await dependencies.apiCredentialService.revoke(
        context.organizationId,
        id,
        {
          actorId: context.userId,
          requestId: requestIdFromHeader(request.header("x-request-id")),
        },
      );
      response.json({ credential });
    } catch (error) {
      sendApiCredentialError(response, error);
    }
  });

  return router;
}

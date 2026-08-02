import { Router, type Request, type Response } from "express";
import { z, ZodError } from "zod";

import {
  namespaceCreateRequestSchema,
  namespaceUpdateRequestSchema,
  placementPolicyUpdateRequestSchema,
  placementTargetCreateRequestSchema,
} from "@mosp/shared";

import { authorize } from "../auth/authorize.js";
import { type AuthService } from "../auth/service.js";
import { type OrganizationAccessRepository } from "../auth/organization-access.js";
import { requestIdFromHeader } from "../security/request-id.js";
import {
  NamespaceMustBeDisabled,
  NamespaceNotFound,
  NamespaceService,
  PlacementBucketNotFound,
} from "./service.js";

export interface NamespaceRouteDependencies {
  authService: AuthService;
  namespaceService: NamespaceService;
  organizationAccess: OrganizationAccessRepository;
}

function namespaceId(request: Request): string | null {
  const parsed = z.string().uuid().safeParse(request.params.namespaceId);
  return parsed.success ? parsed.data : null;
}

function sendNamespaceError(response: Response, error: unknown): void {
  if (error instanceof ZodError) {
    response.status(400).json({ error: "invalid_namespace_request" });
    return;
  }
  if (error instanceof NamespaceNotFound) {
    response.status(404).json({ error: "namespace_not_found" });
    return;
  }
  if (error instanceof NamespaceMustBeDisabled) {
    response.status(409).json({ error: "namespace_must_be_disabled" });
    return;
  }
  if (error instanceof PlacementBucketNotFound) {
    response.status(404).json({ error: "placement_bucket_not_found" });
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
    response.status(409).json({ error: "namespace_conflict" });
    return;
  }
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2003"
  ) {
    response.status(409).json({ error: "namespace_relation_conflict" });
    return;
  }
  response.status(500).json({ error: "internal_error" });
}

export function createNamespaceRouter(dependencies: NamespaceRouteDependencies) {
  const router = Router();

  router.get("/", async (request, response) => {
    try {
      const context = await authorize(request, dependencies, "namespaces:read");
      response.json({ namespaces: await dependencies.namespaceService.list(context.organizationId) });
    } catch (error) {
      sendNamespaceError(response, error);
    }
  });

  router.post("/", async (request, response) => {
    try {
      const context = await authorize(request, dependencies, "namespaces:create");
      const namespace = await dependencies.namespaceService.create(
        context.organizationId,
        namespaceCreateRequestSchema.parse(request.body),
        {
          actorId: context.userId,
          requestId: requestIdFromHeader(request.header("x-request-id")),
        },
      );
      response.status(201).json({ namespace });
    } catch (error) {
      sendNamespaceError(response, error);
    }
  });

  router.get("/:namespaceId", async (request, response) => {
    try {
      const context = await authorize(request, dependencies, "namespaces:read");
      const id = namespaceId(request);
      if (!id) {
        response.status(400).json({ error: "invalid_namespace_request" });
        return;
      }
      response.json({
        namespace: await dependencies.namespaceService.get(context.organizationId, id),
      });
    } catch (error) {
      sendNamespaceError(response, error);
    }
  });

  router.patch("/:namespaceId", async (request, response) => {
    try {
      const context = await authorize(request, dependencies, "namespaces:update");
      const id = namespaceId(request);
      if (!id) {
        response.status(400).json({ error: "invalid_namespace_request" });
        return;
      }
      const namespace = await dependencies.namespaceService.update(
        context.organizationId,
        id,
        namespaceUpdateRequestSchema.parse(request.body),
        {
          actorId: context.userId,
          requestId: requestIdFromHeader(request.header("x-request-id")),
        },
      );
      response.json({ namespace });
    } catch (error) {
      sendNamespaceError(response, error);
    }
  });

  router.delete("/:namespaceId", async (request, response) => {
    try {
      const context = await authorize(request, dependencies, "namespaces:delete");
      const id = namespaceId(request);
      if (!id) {
        response.status(400).json({ error: "invalid_namespace_request" });
        return;
      }
      await dependencies.namespaceService.delete(context.organizationId, id, {
        actorId: context.userId,
        requestId: requestIdFromHeader(request.header("x-request-id")),
      });
      response.status(204).end();
    } catch (error) {
      sendNamespaceError(response, error);
    }
  });

  router.post("/:namespaceId/targets", async (request, response) => {
    try {
      const context = await authorize(request, dependencies, "placement_policies:manage");
      const id = namespaceId(request);
      if (!id) {
        response.status(400).json({ error: "invalid_namespace_request" });
        return;
      }
      const namespace = await dependencies.namespaceService.addTarget(
        context.organizationId,
        id,
        placementTargetCreateRequestSchema.parse(request.body),
        {
          actorId: context.userId,
          requestId: requestIdFromHeader(request.header("x-request-id")),
        },
      );
      response.status(201).json({ namespace });
    } catch (error) {
      sendNamespaceError(response, error);
    }
  });

  router.put("/:namespaceId/placement-policy", async (request, response) => {
    try {
      const context = await authorize(request, dependencies, "placement_policies:manage");
      const id = namespaceId(request);
      if (!id) {
        response.status(400).json({ error: "invalid_namespace_request" });
        return;
      }
      const namespace = await dependencies.namespaceService.updatePolicy(
        context.organizationId,
        id,
        placementPolicyUpdateRequestSchema.parse(request.body),
        {
          actorId: context.userId,
          requestId: requestIdFromHeader(request.header("x-request-id")),
        },
      );
      response.json({ namespace });
    } catch (error) {
      sendNamespaceError(response, error);
    }
  });

  return router;
}

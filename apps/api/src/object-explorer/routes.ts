import { Router, type Request, type Response } from "express";
import { z, ZodError } from "zod";

import { objectKeySchema, objectListPrefixSchema, objectListQuerySchema } from "@mosp/shared";

import { authorize } from "../auth/authorize.js";
import type { AuthService } from "../auth/service.js";
import type { OrganizationAccessRepository } from "../auth/organization-access.js";
import { requestIdFromHeader } from "../security/request-id.js";
import { RateLimiterUnavailableError, rateLimitKey, type RateLimiter } from "../security/rate-limit.js";
import {
  ObjectExplorerDeleteUnavailable,
  ObjectExplorerDownloadUnavailable,
  ObjectExplorerNamespaceNotFound,
  ObjectExplorerObjectNotFound,
  ObjectExplorerService,
  ObjectExplorerUploadConflict,
  ObjectExplorerUploadQuotaExceeded,
  ObjectExplorerUploadTargetUnavailable,
  ObjectExplorerUploadTooLarge,
  ObjectExplorerUploadUnavailable,
} from "./service.js";

export interface ObjectExplorerRouteDependencies {
  authService: AuthService;
  organizationAccess: OrganizationAccessRepository;
  objectExplorerService: ObjectExplorerService;
  rateLimiter?: RateLimiter;
}

const namespaceSlugSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/);

function namespaceSlug(request: Request): string | null {
  const parsed = namespaceSlugSchema.safeParse(request.params.namespace);
  return parsed.success ? parsed.data : null;
}

function wildcardKey(request: Request): string | null {
  const value = request.params.key;
  const key = Array.isArray(value) ? value.join("/") : value;
  const parsed = objectKeySchema.safeParse(key);
  return parsed.success ? parsed.data : null;
}

function contentLength(request: Request): bigint | null {
  const value = request.header("x-mosp-content-length") ?? request.header("content-length");
  if (!value || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function safeContentType(request: Request): string | null {
  const value = request.header("x-mosp-object-content-type") ?? request.header("content-type");
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null;
  if (!request.header("x-mosp-object-content-type") && value === "application/octet-stream") return null;
  return value.slice(0, 255);
}

const folderPrefixSchema = z.string().min(1).max(2047).regex(/^[^\u0000-\u001f\u007f]*$/).superRefine((value, context) => {
  if (value.includes("\\") || value.includes("//") || value.startsWith("/") || value.split("/").some((segment) => segment === "." || segment === "..")) {
    context.addIssue({ code: "custom", message: "Invalid folder prefix" });
  }
});

function sendObjectExplorerError(response: Response, error: unknown): void {
  if (error instanceof ZodError) {
    response.status(400).json({ error: "invalid_object_request" });
    return;
  }
  if (error instanceof ObjectExplorerNamespaceNotFound || error instanceof ObjectExplorerObjectNotFound) {
    response.status(404).json({ error: "not_found" });
    return;
  }
  if (error instanceof ObjectExplorerDownloadUnavailable || error instanceof ObjectExplorerDeleteUnavailable) {
    response.status(502).json({ error: "storage_provider_error" });
    return;
  }
  if (error instanceof ObjectExplorerUploadTooLarge || error instanceof ObjectExplorerUploadQuotaExceeded) {
    response.status(413).json({ error: "upload_too_large" });
    return;
  }
  if (error instanceof ObjectExplorerUploadConflict) {
    response.status(409).json({ error: "object_exists" });
    return;
  }
  if (error instanceof ObjectExplorerUploadTargetUnavailable) {
    response.status(503).json({ error: "storage_unavailable" });
    return;
  }
  if (error instanceof ObjectExplorerUploadUnavailable) {
    response.status(502).json({ error: "storage_provider_error" });
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

async function rejectWhenLimited(
  response: Response,
  rateLimiter: RateLimiter | undefined,
  request: Request,
): Promise<boolean> {
  if (!rateLimiter) return false;
  try {
    const decision = await rateLimiter.consume(rateLimitKey(request.ip, "object-explorer"));
    if (decision.allowed) return false;
    response.setHeader("Retry-After", decision.retryAfterSeconds);
    response.status(429).json({ error: "rate_limited" });
    return true;
  } catch (error) {
    if (error instanceof RateLimiterUnavailableError) {
      response.status(503).json({ error: "dependency_unavailable" });
      return true;
    }
    throw error;
  }
}

export function createObjectExplorerRouter(dependencies: ObjectExplorerRouteDependencies) {
  const router = Router();

  router.get("/namespaces", async (request, response) => {
    try {
      if (await rejectWhenLimited(response, dependencies.rateLimiter, request)) return;
      const context = await authorize(request, dependencies, "objects:list");
      response.json({ namespaces: await dependencies.objectExplorerService.listNamespaces(context.organizationId) });
    } catch (error) {
      sendObjectExplorerError(response, error);
    }
  });

  router.get("/:namespace/objects", async (request, response) => {
    try {
      if (await rejectWhenLimited(response, dependencies.rateLimiter, request)) return;
      const context = await authorize(request, dependencies, "objects:list");
      const namespace = namespaceSlug(request);
      if (!namespace) {
        response.status(400).json({ error: "invalid_object_request" });
        return;
      }
      response.json({
        objects: await dependencies.objectExplorerService.list(
          context.organizationId,
          namespace,
          objectListQuerySchema.parse(request.query),
        ),
      });
    } catch (error) {
      sendObjectExplorerError(response, error);
    }
  });

  router.get("/:namespace/folders", async (request, response) => {
    try {
      if (await rejectWhenLimited(response, dependencies.rateLimiter, request)) return;
      const context = await authorize(request, dependencies, "objects:list");
      const namespace = namespaceSlug(request);
      if (!namespace) {
        response.status(400).json({ error: "invalid_object_request" });
        return;
      }
      const query = z.object({ prefix: objectListPrefixSchema.default("") }).strict().parse(request.query);
      response.json({ folders: await dependencies.objectExplorerService.listFolders(context.organizationId, namespace, query.prefix) });
    } catch (error) {
      sendObjectExplorerError(response, error);
    }
  });

  router.post("/:namespace/folders", async (request, response) => {
    try {
      if (await rejectWhenLimited(response, dependencies.rateLimiter, request)) return;
      const context = await authorize(request, dependencies, "objects:write");
      const namespace = namespaceSlug(request);
      const body = z.object({ prefix: folderPrefixSchema }).strict().parse(request.body);
      if (!namespace) {
        response.status(400).json({ error: "invalid_object_request" });
        return;
      }
      response.status(201).json({
        folder: await dependencies.objectExplorerService.createFolder(
          context.organizationId,
          namespace,
          body.prefix,
          context.userId,
          requestIdFromHeader(request.header("x-request-id")),
        ),
      });
    } catch (error) {
      sendObjectExplorerError(response, error);
    }
  });

  router.get("/:namespace/download/*key", async (request, response) => {
    try {
      if (await rejectWhenLimited(response, dependencies.rateLimiter, request)) return;
      const context = await authorize(request, dependencies, "objects:read");
      const namespace = namespaceSlug(request);
      const key = wildcardKey(request);
      if (!namespace || !key) {
        response.status(400).json({ error: "invalid_object_request" });
        return;
      }
      response.json({
        transfer: await dependencies.objectExplorerService.presignDownload(
          context.organizationId,
          namespace,
          key,
        ),
      });
    } catch (error) {
      sendObjectExplorerError(response, error);
    }
  });

  router.put("/:namespace/objects/*key", async (request, response) => {
    try {
      if (await rejectWhenLimited(response, dependencies.rateLimiter, request)) return;
      const context = await authorize(request, dependencies, "objects:write");
      const namespace = namespaceSlug(request);
      const key = wildcardKey(request);
      const sizeBytes = contentLength(request);
      if (!namespace || !key || sizeBytes === null) {
        response.status(sizeBytes === null ? 411 : 400).json({ error: sizeBytes === null ? "content_length_required" : "invalid_object_request" });
        return;
      }
      const object = await dependencies.objectExplorerService.upload(
        context.organizationId,
        namespace,
        key,
        request,
        sizeBytes,
        safeContentType(request),
        context.userId,
        requestIdFromHeader(request.header("x-request-id")),
      );
      response.status(201).json({ object });
    } catch (error) {
      sendObjectExplorerError(response, error);
    }
  });

  router.delete("/:namespace/objects/*key", async (request, response) => {
    try {
      if (await rejectWhenLimited(response, dependencies.rateLimiter, request)) return;
      const context = await authorize(request, dependencies, "objects:delete");
      const namespace = namespaceSlug(request);
      const key = wildcardKey(request);
      if (!namespace || !key) {
        response.status(400).json({ error: "invalid_object_request" });
        return;
      }
      await dependencies.objectExplorerService.delete(
        context.organizationId,
        namespace,
        key,
        context.userId,
        requestIdFromHeader(request.header("x-request-id")),
      );
      response.status(204).end();
    } catch (error) {
      sendObjectExplorerError(response, error);
    }
  });

  return router;
}

import { Router, type Request, type Response } from "express";
import { z, ZodError } from "zod";

import {
  providerConnectionCreateRequestSchema,
  providerConnectionTestRequestSchema,
  providerConnectionUpdateRequestSchema,
} from "@mosp/shared";

import { authorize } from "../auth/authorize.js";
import { type AuthService } from "../auth/service.js";
import {
  type OrganizationAccessRepository,
} from "../auth/organization-access.js";
import {
  ProviderConnectionNotFound,
  ProviderConnectionInUse,
  ProviderConnectionService,
  ProviderConnectionValidationError,
} from "./service.js";
import type { BucketConnectionService } from "../buckets/service.js";
import { RateLimiterUnavailableError, rateLimitKey, type RateLimiter } from "../security/rate-limit.js";
import { requestIdFromHeader } from "../security/request-id.js";

export interface ProviderRouteDependencies {
  authService: AuthService;
  organizationAccess: OrganizationAccessRepository;
  providerService: ProviderConnectionService;
  bucketService: BucketConnectionService;
  rateLimiter?: RateLimiter;
}

async function rejectWhenLimited(response: Response, rateLimiter: RateLimiter | undefined, key: string): Promise<boolean> {
  if (!rateLimiter) return false;
  let decision;
  try {
    decision = await rateLimiter.consume(key);
  } catch (error) {
    if (error instanceof RateLimiterUnavailableError) {
      response.status(503).json({ error: "dependency_unavailable" });
      return true;
    }
    throw error;
  }
  if (decision.allowed) return false;
  response.setHeader("Retry-After", decision.retryAfterSeconds);
  response.status(429).json({ error: "rate_limited" });
  return true;
}

export { authorize } from "../auth/authorize.js";

export function requestId(request: Request): string {
  return requestIdFromHeader(request.header("x-request-id"));
}

function providerId(request: Request): string | null {
  const parsed = z.string().uuid().safeParse(request.params.providerId);
  return parsed.success ? parsed.data : null;
}

export function sendError(response: Response, error: unknown) {
  if (error instanceof ZodError || error instanceof ProviderConnectionValidationError) {
    response.status(400).json({ error: "invalid_provider_request" });
    return;
  }
  if (error instanceof ProviderConnectionNotFound) {
    response.status(404).json({ error: "provider_not_found" });
    return;
  }
  if (error instanceof ProviderConnectionInUse) {
    response.status(409).json({ error: "provider_in_use" });
    return;
  }
  if (
    error instanceof Error &&
    ["BUCKET_LIST_FAILED", "BUCKET_ACCESS_FAILED"].includes(error.message)
  ) {
    response.status(502).json({ error: "bucket_access_failed" });
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
  if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "P2002") {
    response.status(409).json({ error: "provider_already_exists" });
    return;
  }
  if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "P2003") {
    response.status(409).json({ error: "provider_in_use" });
    return;
  }
  response.status(500).json({ error: "internal_error" });
}

export function createProviderRouter(dependencies: ProviderRouteDependencies) {
  const router = Router();

  router.get("/", async (request, response) => {
    try {
      const context = await authorize(request, dependencies, "providers:read");
      if (
        await rejectWhenLimited(
          response,
          dependencies.rateLimiter,
          rateLimitKey(request.ip, `provider-list:${context.organizationId}`),
        )
      ) {
        return;
      }
      response.json({ providers: await dependencies.providerService.list(context.organizationId) });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post("/", async (request, response) => {
    try {
      const context = await authorize(request, dependencies, "providers:create");
      const input = providerConnectionCreateRequestSchema.parse(request.body);
      const provider = await dependencies.providerService.create(
        context.organizationId,
        input,
        { actorId: context.userId, requestId: requestId(request) },
      );
      response.status(201).json({ provider });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.patch("/:providerId", async (request, response) => {
    try {
      const context = await authorize(request, dependencies, "providers:update");
      const id = providerId(request);
      if (!id) {
        response.status(400).json({ error: "invalid_provider_request" });
        return;
      }
      const provider = await dependencies.providerService.update(
        context.organizationId,
        id,
        providerConnectionUpdateRequestSchema.parse(request.body),
        { actorId: context.userId, requestId: requestId(request) },
      );
      response.json({ provider });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.delete("/:providerId", async (request, response) => {
    try {
      const context = await authorize(request, dependencies, "providers:delete");
      const id = providerId(request);
      if (!id) {
        response.status(400).json({ error: "invalid_provider_request" });
        return;
      }
      await dependencies.providerService.delete(
        context.organizationId,
        id,
        { actorId: context.userId, requestId: requestId(request) },
      );
      response.status(204).end();
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get("/:providerId", async (request, response) => {
    try {
      const context = await authorize(request, dependencies, "providers:read");
      const id = providerId(request);
      if (!id) {
        response.status(400).json({ error: "invalid_provider_request" });
        return;
      }
      response.json({
        provider: await dependencies.providerService.get(context.organizationId, id),
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post("/:providerId/test", async (request, response) => {
    try {
      const context = await authorize(request, dependencies, "providers:test");
      const id = providerId(request);
      if (!id) {
        response.status(400).json({ error: "invalid_provider_request" });
        return;
      }
      if (
        await rejectWhenLimited(
          response,
          dependencies.rateLimiter,
          rateLimitKey(request.ip, `provider-test:${context.organizationId}:${id}`),
        )
      ) {
        return;
      }
      const input = providerConnectionTestRequestSchema.parse(request.body ?? {});
      const result = await dependencies.providerService.test(
        context.organizationId,
        id,
        input,
        { actorId: context.userId, requestId: requestId(request) },
      );
      response.status(result.ok ? 200 : 502).json(result);
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get("/:providerId/buckets", async (request, response) => {
    try {
      const context = await authorize(request, dependencies, "buckets:read");
      const id = providerId(request);
      if (!id) {
        response.status(400).json({ error: "invalid_provider_request" });
        return;
      }
      if (
        await rejectWhenLimited(
          response,
          dependencies.rateLimiter,
          rateLimitKey(request.ip, `bucket-discovery:${context.organizationId}:${id}`),
        )
      ) {
        return;
      }
      const bucketNames = await dependencies.bucketService.listAccessibleBuckets(
        context.organizationId,
        id,
      );
      response.json({ bucketNames });
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}

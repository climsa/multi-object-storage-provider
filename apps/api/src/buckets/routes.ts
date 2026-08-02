import { Router, type Request, type Response } from "express";
import { z, ZodError } from "zod";

import {
  bucketConnectionStatusUpdateRequestSchema,
  bucketImportRequestSchema,
} from "@mosp/shared";

import { type AuthService } from "../auth/service.js";
import { type OrganizationAccessRepository } from "../auth/organization-access.js";
import { authorize } from "../auth/authorize.js";
import { requestIdFromHeader } from "../security/request-id.js";
import {
  ProviderConnectionNotFound,
  ProviderConnectionService,
} from "../providers/service.js";
import {
  BucketConnectionAccessError,
  BucketConnectionMustBeDisabled,
  BucketConnectionNotFound,
  BucketConnectionService,
} from "./service.js";
import { RateLimiterUnavailableError, rateLimitKey, type RateLimiter } from "../security/rate-limit.js";

export interface BucketRouteDependencies {
  authService: AuthService;
  bucketService: BucketConnectionService;
  organizationAccess: OrganizationAccessRepository;
  providerService: ProviderConnectionService;
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

function bucketConnectionId(request: Request): string | null {
  const parsed = z.string().uuid().safeParse(request.params.bucketId);
  return parsed.success ? parsed.data : null;
}

function sendBucketError(response: Response, error: unknown) {
  if (error instanceof ZodError) {
    response.status(400).json({ error: "invalid_bucket_request" });
    return;
  }
  if (error instanceof ProviderConnectionNotFound) {
    response.status(404).json({ error: "provider_not_found" });
    return;
  }
  if (error instanceof BucketConnectionAccessError) {
    response.status(502).json({ error: "bucket_access_failed" });
    return;
  }
  if (error instanceof BucketConnectionNotFound) {
    response.status(404).json({ error: "bucket_not_found" });
    return;
  }
  if (error instanceof BucketConnectionMustBeDisabled) {
    response.status(409).json({ error: "bucket_must_be_disabled" });
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
    response.status(409).json({ error: "bucket_already_connected" });
    return;
  }
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2003"
  ) {
    response.status(409).json({ error: "bucket_in_use" });
    return;
  }
  response.status(500).json({ error: "internal_error" });
}

export function createBucketRouter(dependencies: BucketRouteDependencies) {
  const router = Router();

  router.get("/", async (request: Request, response: Response) => {
    try {
      const context = await authorize(request, dependencies, "buckets:read");
      if (
        await rejectWhenLimited(
          response,
          dependencies.rateLimiter,
          rateLimitKey(request.ip, `bucket-list:${context.organizationId}`),
        )
      ) {
        return;
      }
      response.json({
        buckets: await dependencies.bucketService.listConnections(context.organizationId),
      });
    } catch (error) {
      sendBucketError(response, error);
    }
  });

  router.get("/:bucketId", async (request: Request, response: Response) => {
    try {
      const context = await authorize(request, dependencies, "buckets:read");
      const id = bucketConnectionId(request);
      if (!id) {
        response.status(400).json({ error: "invalid_bucket_request" });
        return;
      }
      response.json({
        bucket: await dependencies.bucketService.get(context.organizationId, id),
      });
    } catch (error) {
      sendBucketError(response, error);
    }
  });

  router.post("/import", async (request: Request, response: Response) => {
    try {
      const context = await authorize(request, dependencies, "buckets:import");
      if (
        await rejectWhenLimited(
          response,
          dependencies.rateLimiter,
          rateLimitKey(request.ip, `bucket-import:${context.organizationId}`),
        )
      ) {
        return;
      }
      const input = bucketImportRequestSchema.parse(request.body);
      const bucket = await dependencies.bucketService.import(
        context.organizationId,
        input,
        {
          actorId: context.userId,
          requestId: requestIdFromHeader(request.header("x-request-id")),
        },
      );
      response.status(201).json({ bucket });
    } catch (error) {
      sendBucketError(response, error);
    }
  });

  router.patch("/:bucketId", async (request: Request, response: Response) => {
    try {
      const context = await authorize(request, dependencies, "buckets:manage");
      const id = bucketConnectionId(request);
      if (!id) {
        response.status(400).json({ error: "invalid_bucket_request" });
        return;
      }
      const bucket = await dependencies.bucketService.updateStatus(
        context.organizationId,
        id,
        bucketConnectionStatusUpdateRequestSchema.parse(request.body),
        {
          actorId: context.userId,
          requestId: requestIdFromHeader(request.header("x-request-id")),
        },
      );
      response.json({ bucket });
    } catch (error) {
      sendBucketError(response, error);
    }
  });

  router.delete("/:bucketId", async (request: Request, response: Response) => {
    try {
      const context = await authorize(request, dependencies, "buckets:manage");
      const id = bucketConnectionId(request);
      if (!id) {
        response.status(400).json({ error: "invalid_bucket_request" });
        return;
      }
      await dependencies.bucketService.delete(
        context.organizationId,
        id,
        {
          actorId: context.userId,
          requestId: requestIdFromHeader(request.header("x-request-id")),
        },
      );
      response.status(204).end();
    } catch (error) {
      sendBucketError(response, error);
    }
  });

  return router;
}

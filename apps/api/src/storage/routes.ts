import { Router, type Request, type Response } from "express";
import { Transform, pipeline } from "node:stream";
import { promisify } from "node:util";
import { z, ZodError } from "zod";

import { parseBearerToken } from "../auth/cookies.js";
import { RateLimiterUnavailableError, rateLimitKey, type RateLimiter } from "../security/rate-limit.js";
import type { InFlightLimiter } from "../security/in-flight-limiter.js";
import type { UsageService } from "../usage/service.js";
import type { MetricsRegistry } from "../observability/metrics.js";
import {
  ApiCredentialAuthenticationError,
  ApiCredentialAuthenticator,
} from "../auth/api-credential.js";
import {
  objectKeySchema,
  objectListQuerySchema,
  uploadCompleteRequestSchema,
  uploadInitiateRequestSchema,
} from "@mosp/shared";
import {
  ObjectIndexService,
  StorageDeleteUnavailable,
  StorageDownloadUnavailable,
  StorageNamespaceNotFound,
  StorageObjectNotFound,
} from "./object-service.js";
import {
  UploadIdempotencyConflict,
  UploadObjectAlreadyExists,
  UploadProviderError,
  UploadProxyLengthRequired,
  UploadProxyObjectTooLarge,
  UploadProxySizeMismatch,
  UploadConcurrencyExceeded,
  UploadQuotaExceeded,
  UploadService,
  UploadSessionConflict,
  UploadSessionNotFound,
  UploadTargetUnavailable,
  UploadVerificationFailed,
} from "./upload-service.js";
import {
  DEFAULT_PROXY_TRANSFER_CONFIG,
  type ProxyTransferConfig,
} from "./transfer.js";

export interface StorageRouteDependencies {
  apiCredentialAuthenticator: ApiCredentialAuthenticator;
  objectIndexService: ObjectIndexService;
  uploadService?: UploadService;
  rateLimiter?: RateLimiter;
  inFlightLimiter?: InFlightLimiter;
  usageService?: UsageService;
  metrics?: MetricsRegistry;
  proxyTransferConfig?: ProxyTransferConfig;
}

const namespaceSlugSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/);

function namespaceSlug(request: Request): string | null {
  const parsed = namespaceSlugSchema.safeParse(request.params.namespace);
  return parsed.success ? parsed.data : null;
}

function wildcardKey(request: Request): string | null {
  const value = request.params.key;
  if (Array.isArray(value)) return value.join("/");
  return typeof value === "string" ? value : null;
}

function safeHeaderValue(value: string | null, fallback: string): string {
  return value && !/[\u0000-\u001f\u007f]/.test(value) ? value : fallback;
}

function contentLength(request: Request): bigint | null {
  const value = request.header("content-length");
  if (!value || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function metricBytes(value: bigint): number {
  const maxSafeInteger = BigInt(Number.MAX_SAFE_INTEGER);
  return Number(value > maxSafeInteger ? maxSafeInteger : value);
}

async function rejectWhenLimited(
  response: Response,
  rateLimiter: RateLimiter | undefined,
  request: Request,
  bucket: string,
): Promise<boolean> {
  if (!rateLimiter) return false;
  let decision;
  try {
    decision = await rateLimiter.consume(rateLimitKey(request.ip, bucket));
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

function sendStorageError(
  response: Response,
  error: unknown,
  proxyTransferConfig: ProxyTransferConfig = DEFAULT_PROXY_TRANSFER_CONFIG,
): void {
  if (error instanceof ZodError) {
    response.status(400).json({ error: "invalid_storage_request" });
    return;
  }
  if (error instanceof ApiCredentialAuthenticationError) {
    response.status(401).json({ error: "unauthenticated" });
    return;
  }
  if (error instanceof StorageNamespaceNotFound || error instanceof StorageObjectNotFound) {
    response.status(404).json({ error: "not_found" });
    return;
  }
  if (error instanceof UploadSessionNotFound) {
    response.status(404).json({ error: "not_found" });
    return;
  }
  if (error instanceof UploadQuotaExceeded) {
    response.status(413).json({ error: "quota_exceeded" });
    return;
  }
  if (error instanceof UploadProxyLengthRequired) {
    response.status(411).json({ error: "content_length_required" });
    return;
  }
  if (error instanceof UploadProxyObjectTooLarge) {
    response.status(413).json({ error: "proxy_object_too_large", maxBytes: proxyTransferConfig.maxObjectBytes.toString() });
    return;
  }
  if (error instanceof UploadProxySizeMismatch) {
    response.status(400).json({ error: "upload_size_mismatch" });
    return;
  }
  if (error instanceof UploadConcurrencyExceeded) {
    response.setHeader("Retry-After", "60");
    response.status(429).json({ error: "upload_rate_limited" });
    return;
  }
  if (error instanceof UploadTargetUnavailable) {
    response.status(503).json({ error: "storage_unavailable" });
    return;
  }
  if (error instanceof UploadIdempotencyConflict || error instanceof UploadSessionConflict) {
    response.status(409).json({ error: "upload_conflict" });
    return;
  }
  if (error instanceof UploadObjectAlreadyExists) {
    response.status(409).json({ error: "object_exists" });
    return;
  }
  if (error instanceof UploadVerificationFailed) {
    response.status(422).json({ error: "upload_verification_failed" });
    return;
  }
  if (error instanceof UploadProviderError) {
    response.status(502).json({ error: "storage_provider_error" });
    return;
  }
  if (error instanceof StorageDownloadUnavailable) {
    response.status(502).json({ error: "storage_provider_error" });
    return;
  }
  if (error instanceof StorageDeleteUnavailable) {
    response.status(502).json({ error: "storage_provider_error" });
    return;
  }
  response.status(500).json({ error: "internal_error" });
}

async function authenticate(
  request: Request,
  dependencies: StorageRouteDependencies,
) {
  const identity = await dependencies.apiCredentialAuthenticator.authenticate(parseBearerToken(request));
  await dependencies.usageService?.recordRequest(identity.organizationId, identity.namespaceId);
  return identity;
}

export function createStorageRouter(dependencies: StorageRouteDependencies) {
  const router = Router();
  const pipelineAsync = promisify(pipeline);
  const proxyTransferConfig = dependencies.proxyTransferConfig ?? DEFAULT_PROXY_TRANSFER_CONFIG;

  if (dependencies.inFlightLimiter) {
    router.use((_request, response, next) => {
      const release = dependencies.inFlightLimiter?.tryAcquire();
      if (!release) {
        dependencies.metrics?.incrementCounter("mosp_storage_overloaded_total");
        response.setHeader("Retry-After", "1");
        response.status(503).json({ error: "storage_overloaded" });
        return;
      }
      dependencies.metrics?.setGauge(
        "mosp_storage_in_flight",
        dependencies.inFlightLimiter?.activeCount ?? 0,
      );
      const releaseAndObserve = () => {
        release();
        dependencies.metrics?.setGauge(
          "mosp_storage_in_flight",
          dependencies.inFlightLimiter?.activeCount ?? 0,
        );
      };
      response.once("finish", releaseAndObserve);
      response.once("close", releaseAndObserve);
      next();
    });
  }

  router.get("/:namespace/objects", async (request, response) => {
    try {
      const namespace = namespaceSlug(request);
      if (!namespace) {
        response.status(400).json({ error: "invalid_storage_request" });
        return;
      }
      if (await rejectWhenLimited(response, dependencies.rateLimiter, request, "storage-objects")) return;
      const identity = await authenticate(request, dependencies);
      const objects = await dependencies.objectIndexService.list(
        identity,
        namespace,
        objectListQuerySchema.parse(request.query),
      );
      response.json({ objects });
    } catch (error) {
      sendStorageError(response, error);
    }
  });

  router.head("/:namespace/objects/*key", async (request, response) => {
    try {
      const namespace = namespaceSlug(request);
      const key = wildcardKey(request);
      if (!namespace || !key) {
        response.status(400).end();
        return;
      }
      if (await rejectWhenLimited(response, dependencies.rateLimiter, request, "storage-objects")) return;
      const identity = await authenticate(request, dependencies);
      const object = await dependencies.objectIndexService.head(
        identity,
        namespace,
        objectKeySchema.parse(key),
      );
      response.setHeader("Content-Length", object.sizeBytes);
      response.setHeader("Content-Type", safeHeaderValue(object.contentType, "application/octet-stream"));
      response.setHeader("Last-Modified", object.modifiedAt);
      const etag = object.etag && !/[\u0000-\u001f\u007f]/.test(object.etag)
        ? object.etag
        : null;
      if (etag) response.setHeader("ETag", etag);
      response.setHeader("Content-Disposition", "attachment");
      response.status(200).end();
    } catch (error) {
      sendStorageError(response, error);
    }
  });

  router.get("/:namespace/objects/*key", async (request, response) => {
    try {
      const namespace = namespaceSlug(request);
      const key = wildcardKey(request);
      if (!namespace || !key) {
        response.status(400).end();
        return;
      }
      if (await rejectWhenLimited(response, dependencies.rateLimiter, request, "storage-objects")) return;
      const identity = await authenticate(request, dependencies);
      const parsedKey = objectKeySchema.parse(key);
      const transferMode = typeof dependencies.objectIndexService.getTransferMode === "function"
        ? await dependencies.objectIndexService.getTransferMode(identity, namespace)
        : "DIRECT";
      if (transferMode !== "PROXIED") {
        const transfer = await dependencies.objectIndexService.presignDownload(
          identity,
          namespace,
          parsedKey,
        );
        response.setHeader("Cache-Control", "private, no-store");
        response.redirect(302, transfer.url);
        return;
      }

      const startedAt = process.hrtime.bigint();
      let bytes = 0n;
      let completed = false;
      dependencies.metrics?.incrementCounter("mosp_proxy_download_attempts_total");
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.once("aborted", abort);
      response.once("close", abort);
      try {
        const transfer = await dependencies.objectIndexService.proxyDownload(
          identity,
          namespace,
          parsedKey,
          controller.signal,
        );
        const counter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            bytes += BigInt(chunk.length);
            callback(null, chunk);
          },
          flush(callback) {
            if (bytes !== transfer.metadata.sizeBytes) {
              callback(new Error("PROVIDER_STREAM_SIZE_MISMATCH"));
              return;
            }
            callback();
          },
        });
        response.setHeader("Cache-Control", "private, no-store");
        response.setHeader("Content-Length", transfer.metadata.sizeBytes.toString());
        response.setHeader(
          "Content-Type",
          safeHeaderValue(transfer.metadata.contentType ?? null, "application/octet-stream"),
        );
        response.setHeader("Content-Disposition", "attachment");
        if (transfer.metadata.lastModified) {
          response.setHeader("Last-Modified", transfer.metadata.lastModified.toUTCString());
        }
        const etag = transfer.metadata.etag && !/[\u0000-\u001f\u007f]/.test(transfer.metadata.etag)
          ? transfer.metadata.etag
          : null;
        if (etag) response.setHeader("ETag", etag);
        response.status(200);
        let streamError: unknown;
        try {
          await pipelineAsync(transfer.body, counter, response);
        } catch (error) {
          streamError = error;
        }
        try {
          await dependencies.usageService?.recordEgress(identity.organizationId, identity.namespaceId, bytes);
        } catch (error) {
          streamError ??= error;
        }
        if (streamError) throw streamError;
        completed = true;
      } finally {
        dependencies.metrics?.incrementCounter(
          completed ? "mosp_proxy_downloads_total" : "mosp_proxy_download_failures_total",
        );
        dependencies.metrics?.incrementCounter("mosp_proxy_download_bytes_total", metricBytes(bytes));
        dependencies.metrics?.observeDuration(
          "mosp_proxy_download_duration_seconds",
          Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
        );
        request.off("aborted", abort);
        response.off("close", abort);
      }
    } catch (error) {
      if (!response.headersSent) sendStorageError(response, error);
      else response.destroy();
    }
  });

  router.delete("/:namespace/objects/*key", async (request, response) => {
    try {
      const namespace = namespaceSlug(request);
      const key = wildcardKey(request);
      if (!namespace || !key) {
        response.status(400).end();
        return;
      }
      if (await rejectWhenLimited(response, dependencies.rateLimiter, request, "storage-objects")) return;
      const identity = await authenticate(request, dependencies);
      await dependencies.objectIndexService.delete(
        identity,
        namespace,
        objectKeySchema.parse(key),
        safeHeaderValue(request.header("x-request-id") ?? null, "unknown").slice(0, 128),
      );
      response.status(204).end();
    } catch (error) {
      sendStorageError(response, error);
    }
  });

  if (dependencies.uploadService) {
    const uploadService = dependencies.uploadService;
    router.post("/:namespace/uploads", async (request, response) => {
      try {
        const namespace = namespaceSlug(request);
        if (!namespace) {
          response.status(400).json({ error: "invalid_storage_request" });
          return;
        }
        if (await rejectWhenLimited(response, dependencies.rateLimiter, request, "storage-uploads")) return;
        const identity = await authenticate(request, dependencies);
        const upload = await uploadService.initiate(
          identity,
          namespace,
          uploadInitiateRequestSchema.parse(request.body),
        );
        response.status(201).json({
          ...upload,
          ...(upload.transferMode !== "MULTIPART" ? { method: "PUT" } : {}),
        });
      } catch (error) {
        sendStorageError(response, error);
      }
    });

    router.post("/uploads/:uploadId/complete", async (request, response) => {
      try {
        if (await rejectWhenLimited(response, dependencies.rateLimiter, request, "storage-uploads")) return;
        const uploadId = z.string().uuid().parse(request.params.uploadId);
        const input = uploadCompleteRequestSchema.parse(request.body);
        const identity = await authenticate(request, dependencies);
        response.json(await uploadService.complete(identity, uploadId, input));
      } catch (error) {
        sendStorageError(response, error);
      }
    });

    router.put("/uploads/:uploadId", async (request, response) => {
      try {
        if (await rejectWhenLimited(response, dependencies.rateLimiter, request, "storage-uploads")) return;
        const uploadId = z.string().uuid().parse(request.params.uploadId);
        const identity = await authenticate(request, dependencies);
        const startedAt = process.hrtime.bigint();
        let bytes = 0n;
        let completed = false;
        dependencies.metrics?.incrementCounter("mosp_proxy_upload_attempts_total");
        try {
          const length = contentLength(request);
          if (length === null) throw new UploadProxyLengthRequired();
          bytes = length;
          const controller = new AbortController();
          const abort = () => controller.abort();
          request.once("aborted", abort);
          response.once("close", abort);
          try {
            response.json(await uploadService.proxyUpload(identity, uploadId, request, length, controller.signal));
            completed = true;
          } finally {
            request.off("aborted", abort);
            response.off("close", abort);
          }
        } finally {
          dependencies.metrics?.incrementCounter(
            completed ? "mosp_proxy_uploads_total" : "mosp_proxy_upload_failures_total",
          );
          dependencies.metrics?.incrementCounter("mosp_proxy_upload_bytes_total", metricBytes(bytes));
          dependencies.metrics?.observeDuration(
            "mosp_proxy_upload_duration_seconds",
            Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
          );
        }
      } catch (error) {
        sendStorageError(response, error, proxyTransferConfig);
      }
    });

    router.post("/uploads/:uploadId/parts/:partNumber", async (request, response) => {
      try {
        if (await rejectWhenLimited(response, dependencies.rateLimiter, request, "storage-uploads")) return;
        const uploadId = z.string().uuid().parse(request.params.uploadId);
        const partNumber = z.coerce.number().int().min(1).max(10_000).parse(request.params.partNumber);
        const identity = await authenticate(request, dependencies);
        response.json(await uploadService.presignPart(identity, uploadId, partNumber));
      } catch (error) {
        sendStorageError(response, error);
      }
    });

    router.delete("/uploads/:uploadId", async (request, response) => {
      try {
        if (await rejectWhenLimited(response, dependencies.rateLimiter, request, "storage-uploads")) return;
        const uploadId = z.string().uuid().parse(request.params.uploadId);
        const identity = await authenticate(request, dependencies);
        await uploadService.abort(identity, uploadId);
        response.status(204).end();
      } catch (error) {
        sendStorageError(response, error);
      }
    });
  }

  return router;
}

import request from "supertest";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../app.js";
import { BoundedInFlightLimiter } from "../security/in-flight-limiter.js";
import { InMemoryRateLimiter, RateLimiterUnavailableError } from "../security/rate-limit.js";
import {
  ApiCredentialAuthenticationError,
  type ApiCredentialAuthenticator,
  type ApiCredentialIdentity,
} from "../auth/api-credential.js";
import type { ObjectIndexService } from "./object-service.js";
import type { UploadService } from "./upload-service.js";
import type { UsageService } from "../usage/service.js";

const identity: ApiCredentialIdentity = {
  credentialId: "10000000-0000-4000-8000-000000000004",
  namespaceId: "10000000-0000-4000-8000-000000000003",
  organizationId: "10000000-0000-4000-8000-000000000002",
  principalId: "10000000-0000-4000-8000-000000000004",
  principalType: "API_CREDENTIAL",
};

function createStorageApp() {
  const apiCredentialAuthenticator = {
    authenticate: vi.fn().mockResolvedValue(identity),
  } as unknown as ApiCredentialAuthenticator;
  const objectIndexService = {
    list: vi.fn().mockResolvedValue([
      {
        key: "photos/image.jpg",
        sizeBytes: "42",
        contentType: "image/jpeg",
        checksum: null,
        modifiedAt: "2030-01-01T00:00:00.000Z",
        etag: "etag-value",
      },
    ]),
    head: vi.fn().mockResolvedValue({
      key: "photos/image.jpg",
      sizeBytes: "42",
      overwrite: false,
      contentType: "image/jpeg",
      checksum: null,
      modifiedAt: "2030-01-01T00:00:00.000Z",
      etag: "etag-value",
    }),
    presignDownload: vi.fn().mockResolvedValue({
      url: "https://storage.example/download",
      expiresAt: "2030-01-01T00:15:00.000Z",
    }),
    getTransferMode: vi.fn().mockResolvedValue("DIRECT"),
    proxyDownload: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
  } as unknown as ObjectIndexService;

  return {
    app: createApp({
      storage: { apiCredentialAuthenticator, objectIndexService },
    }),
    apiCredentialAuthenticator,
    objectIndexService,
  };
}

describe("storage metadata routes", () => {
  it("lists object metadata using API credential identity", async () => {
    const { app, objectIndexService } = createStorageApp();
    const response = await request(app)
      .get("/storage/v1/archive/objects")
      .query({ prefix: "photos", limit: "10" })
      .set("Authorization", "Bearer mosp_public-key.mosp_secret_abcdefghijklmnopqrstuvwxyz123456");

    expect(response.status).toBe(200);
    expect(response.body.objects[0].key).toBe("photos/image.jpg");
    expect(objectIndexService.list).toHaveBeenCalledWith(identity, "archive", {
      prefix: "photos",
      limit: 10,
    });
  });

  it("records an authenticated request in the scoped usage counter", async () => {
    const { apiCredentialAuthenticator, objectIndexService } = createStorageApp();
    const usageService = { recordRequest: vi.fn().mockResolvedValue(undefined) } as unknown as UsageService;
    const app = createApp({
      storage: { apiCredentialAuthenticator, objectIndexService, usageService },
    });

    const response = await request(app)
      .get("/storage/v1/archive/objects")
      .set("Authorization", "Bearer mosp_public-key.mosp_secret_abcdefghijklmnopqrstuvwxyz123456");

    expect(response.status).toBe(200);
    expect(usageService.recordRequest).toHaveBeenCalledWith(
      identity.organizationId,
      identity.namespaceId,
    );
  });

  it("returns HEAD metadata without a response body", async () => {
    const { app, objectIndexService } = createStorageApp();
    const response = await request(app)
      .head("/storage/v1/archive/objects/photos/image.jpg")
      .set("Authorization", "Bearer mosp_public-key.mosp_secret_abcdefghijklmnopqrstuvwxyz123456");

    expect(response.status).toBe(200);
    expect(response.headers["content-length"]).toBe("42");
    expect(response.headers.etag).toBe("etag-value");
    expect(response.text ?? "").toBe("");
    expect(objectIndexService.head).toHaveBeenCalledWith(
      identity,
      "archive",
      "photos/image.jpg",
    );
  });

  it("redirects downloads to a short-lived provider URL", async () => {
    const { app, objectIndexService } = createStorageApp();
    const response = await request(app)
      .get("/storage/v1/archive/objects/photos/image.jpg")
      .set("Authorization", "Bearer mosp_public-key.mosp_secret_abcdefghijklmnopqrstuvwxyz123456");

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe("https://storage.example/download");
    expect(objectIndexService.presignDownload).toHaveBeenCalledWith(
      identity,
      "archive",
      "photos/image.jpg",
    );
  });

  it("streams proxied downloads and meters bytes delivered", async () => {
    const { apiCredentialAuthenticator, objectIndexService } = createStorageApp();
    vi.mocked(objectIndexService.getTransferMode).mockResolvedValue("PROXIED");
    vi.mocked(objectIndexService.proxyDownload).mockResolvedValue({
      namespaceId: identity.namespaceId,
      body: Readable.from([Buffer.from("hello")]),
      metadata: {
        sizeBytes: 5n,
        contentType: "text/plain",
        etag: "etag-value",
        lastModified: new Date("2030-01-01T00:00:00.000Z"),
      },
    });
    const usageService = {
      recordRequest: vi.fn().mockResolvedValue(undefined),
      recordEgress: vi.fn().mockResolvedValue(undefined),
    } as unknown as UsageService;
    const app = createApp({
      metricsToken: "metrics-secret",
      storage: { apiCredentialAuthenticator, objectIndexService, usageService },
    });

    const response = await request(app)
      .get("/storage/v1/archive/objects/photos/image.jpg")
      .set("Authorization", "Bearer mosp_public-key.mosp_secret_abcdefghijklmnopqrstuvwxyz123456");

    expect(response.status).toBe(200);
    expect(response.text).toBe("hello");
    expect(response.headers["content-length"]).toBe("5");
    expect(objectIndexService.proxyDownload).toHaveBeenCalledWith(
      identity,
      "archive",
      "photos/image.jpg",
      expect.any(AbortSignal),
    );
    expect(usageService.recordEgress).toHaveBeenCalledWith(identity.organizationId, identity.namespaceId, 5n);
    const metrics = await request(app)
      .get("/metrics")
      .set("Authorization", "Bearer metrics-secret");
    expect(metrics.text).toContain("mosp_proxy_download_attempts_total 1");
    expect(metrics.text).toContain("mosp_proxy_downloads_total 1");
    expect(metrics.text).toContain("mosp_proxy_download_bytes_total 5");
    expect(metrics.text).toContain("mosp_proxy_download_duration_seconds_count 1");
  });

  it("deletes objects through the authenticated credential and forwards a safe request id", async () => {
    const { app, objectIndexService } = createStorageApp();
    const response = await request(app)
      .delete("/storage/v1/archive/objects/photos/image.jpg")
      .set("Authorization", "Bearer mosp_public-key.mosp_secret_abcdefghijklmnopqrstuvwxyz123456")
      .set("x-request-id", "request-123");

    expect(response.status).toBe(204);
    expect(objectIndexService.delete).toHaveBeenCalledWith(
      identity,
      "archive",
      "photos/image.jpg",
      "request-123",
    );
  });

  it("does not accept a malformed credential request", async () => {
    const { app, apiCredentialAuthenticator } = createStorageApp();
    vi.mocked(apiCredentialAuthenticator.authenticate).mockRejectedValue(
      new ApiCredentialAuthenticationError(),
    );
    const response = await request(app)
      .get("/storage/v1/archive/objects")
      .set("Authorization", "Bearer jwt-token");

    expect(response.status).toBe(401);
  });

  it("rejects unsafe object keys", async () => {
    const { app, objectIndexService } = createStorageApp();
    const response = await request(app)
      .head("/storage/v1/archive/objects/photos/%2E%2E%2Fprivate.txt")
      .set("Authorization", "Bearer mosp_public-key.mosp_secret_abcdefghijklmnopqrstuvwxyz123456");

    expect(response.status).toBe(400);
    expect(objectIndexService.head).not.toHaveBeenCalled();
  });

  it("rate-limits storage metadata requests", async () => {
    const { apiCredentialAuthenticator, objectIndexService } = createStorageApp();
    const app = createApp({
      storage: {
        apiCredentialAuthenticator,
        objectIndexService,
        rateLimiter: new InMemoryRateLimiter(1, 60_000),
      },
    });
    const auth = "Bearer mosp_public-key.mosp_secret_abcdefghijklmnopqrstuvwxyz123456";

    await request(app).get("/storage/v1/archive/objects").set("Authorization", auth);
    const response = await request(app).get("/storage/v1/archive/objects").set("Authorization", auth);

    expect(response.status).toBe(429);
  });

  it("fails closed when the shared storage limiter is unavailable", async () => {
    const { apiCredentialAuthenticator, objectIndexService } = createStorageApp();
    const app = createApp({
      storage: {
        apiCredentialAuthenticator,
        objectIndexService,
        rateLimiter: {
          consume: vi.fn().mockRejectedValue(new RateLimiterUnavailableError()),
        },
      },
    });

    const response = await request(app)
      .get("/storage/v1/archive/objects")
      .set("Authorization", "Bearer mosp_public-key.mosp_secret_abcdefghijklmnopqrstuvwxyz123456");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: "dependency_unavailable" });
    expect(objectIndexService.list).not.toHaveBeenCalled();
  });

  it("rejects storage work when the gateway is saturated", async () => {
    let releaseList!: () => void;
    let listStarted!: () => void;
    const started = new Promise<void>((resolve) => { listStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseList = resolve; });
    const apiCredentialAuthenticator = {
      authenticate: vi.fn().mockResolvedValue(identity),
    } as unknown as ApiCredentialAuthenticator;
    const objectIndexService = {
      list: vi.fn().mockImplementation(async () => {
        listStarted();
        await gate;
        return [];
      }),
    } as unknown as ObjectIndexService;
    const app = createApp({
      metricsToken: "metrics-secret",
      storage: {
        apiCredentialAuthenticator,
        objectIndexService,
        inFlightLimiter: new BoundedInFlightLimiter(1),
      },
    });
    const auth = "Bearer mosp_public-key.mosp_secret_abcdefghijklmnopqrstuvwxyz123456";

    const firstRequest = request(app)
      .get("/storage/v1/archive/objects")
      .set("Authorization", auth);
    const firstResponse = firstRequest.then((response) => response);
    await started;

    const saturated = await request(app)
      .get("/storage/v1/archive/objects")
      .set("Authorization", auth);

    expect(saturated.status).toBe(503);
    expect(saturated.body).toEqual({ error: "storage_overloaded" });
    expect(saturated.headers["retry-after"]).toBe("1");
    expect(objectIndexService.list).toHaveBeenCalledOnce();

    releaseList();
    expect((await firstResponse).status).toBe(200);
    const metrics = await request(app)
      .get("/metrics")
      .set("Authorization", "Bearer metrics-secret");
    expect(metrics.text).toContain("mosp_storage_overloaded_total 1");
    expect(metrics.text).toContain("mosp_storage_in_flight 0");
  });
});

describe("storage upload routes", () => {
  function createUploadApp() {
    const apiCredentialAuthenticator = {
      authenticate: vi.fn().mockResolvedValue(identity),
    } as unknown as ApiCredentialAuthenticator;
    const objectIndexService = {} as ObjectIndexService;
    const uploadService = {
      initiate: vi.fn().mockResolvedValue({
        uploadId: "20000000-0000-4000-8000-000000000001",
        key: "photos/image.jpg",
        sizeBytes: "42",
        state: "INITIATED",
        expiresAt: "2030-01-01T00:00:00.000Z",
        url: "https://storage.example/upload",
      }),
      complete: vi.fn().mockResolvedValue({
        uploadId: "20000000-0000-4000-8000-000000000001",
        key: "photos/image.jpg",
        sizeBytes: "42",
        state: "COMPLETED",
        expiresAt: "2030-01-01T00:00:00.000Z",
      }),
      presignPart: vi.fn().mockResolvedValue({
        method: "PUT",
        url: "https://storage.example/part",
        expiresAt: "2030-01-01T00:15:00.000Z",
      }),
      abort: vi.fn().mockResolvedValue(undefined),
      proxyUpload: vi.fn().mockResolvedValue({
        uploadId: "20000000-0000-4000-8000-000000000001",
        key: "photos/image.jpg",
        sizeBytes: "5",
        state: "COMPLETED",
        transferMode: "PROXIED",
        expiresAt: "2030-01-01T00:00:00.000Z",
      }),
    } as unknown as UploadService;
    return {
      app: createApp({
        metricsToken: "metrics-secret",
        storage: { apiCredentialAuthenticator, objectIndexService, uploadService },
      }),
      uploadService,
    };
  }

  it("initiates a direct upload with an idempotency key", async () => {
    const { app, uploadService } = createUploadApp();
    const response = await request(app)
      .post("/storage/v1/archive/uploads")
      .send({ key: "photos/image.jpg", sizeBytes: "42", idempotencyKey: "upload-key-123" })
      .set("Authorization", "Bearer mosp_public-key.mosp_secret_abcdefghijklmnopqrstuvwxyz123456");

    expect(response.status).toBe(201);
    expect(response.body.method).toBe("PUT");
    expect(uploadService.initiate).toHaveBeenCalledWith(identity, "archive", {
      key: "photos/image.jpg",
      sizeBytes: "42",
      idempotencyKey: "upload-key-123",
      overwrite: false,
    });
  });

  it("rejects an unsafe upload key before the service boundary", async () => {
    const { app, uploadService } = createUploadApp();
    const response = await request(app)
      .post("/storage/v1/archive/uploads")
      .send({ key: "../private.txt", sizeBytes: "42", idempotencyKey: "upload-key-123" })
      .set("Authorization", "Bearer mosp_public-key.mosp_secret_abcdefghijklmnopqrstuvwxyz123456");

    expect(response.status).toBe(400);
    expect(uploadService.initiate).not.toHaveBeenCalled();
  });

  it("completes and aborts uploads within the credential namespace", async () => {
    const { app, uploadService } = createUploadApp();
    const auth = "Bearer mosp_public-key.mosp_secret_abcdefghijklmnopqrstuvwxyz123456";
    const complete = await request(app)
      .post("/storage/v1/uploads/20000000-0000-4000-8000-000000000001/complete")
      .send({})
      .set("Authorization", auth);
    const abort = await request(app)
      .delete("/storage/v1/uploads/20000000-0000-4000-8000-000000000001")
      .set("Authorization", auth);

    expect(complete.status).toBe(200);
    expect(abort.status).toBe(204);
    expect(uploadService.complete).toHaveBeenCalledWith(
      identity,
      "20000000-0000-4000-8000-000000000001",
      {},
    );
    expect(uploadService.abort).toHaveBeenCalledWith(identity, "20000000-0000-4000-8000-000000000001");
  });

  it("presigns a multipart part only through the authenticated upload", async () => {
    const { app, uploadService } = createUploadApp();
    const response = await request(app)
      .post("/storage/v1/uploads/20000000-0000-4000-8000-000000000001/parts/2")
      .set("Authorization", "Bearer mosp_public-key.mosp_secret_abcdefghijklmnopqrstuvwxyz123456");

    expect(response.status).toBe(200);
    expect(response.body.method).toBe("PUT");
    expect(uploadService.presignPart).toHaveBeenCalledWith(
      identity,
      "20000000-0000-4000-8000-000000000001",
      2,
    );
  });

  it("passes multipart completion parts through the validated request boundary", async () => {
    const { app, uploadService } = createUploadApp();
    const response = await request(app)
      .post("/storage/v1/uploads/20000000-0000-4000-8000-000000000001/complete")
      .send({ parts: [{ partNumber: 1, etag: "etag-1", sizeBytes: "42" }] })
      .set("Authorization", "Bearer mosp_public-key.mosp_secret_abcdefghijklmnopqrstuvwxyz123456");

    expect(response.status).toBe(200);
    expect(uploadService.complete).toHaveBeenCalledWith(
      identity,
      "20000000-0000-4000-8000-000000000001",
      { parts: [{ partNumber: 1, etag: "etag-1", sizeBytes: "42" }] },
    );
  });

  it("accepts a bounded proxied upload only with an exact Content-Length", async () => {
    const { app, uploadService } = createUploadApp();
    const response = await request(app)
      .put("/storage/v1/uploads/20000000-0000-4000-8000-000000000001")
      .set("Authorization", "Bearer mosp_public-key.mosp_secret_abcdefghijklmnopqrstuvwxyz123456")
      .send(Buffer.from("hello"));

    expect(response.status).toBe(200);
    expect(response.body.transferMode).toBe("PROXIED");
    expect(uploadService.proxyUpload).toHaveBeenCalledWith(
      identity,
      "20000000-0000-4000-8000-000000000001",
      expect.anything(),
      5n,
      expect.any(AbortSignal),
    );
    const metrics = await request(app)
      .get("/metrics")
      .set("Authorization", "Bearer metrics-secret");
    expect(metrics.text).toContain("mosp_proxy_upload_attempts_total 1");
    expect(metrics.text).toContain("mosp_proxy_uploads_total 1");
    expect(metrics.text).toContain("mosp_proxy_upload_bytes_total 5");
    expect(metrics.text).toContain("mosp_proxy_upload_duration_seconds_count 1");
  });

  it("rejects proxied uploads with a malformed Content-Length", async () => {
    const { app, uploadService } = createUploadApp();
    const response = await request(app)
      .put("/storage/v1/uploads/20000000-0000-4000-8000-000000000001")
      .set("Authorization", "Bearer mosp_public-key.mosp_secret_abcdefghijklmnopqrstuvwxyz123456")
      .set("Content-Length", "invalid")
      .send(Buffer.from("hello"));

    // Node rejects an invalid HTTP Content-Length before Express receives it.
    expect(response.status).toBe(400);
    expect(uploadService.proxyUpload).not.toHaveBeenCalled();
  });
});

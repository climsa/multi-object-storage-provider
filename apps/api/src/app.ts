import express, { type ErrorRequestHandler, type RequestHandler } from "express";

import { createApiCredentialRouter, type ApiCredentialRouteDependencies } from "./api-credentials/routes.js";
import { createFolderGrantRouter, type FolderGrantRouteDependencies } from "./folder-grants/routes.js";
import { createStorageRouter, type StorageRouteDependencies } from "./storage/routes.js";
import { RateLimiterUnavailableError } from "./security/rate-limit.js";
import { createAuthRouter, type AuthRouteDependencies } from "./auth/routes.js";
import { createBucketRouter, type BucketRouteDependencies } from "./buckets/routes.js";
import { createProviderRouter, type ProviderRouteDependencies } from "./providers/routes.js";
import { createOrganizationRouter, type OrganizationRouteDependencies } from "./organizations/routes.js";
import { createNamespaceRouter, type NamespaceRouteDependencies } from "./namespaces/routes.js";
import { createMigrationRouter, type MigrationRouteDependencies } from "./migrations/routes.js";
import { requestIdFromHeader } from "./security/request-id.js";
import { MetricsRegistry, metricsTokenMatches } from "./observability/metrics.js";
import { createPlatformRouter, type PlatformRouteDependencies } from "./platform/routes.js";
import { createObjectExplorerRouter, type ObjectExplorerRouteDependencies } from "./object-explorer/routes.js";

export interface AppDependencies {
  auth?: AuthRouteDependencies;
  apiCredentials?: ApiCredentialRouteDependencies;
  folderGrants?: FolderGrantRouteDependencies;
  storage?: StorageRouteDependencies;
  buckets?: BucketRouteDependencies;
  providers?: ProviderRouteDependencies;
  organizations?: OrganizationRouteDependencies;
  namespaces?: NamespaceRouteDependencies;
  migrations?: MigrationRouteDependencies;
  platform?: PlatformRouteDependencies;
  objectExplorer?: ObjectExplorerRouteDependencies;
  readinessCheck?: () => Promise<void>;
  trustProxy?: false | number;
  metricsToken?: string;
}

export function createApp({ auth, apiCredentials, buckets, folderGrants, metricsToken, migrations, namespaces, objectExplorer, organizations, platform, providers, readinessCheck, storage, trustProxy }: AppDependencies = {}) {
  const app = express();
  const metrics = new MetricsRegistry();

  app.disable("x-powered-by");
  if (trustProxy !== undefined) {
    app.set("trust proxy", trustProxy);
  }
  app.use(express.json({ limit: "1mb" }));
  app.use(((request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    // API and object metadata responses contain credentials, tenant data, or
    // short-lived transfer decisions. Never let an intermediary cache them.
    if (request.path.startsWith("/v1/") || request.path.startsWith("/storage/")) {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Pragma", "no-cache");
    }
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    if (process.env.NODE_ENV === "production") {
      response.setHeader(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains",
      );
    }
    response.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
    next();
  }) satisfies RequestHandler);
  app.use(((request, response, next) => {
    metrics.observeMiddleware(request, response, process.hrtime.bigint());
    next();
  }) satisfies RequestHandler);
  app.use(((request, response, next) => {
    const requestId = requestIdFromHeader(request.header("x-request-id"));
    response.setHeader("x-request-id", requestId);
    next();
  }) satisfies RequestHandler);

  if (auth) {
    app.use("/v1/auth", createAuthRouter(auth));
  }

  if (apiCredentials) {
    app.use("/v1/api-credentials", createApiCredentialRouter(apiCredentials));
  }

  if (folderGrants) {
    app.use("/v1/folder-grants", createFolderGrantRouter(folderGrants));
  }

  if (storage) {
    app.use("/storage/v1", createStorageRouter({ ...storage, metrics }));
  }

  if (objectExplorer) {
    app.use("/v1/object-explorer", createObjectExplorerRouter(objectExplorer));
  }

  if (providers) {
    app.use("/v1/providers", createProviderRouter(providers));
  }

  if (organizations) {
    app.use("/v1/organizations", createOrganizationRouter(organizations));
  }

  if (namespaces) {
    app.use("/v1/namespaces", createNamespaceRouter(namespaces));
  }

  if (buckets) {
    app.use("/v1/buckets", createBucketRouter(buckets));
  }

  if (migrations) {
    app.use("/v1/migrations", createMigrationRouter(migrations));
  }

  if (platform) {
    app.use("/v1/platform", createPlatformRouter(platform));
  }

  app.get("/healthz", (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json({ status: "ok" });
  });

  app.get("/readyz", async (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      await readinessCheck?.();
      response.json({ status: "ready" });
    } catch {
      response.status(503).json({ status: "unavailable" });
    }
  });

  app.get("/metrics", (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    if (!metricsToken || !metricsTokenMatches(request, metricsToken)) {
      response.status(404).end();
      return;
    }
    response.type("text/plain; version=0.0.4").send(metrics.renderPrometheus());
  });

  app.use((_request, response) => {
    response.status(404).json({ error: "not_found" });
  });

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    if (
      error &&
      typeof error === "object" &&
      "type" in error &&
      (error as { type?: unknown }).type === "entity.parse.failed"
    ) {
      response.status(400).json({ error: "invalid_json" });
      return;
    }
    if (
      error &&
      typeof error === "object" &&
      "type" in error &&
      (error as { type?: unknown }).type === "entity.too.large"
    ) {
      response.status(413).json({ error: "request_too_large" });
      return;
    }
    if (
      error &&
      typeof error === "object" &&
      "type" in error &&
      (error as { type?: unknown }).type === "encoding.unsupported"
    ) {
      response.status(415).json({ error: "unsupported_encoding" });
      return;
    }
    if (error instanceof RateLimiterUnavailableError) {
      response.status(503).json({ error: "dependency_unavailable" });
      return;
    }
    response.status(500).json({ error: "internal_error" });
  };
  app.use(errorHandler);

  return app;
}

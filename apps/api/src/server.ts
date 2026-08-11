import { JwtService, PasswordHasher } from "@mosp/auth";
import {
  createPrismaClient,
  readDatabaseUrl,
  readSecret,
  resolveSecretFile,
} from "@mosp/db";
import pino from "pino";
import { createClient } from "redis";

import { PrismaAuthRepository } from "./auth/repository.js";
import { PrismaOrganizationAccessRepository } from "./auth/organization-access.js";
import { AuthService } from "./auth/service.js";
import { createApp } from "./app.js";
import { BucketConnectionService } from "./buckets/service.js";
import { ProviderConnectionService } from "./providers/service.js";
import { InMemoryRateLimiter, RedisRateLimiter } from "./security/rate-limit.js";
import { BoundedInFlightLimiter } from "./security/in-flight-limiter.js";
import { OrganizationService } from "./organizations/service.js";
import { NamespaceService } from "./namespaces/service.js";
import { ApiCredentialService } from "./api-credentials/service.js";
import { FolderGrantService } from "./folder-grants/service.js";
import { ApiCredentialAuthenticator } from "./auth/api-credential.js";
import { ObjectIndexService } from "./storage/object-service.js";
import { UploadService } from "./storage/upload-service.js";
import { PlacementService } from "./storage/placement-service.js";
import { MigrationService } from "./migrations/service.js";
import { UsageService } from "./usage/service.js";
import { PlatformService } from "./platform/service.js";
import { ObjectExplorerService } from "./object-explorer/service.js";
import {
  createProxyTransferConfig,
  DEFAULT_PROXY_TRANSFER_CONFIG,
} from "./storage/transfer.js";

const logger = pino({
  redact: {
    paths: ["req.headers.authorization", "req.headers.cookie", "*.presignedUrl"],
    censor: "[REDACTED]",
  },
});

const databaseUrl = await readDatabaseUrl();
const database = createPrismaClient(databaseUrl);
const jwtSecret = Buffer.from(await readSecret("auth-signing-key"), "base64url");

function readBooleanFlag(name: string): boolean {
  const value = process.env[name];
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`${name} must be either true or false`);
}

function readProviderPorts(allowHttp: boolean): number[] {
  const configured = process.env.MOSP_PROVIDER_ALLOWED_PORTS;
  if (!configured) return allowHttp ? [80, 443] : [443];

  const ports = configured.split(",").map((value) => Number(value.trim()));
  if (
    ports.length === 0 ||
    ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)
  ) {
    throw new Error("MOSP_PROVIDER_ALLOWED_PORTS must contain valid TCP ports");
  }

  return [...new Set(ports)];
}

function readTrustProxyHops(): false | number {
  const configured = process.env.MOSP_TRUST_PROXY_HOPS;
  if (configured === undefined) return false;

  if (!/^([1-9]|10)$/.test(configured)) {
    throw new Error("MOSP_TRUST_PROXY_HOPS must be an integer from 1 to 10");
  }

  return Number(configured);
}

function readStorageInFlightLimit(): number {
  const configured = process.env.MOSP_STORAGE_MAX_IN_FLIGHT;
  if (configured === undefined) return 100;

  if (!/^([1-9][0-9]{0,3}|10000)$/.test(configured)) {
    throw new Error("MOSP_STORAGE_MAX_IN_FLIGHT must be an integer from 1 to 10000");
  }

  return Number(configured);
}

function readAllowedOrigins(): string[] {
  const configured = process.env.MOSP_ALLOWED_ORIGINS;
  if (!configured) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("MOSP_ALLOWED_ORIGINS is required in production");
    }
    return ["http://localhost:3000", "http://127.0.0.1:3000"];
  }

  const origins = configured.split(",").map((origin) => origin.trim());
  for (const origin of origins) {
    const parsed = new URL(origin);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.pathname !== "/") {
      throw new Error("MOSP_ALLOWED_ORIGINS must contain origins without paths");
    }
  }
  return origins.map((origin) => new URL(origin).origin);
}

async function withDependencyTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("DEPENDENCY_TIMEOUT")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function redisErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_:-]{1,64}$/.test(code)) return code;
  }
  return "REDIS_ERROR";
}

const allowProviderHttp = readBooleanFlag("MOSP_PROVIDER_ALLOW_HTTP");
const allowProviderPrivateNetwork = readBooleanFlag(
  "MOSP_PROVIDER_ALLOW_PRIVATE_NETWORK",
);
const allowedOrigins = readAllowedOrigins();
const trustProxy = readTrustProxyHops();
const platformService = new PlatformService(database);
const proxyTransferConfig = createProxyTransferConfig(
  await platformService.getBigIntSetting(
    "proxy_max_object_size_bytes",
    DEFAULT_PROXY_TRANSFER_CONFIG.maxObjectBytes,
  ),
  await platformService.getNumberSetting(
    "proxy_transfer_timeout_seconds",
    DEFAULT_PROXY_TRANSFER_CONFIG.timeoutMs / 1000,
  ),
);
const storageInFlightLimiter = new BoundedInFlightLimiter(
  await platformService.getNumberSetting("storage_max_in_flight", readStorageInFlightLimit()),
);
const authService = new AuthService({
  jwtService: new JwtService({
    audience: "mosp-api",
    issuer: "mosp",
    secret: jwtSecret,
  }),
  passwordHasher: new PasswordHasher(),
  repository: new PrismaAuthRepository(database),
});
const organizationAccess = new PrismaOrganizationAccessRepository(database);
const providerService = new ProviderConnectionService(database, {
  allowHttp: allowProviderHttp,
  allowPrivateNetwork: allowProviderPrivateNetwork,
  allowedPorts: readProviderPorts(allowProviderHttp),
  credentialKeyFile: resolveSecretFile("provider-kek"),
});
const bucketService = new BucketConnectionService(database, providerService);
const organizationService = new OrganizationService(database);
const namespaceService = new NamespaceService(database);
const apiCredentialService = new ApiCredentialService(database);
const folderGrantService = new FolderGrantService(database);
const apiCredentialAuthenticator = new ApiCredentialAuthenticator(database);
const usageService = new UsageService(database);
const objectIndexService = new ObjectIndexService(
  database,
  folderGrantService,
  providerService,
  usageService,
  proxyTransferConfig,
);
const placementService = new PlacementService(database);
const objectExplorerService = new ObjectExplorerService(
  database,
  providerService,
  usageService,
  placementService,
  proxyTransferConfig,
);
const uploadService = new UploadService(
  database,
  folderGrantService,
  providerService,
  placementService,
  proxyTransferConfig,
);
const migrationService = new MigrationService(database);
async function createRateLimiterClient() {
  const configuredUrl = process.env.MOSP_REDIS_URL;
  if (!configuredUrl) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("MOSP_REDIS_URL is required in production");
    }
    return null;
  }

  const client = createClient({ url: configuredUrl });
  client.on("error", (error) => logger.error({ code: redisErrorCode(error) }, "Redis rate limiter error"));
  await client.connect();
  return client;
}

const redisRateLimiterClient = await createRateLimiterClient();
const authRateLimiter = redisRateLimiterClient
  ? new RedisRateLimiter(redisRateLimiterClient, 10, 60_000)
  : new InMemoryRateLimiter(10, 60_000);
const providerRateLimiter = redisRateLimiterClient
  ? new RedisRateLimiter(redisRateLimiterClient, 30, 60_000)
  : new InMemoryRateLimiter(30, 60_000);
const storageRateLimiter = redisRateLimiterClient
  ? new RedisRateLimiter(redisRateLimiterClient, 60, 60_000)
  : new InMemoryRateLimiter(60, 60_000);
const port = 4000;
const metricsToken = process.env.MOSP_METRICS_TOKEN?.trim();
if (process.env.NODE_ENV === "production" && !metricsToken) {
  throw new Error("MOSP_METRICS_TOKEN is required in production");
}
let shuttingDown = false;

const app = createApp({
  auth: {
    allowedOrigins,
    authService,
    cookieOptions: {
      secure: process.env.NODE_ENV === "production",
    },
    rateLimiter: authRateLimiter,
  },
  apiCredentials: {
    apiCredentialService,
    authService,
    organizationAccess,
  },
  folderGrants: {
    authService,
    folderGrantService,
    organizationAccess,
  },
  storage: {
    apiCredentialAuthenticator,
    objectIndexService,
    uploadService,
    rateLimiter: storageRateLimiter,
    inFlightLimiter: storageInFlightLimiter,
    usageService,
    proxyTransferConfig,
  },
  objectExplorer: {
    authService,
    organizationAccess,
    objectExplorerService,
    rateLimiter: storageRateLimiter,
  },
  providers: {
    authService,
    bucketService,
    organizationAccess,
    providerService,
    rateLimiter: providerRateLimiter,
  },
  buckets: {
    authService,
    bucketService,
    organizationAccess,
    providerService,
    rateLimiter: providerRateLimiter,
  },
  organizations: {
    authService,
    organizationAccess,
    organizationService,
    usageService,
  },
  namespaces: {
    authService,
    namespaceService,
    organizationAccess,
  },
  migrations: {
    authService,
    organizationAccess,
    migrationService,
  },
  platform: {
    authService,
    organizationAccess,
    platformService,
  },
  trustProxy,
  readinessCheck: async () => {
    if (shuttingDown) throw new Error("SHUTTING_DOWN");
    await withDependencyTimeout(database.$queryRaw`SELECT 1`, 5_000);
    if (redisRateLimiterClient) {
      if (!redisRateLimiterClient.isReady) throw new Error("REDIS_NOT_READY");
      await withDependencyTimeout(redisRateLimiterClient.ping(), 5_000);
    }
  },
  ...(metricsToken ? { metricsToken } : {}),
});

const server = app.listen(port, () => {
  logger.info({ port }, "API listening");
});

// Bound slow-client and idle-connection resources before the API is exposed.
server.requestTimeout = proxyTransferConfig.timeoutMs;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 100;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "API shutting down");
  await new Promise<void>((resolve) => {
    let settled = false;
    let forceCloseTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (forceCloseTimer) clearTimeout(forceCloseTimer);
      resolve();
    };
    server.close(finish);
    forceCloseTimer = setTimeout(() => {
      logger.warn({ timeoutMs: 30_000 }, "API graceful shutdown timed out; closing connections");
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      finish();
    }, 30_000);
    forceCloseTimer.unref();
  });
  await redisRateLimiterClient?.quit();
  await database.$disconnect();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

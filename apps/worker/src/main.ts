import { createPrismaClient, readDatabaseUrl, resolveSecretFile } from "@mosp/db";
import pino from "pino";

import { WorkerProviderResolver } from "./provider-resolver.js";
import { UploadReconciliationService } from "./upload-reconciliation.js";
import { MigrationReconciliationService } from "./migration-reconciliation.js";
import { ProviderHealthReconciliationService } from "./provider-health-reconciliation.js";

const logger = pino({
  redact: {
    paths: ["*.credential", "*.presignedUrl"],
    censor: "[REDACTED]",
  },
});

const database = createPrismaClient(await readDatabaseUrl());

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

function readIntervalMs(): number {
  const configured = process.env.MOSP_UPLOAD_RECONCILIATION_INTERVAL_MS;
  if (!configured) return 60_000;
  const interval = Number(configured);
  if (!Number.isInteger(interval) || interval < 1_000 || interval > 3_600_000) {
    throw new Error(
      "MOSP_UPLOAD_RECONCILIATION_INTERVAL_MS must be an integer from 1000 to 3600000",
    );
  }
  return interval;
}

function readMigrationConcurrencyFromEnv(): number | null {
  const configured = process.env.MOSP_MIGRATION_MAX_CONCURRENT_PER_PROVIDER;
  if (!configured) return null;
  if (!/^([1-9]|1[0-9]|20)$/.test(configured)) {
    throw new Error(
      "MOSP_MIGRATION_MAX_CONCURRENT_PER_PROVIDER must be an integer from 1 to 20",
    );
  }
  return Number(configured);
}

async function readPlatformNumber(key: string, fallback: number): Promise<number> {
  const setting = await database.platformSetting.findUnique({ where: { key }, select: { value: true } });
  return typeof setting?.value === "number" && Number.isFinite(setting.value) ? setting.value : fallback;
}

const allowProviderHttp = readBooleanFlag("MOSP_PROVIDER_ALLOW_HTTP");
const allowProviderPrivateNetwork = readBooleanFlag(
  "MOSP_PROVIDER_ALLOW_PRIVATE_NETWORK",
);
const providerService = new WorkerProviderResolver(database, {
  allowHttp: allowProviderHttp,
  allowPrivateNetwork: allowProviderPrivateNetwork,
  allowedPorts: readProviderPorts(allowProviderHttp),
  credentialKeyFile: resolveSecretFile("provider-kek"),
});
const reconciliation = new UploadReconciliationService(database, providerService);
const migrationReconciliation = new MigrationReconciliationService(database, providerService);
const providerHealthReconciliation = new ProviderHealthReconciliationService(database, providerService);
const reconciliationIntervalMs = readIntervalMs();
const migrationMaxConcurrentPerProvider = await readPlatformNumber(
  "migration_max_concurrent_per_provider",
  readMigrationConcurrencyFromEnv() ?? 2,
);
const migrationRetryDelayMs = (await readPlatformNumber("migration_retry_delay_seconds", 60)) * 1000;
const providerHealthIntervalMs = (await readPlatformNumber("provider_health_check_interval_seconds", 60)) * 1000;
let reconciliationRunning = false;
let activeReconciliation: Promise<void> | null = null;
let shutdownPromise: Promise<void> | null = null;

async function reconcileUploads(): Promise<void> {
  if (reconciliationRunning || shutdownPromise) return;
  reconciliationRunning = true;
  const run = (async () => {
    try {
      const result = await reconciliation.reconcile();
      const migrationResult = await migrationReconciliation.reconcile({
        maxConcurrentPerProvider: migrationMaxConcurrentPerProvider,
        retryDelayMs: migrationRetryDelayMs,
      });
      const healthResult = await providerHealthReconciliation.reconcile({ minIntervalMs: providerHealthIntervalMs });
      if (
        result.expired > 0 ||
        result.failed > 0 ||
        migrationResult.completed > 0 ||
        migrationResult.failed > 0 ||
        healthResult.unhealthy > 0
      ) {
        logger.info(
          { ...result, migration: migrationResult, providerHealth: healthResult },
          "Storage reconciliation completed",
        );
      }
    } catch (error) {
      logger.error({ err: error }, "Upload reconciliation failed");
    }
  })();
  activeReconciliation = run;
  try {
    await run;
  } finally {
    activeReconciliation = null;
    reconciliationRunning = false;
  }
}

await database.$queryRaw`SELECT 1`;
await reconcileUploads();
const reconciliationTimer = setInterval(() => void reconcileUploads(), reconciliationIntervalMs);
reconciliationTimer.unref();
logger.info(
  { reconciliationIntervalMs, migrationMaxConcurrentPerProvider, migrationRetryDelayMs, providerHealthIntervalMs },
  "Worker database connection is ready",
);

async function shutdown(signal: string): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    logger.info({ signal }, "Worker shutting down");
    clearInterval(reconciliationTimer);
    if (activeReconciliation) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        activeReconciliation,
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            logger.warn({ timeoutMs: 30_000 }, "Worker reconciliation drain timed out");
            resolve();
          }, 30_000);
          timeout.unref();
        }),
      ]);
      if (timeout) clearTimeout(timeout);
    }
    await database.$disconnect();
  })();
  return shutdownPromise;
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

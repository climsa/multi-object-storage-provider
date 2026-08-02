import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(scriptDirectory, "../.local/secrets/e2e-test.json");
const requestTimeoutMs = 120_000;
const maxConcurrency = 50;
const maxIterations = 20;
const maxPayloadBytes = 64 * 1024 * 1024;
const maxDurationSeconds = 300;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parsePositiveInteger(value, name, maximum) {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}`);
  }
  return parsed;
}

function parseNonNegativeInteger(value, name, maximum) {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new Error(`${name} must be between 0 and ${maximum}`);
  }
  return parsed;
}

function parseOptions(argv) {
  const options = { concurrency: 4, iterations: 2, payloadBytes: 64 * 1024, durationSeconds: null, maxFailures: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [flag, inlineValue] = argument.split("=", 2);
    const value = inlineValue ?? argv[++index];
    if (value === undefined) throw new Error(`${flag} requires a value`);
    if (flag === "--concurrency") options.concurrency = parsePositiveInteger(value, flag, maxConcurrency);
    else if (flag === "--iterations") options.iterations = parsePositiveInteger(value, flag, maxIterations);
    else if (flag === "--payload-bytes") options.payloadBytes = parsePositiveInteger(value, flag, maxPayloadBytes);
    else if (flag === "--duration-seconds") options.durationSeconds = parsePositiveInteger(value, flag, maxDurationSeconds);
    else if (flag === "--max-failures") options.maxFailures = parseNonNegativeInteger(value, flag, maxConcurrency * maxIterations);
    else throw new Error(`Unknown option: ${flag}`);
  }
  return options;
}

async function readConfig() {
  const fileStats = await stat(configPath).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new Error(`E2E config missing at ${configPath}; create it from project-docs/provider-contract-test.md`);
    }
    throw error;
  });
  if ((fileStats.mode & 0o077) !== 0) throw new Error("e2e-test.json must not be group/world readable; run chmod 600");
  const parsed = JSON.parse(await readFile(configPath, "utf8"));
  if (!isRecord(parsed)) throw new Error("e2e-test.json must contain a JSON object");
  for (const field of ["apiBaseUrl", "adminEmail", "adminPassword"]) {
    if (typeof parsed[field] !== "string" || parsed[field].trim() === "") throw new Error(`e2e-test.json requires ${field}`);
  }
  return {
    apiBaseUrl: parsed.apiBaseUrl.replace(/\/$/, ""),
    adminEmail: parsed.adminEmail,
    adminPassword: parsed.adminPassword,
    organizationId: typeof parsed.organizationId === "string" ? parsed.organizationId : undefined,
    namespaceId: typeof parsed.namespaceId === "string" ? parsed.namespaceId : undefined,
  };
}

function assertStatus(response, expected, label) {
  if (response.status !== expected) throw new Error(`${label} returned HTTP ${response.status}`);
}

async function fetchWithTimeout(url, init = {}) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(requestTimeoutMs) });
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { throw new Error("Expected a JSON response"); }
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return Math.round(sorted[index]);
}

async function run() {
  const options = parseOptions(process.argv.slice(2));
  const config = await readConfig();
  const origin = new URL(config.apiBaseUrl).origin.replace(":4000", ":3000");
  let accessToken;
  let organizationId = config.organizationId;
  let namespaceId = config.namespaceId;
  let namespaceSlug;
  let originalTransferMode;
  let credentialId;
  let storageCredential;
  let grantId;
  const objectKeys = new Set();
  const timingsMs = [];

  async function control(path, init = {}, scoped = false) {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${accessToken}`);
    if (scoped && organizationId) headers.set("x-organization-id", organizationId);
    if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
    return fetchWithTimeout(`${config.apiBaseUrl}${path}`, { ...init, headers });
  }

  async function storage(path, init = {}) {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${storageCredential}`);
    if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
    return fetchWithTimeout(`${config.apiBaseUrl}${path}`, { ...init, headers });
  }

  const loginResponse = await fetchWithTimeout(`${config.apiBaseUrl}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email: config.adminEmail, password: config.adminPassword }),
  });
  const login = await readJson(loginResponse);
  assertStatus(loginResponse, 200, "login");
  accessToken = login.accessToken;

  const organizationsResponse = await control("/v1/platform/organizations");
  assertStatus(organizationsResponse, 200, "platform organizations");
  const organizations = await readJson(organizationsResponse);
  if (!organizationId) organizationId = organizations.organizations[0]?.id;
  if (!organizationId) throw new Error("No organization available for capacity test");

  const namespacesResponse = await control("/v1/namespaces", { headers: { "x-organization-id": organizationId } });
  assertStatus(namespacesResponse, 200, "namespace list");
  const namespaces = await readJson(namespacesResponse);
  const namespace = namespaces.namespaces.find((item) => item.id === namespaceId) ?? namespaces.namespaces[0];
  if (!namespace || namespace.status !== "ACTIVE") throw new Error("No active namespace available for capacity test");
  namespaceId = namespace.id;
  namespaceSlug = namespace.slug;
  originalTransferMode = namespace.defaultTransferMode;

  try {
    const credentialResponse = await control("/v1/api-credentials", {
      method: "POST",
      headers: { "x-organization-id": organizationId },
      body: JSON.stringify({ namespaceId, expiresAt: null }),
    });
    assertStatus(credentialResponse, 201, "API credential create");
    const createdCredential = await readJson(credentialResponse);
    credentialId = createdCredential.credential.id;
    storageCredential = `${createdCredential.credential.keyId}.${createdCredential.secret}`;

    const prefix = `capacity/${randomUUID()}`;
    const grantResponse = await control("/v1/folder-grants", {
      method: "POST",
      headers: { "x-organization-id": organizationId },
      body: JSON.stringify({ namespaceId, principalType: "API_CREDENTIAL", principalId: credentialId, prefix, actions: ["read", "write", "delete"] }),
    });
    assertStatus(grantResponse, 201, "folder grant create");
    grantId = (await readJson(grantResponse)).grant.id;

    const modeResponse = await control(`/v1/namespaces/${encodeURIComponent(namespaceId)}`, {
      method: "PATCH",
      headers: { "x-organization-id": organizationId },
      body: JSON.stringify({ defaultTransferMode: "PROXIED" }),
    });
    assertStatus(modeResponse, 200, "enable proxied transfer mode");

    const payload = Buffer.alloc(options.payloadBytes, 0x5a);
    let completed = 0;
    let failed = 0;
    const failureReasons = [];
    const startedAt = performance.now();
    const deadline = options.durationSeconds === null
      ? null
      : startedAt + options.durationSeconds * 1_000;
    let iterationsCompleted = 0;
    for (let iteration = 0; deadline === null || performance.now() < deadline; iteration += 1) {
      const outcomes = await Promise.allSettled(Array.from({ length: options.concurrency }, async (_, worker) => {
        const objectKey = `${prefix}/${iteration}/${worker}.bin`;
        objectKeys.add(objectKey);
        const startedAt = performance.now();
        const initiateResponse = await storage(`/storage/v1/${namespaceSlug}/uploads`, {
          method: "POST",
          body: JSON.stringify({ key: objectKey, sizeBytes: String(payload.length), contentType: "application/octet-stream", idempotencyKey: randomUUID(), overwrite: false }),
        });
        assertStatus(initiateResponse, 201, "proxied upload initiate");
        const upload = await readJson(initiateResponse);
        if (upload.transferMode !== "PROXIED" || upload.url !== undefined) throw new Error("Proxy capacity test received a provider URL");

        const putResponse = await storage(`/storage/v1/uploads/${encodeURIComponent(upload.uploadId)}`, {
          method: "PUT",
          headers: { "content-type": "application/octet-stream" },
          body: payload,
        });
        assertStatus(putResponse, 200, "proxied upload");

        const downloadResponse = await storage(`/storage/v1/${namespaceSlug}/objects/${objectKey}`);
        assertStatus(downloadResponse, 200, "proxied download");
        const downloaded = Buffer.from(await downloadResponse.arrayBuffer());
        if (!downloaded.equals(payload)) throw new Error("Proxy capacity payload mismatch");

        const deleteResponse = await storage(`/storage/v1/${namespaceSlug}/objects/${objectKey}`, { method: "DELETE" });
        assertStatus(deleteResponse, 204, "proxied object delete");
        timingsMs.push(Math.round(performance.now() - startedAt));
        completed += 1;
      }));
      const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
      failed += rejected.length;
      if (rejected.length > 0) {
        for (const outcome of rejected.slice(0, 3)) {
          const reason = outcome.reason;
          failureReasons.push(reason instanceof Error ? reason.message : String(reason));
        }
        if (failed > options.maxFailures) break;
      }
      iterationsCompleted += 1;
      if (deadline === null && iterationsCompleted >= options.iterations) break;
    }

    const result = {
      organizationId,
      namespaceId,
      namespaceSlug,
      concurrency: options.concurrency,
      iterations: options.iterations,
      durationSeconds: options.durationSeconds,
      maxFailures: options.maxFailures,
      iterationsCompleted,
      payloadBytes: options.payloadBytes,
      operations: completed + failed,
      completed,
      failed,
      failureReasons,
      latencyMs: { p50: percentile(timingsMs, 0.5), p95: percentile(timingsMs, 0.95), max: timingsMs.length > 0 ? Math.max(...timingsMs) : null },
    };
    console.log(JSON.stringify(result, null, 2));
    if (failed > options.maxFailures) throw new Error(`${failed} capacity operation(s) failed; see failureReasons in the report`);
  } finally {
    if (storageCredential) {
      for (const objectKey of objectKeys) {
        await storage(`/storage/v1/${namespaceSlug}/objects/${objectKey}`, { method: "DELETE" }).catch(() => undefined);
      }
    }
    if (grantId) await control(`/v1/folder-grants/${encodeURIComponent(grantId)}`, { method: "DELETE", headers: { "x-organization-id": organizationId } }).catch(() => undefined);
    if (credentialId) await control(`/v1/api-credentials/${encodeURIComponent(credentialId)}/revoke`, { method: "POST", headers: { "x-organization-id": organizationId }, body: JSON.stringify({}) }).catch(() => undefined);
    if (namespaceId && organizationId && originalTransferMode) {
      await control(`/v1/namespaces/${encodeURIComponent(namespaceId)}`, {
        method: "PATCH",
        headers: { "x-organization-id": organizationId },
        body: JSON.stringify({ defaultTransferMode: originalTransferMode }),
      }).catch(() => undefined);
    }
  }
}

try {
  await run();
} catch (error) {
  console.error(`API proxy capacity test failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

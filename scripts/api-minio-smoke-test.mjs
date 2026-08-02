import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(scriptDirectory, "../.local/secrets/e2e-test.json");
const requestTimeoutMs = 20_000;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readConfig() {
  const fileStats = await stat(configPath).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new Error(`E2E config missing at ${configPath}; create the local file from project-docs/provider-contract-test.md`);
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
    providerId: typeof parsed.providerId === "string" ? parsed.providerId : undefined,
  };
}

function assertStatus(response, expected, label) {
  if (response.status !== expected) throw new Error(`${label} returned HTTP ${response.status}`);
}

async function fetchWithTimeout(url, init = {}) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(requestTimeoutMs) });
}

async function readBody(response) {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

async function run() {
  const config = await readConfig();
  const origin = new URL(config.apiBaseUrl).origin.replace(":4000", ":3000");
  let accessToken;
  let organizationId = config.organizationId;
  let namespaceId = config.namespaceId;
  let namespaceSlug;
  let credentialId;
  let grantId;
  let storageCredential;
  let objectKey;
  let proxyObjectKey;
  let originalTransferMode = "DIRECT";

  async function control(path, init = {}, scoped = false) {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${accessToken}`);
    if (scoped && organizationId) headers.set("x-organization-id", organizationId);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    return fetchWithTimeout(`${config.apiBaseUrl}${path}`, { ...init, headers });
  }

  async function storage(path, init = {}) {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${storageCredential}`);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    return fetchWithTimeout(`${config.apiBaseUrl}${path}`, { ...init, headers });
  }

  const loginResponse = await fetchWithTimeout(`${config.apiBaseUrl}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email: config.adminEmail, password: config.adminPassword }),
  });
  const login = await readBody(loginResponse);
  assertStatus(loginResponse, 200, "login");
  accessToken = login.accessToken;

  const settingsResponse = await control("/v1/platform/settings");
  assertStatus(settingsResponse, 200, "platform settings");
  const organizationsResponse = await control("/v1/platform/organizations");
  assertStatus(organizationsResponse, 200, "platform organizations");
  const organizations = await readBody(organizationsResponse);
  if (!organizationId) organizationId = organizations.organizations[0]?.id;
  if (!organizationId) throw new Error("No organization available for E2E test");

  const providersResponse = await control("/v1/providers", { headers: { "x-organization-id": organizationId } });
  assertStatus(providersResponse, 200, "provider list");
  const providers = await readBody(providersResponse);
  const provider = providers.providers.find((item) => item.id === config.providerId) ?? providers.providers[0];
  if (!provider) throw new Error("No provider available for E2E test");
  const providerTestResponse = await control(`/v1/providers/${encodeURIComponent(provider.id)}/test`, {
    method: "POST",
    headers: { "x-organization-id": organizationId },
    body: JSON.stringify({}),
  });
  assertStatus(providerTestResponse, 200, "provider health test");

  const namespacesResponse = await control("/v1/namespaces", { headers: { "x-organization-id": organizationId } });
  assertStatus(namespacesResponse, 200, "namespace list");
  const namespaces = await readBody(namespacesResponse);
  const namespace = namespaces.namespaces.find((item) => item.id === namespaceId) ?? namespaces.namespaces[0];
  if (!namespace) throw new Error("No namespace available; create one from Global Admin first");
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
    const createdCredential = await readBody(credentialResponse);
    credentialId = createdCredential.credential.id;
    storageCredential = `${createdCredential.credential.keyId}.${createdCredential.secret}`;

    const prefix = `e2e/${randomUUID()}`;
    const grantResponse = await control("/v1/folder-grants", {
      method: "POST",
      headers: { "x-organization-id": organizationId },
      body: JSON.stringify({ namespaceId, principalType: "API_CREDENTIAL", principalId: credentialId, prefix, actions: ["list", "read", "write", "delete"] }),
    });
    assertStatus(grantResponse, 201, "folder grant create");
    grantId = (await readBody(grantResponse)).grant.id;

    objectKey = `${prefix}/smoke.txt`;
    const payload = Buffer.from("mosp api minio smoke test\n", "utf8");
    const initiateResponse = await storage(`/storage/v1/${namespaceSlug}/uploads`, {
      method: "POST",
      body: JSON.stringify({ key: objectKey, sizeBytes: String(payload.length), contentType: "text/plain", idempotencyKey: randomUUID(), overwrite: false }),
    });
    assertStatus(initiateResponse, 201, "upload initiate");
    const upload = await readBody(initiateResponse);
    if (upload.transferMode !== "DIRECT" || typeof upload.url !== "string") throw new Error("Smoke test requires a direct presigned upload");
    const putResponse = await fetchWithTimeout(upload.url, { method: "PUT", headers: upload.headers ?? {}, body: payload });
    assertStatus(putResponse, 200, "presigned upload");

    const completeResponse = await storage(`/storage/v1/uploads/${encodeURIComponent(upload.uploadId)}/complete`, { method: "POST", body: JSON.stringify({}) });
    assertStatus(completeResponse, 200, "upload complete");
    const listResponse = await storage(`/storage/v1/${namespaceSlug}/objects?prefix=${encodeURIComponent(prefix)}`);
    assertStatus(listResponse, 200, "object list");
    const listed = await readBody(listResponse);
    if (!listed.objects.some((item) => item.key === objectKey)) throw new Error("Uploaded object missing from list");

    const headResponse = await storage(`/storage/v1/${namespaceSlug}/objects/${objectKey}`, { method: "HEAD" });
    assertStatus(headResponse, 200, "object head");
    if (headResponse.headers.get("content-length") !== String(payload.length)) throw new Error("HEAD content length mismatch");

    const downloadResponse = await storage(`/storage/v1/${namespaceSlug}/objects/${objectKey}`, { redirect: "manual" });
    assertStatus(downloadResponse, 302, "download redirect");
    const downloadUrl = downloadResponse.headers.get("location");
    if (!downloadUrl) throw new Error("Download redirect did not include a location");
    const downloadedResponse = await fetchWithTimeout(downloadUrl);
    assertStatus(downloadedResponse, 200, "presigned download");
    const downloaded = Buffer.from(await downloadedResponse.arrayBuffer());
    if (!downloaded.equals(payload)) throw new Error("Downloaded payload mismatch");

    const deleteResponse = await storage(`/storage/v1/${namespaceSlug}/objects/${objectKey}`, { method: "DELETE" });
    assertStatus(deleteResponse, 204, "object delete");

    const proxyModeResponse = await control(`/v1/namespaces/${encodeURIComponent(namespaceId)}`, {
      method: "PATCH",
      headers: { "x-organization-id": organizationId },
      body: JSON.stringify({ defaultTransferMode: "PROXIED" }),
    });
    assertStatus(proxyModeResponse, 200, "enable proxied transfer mode");
    proxyObjectKey = `${prefix}/proxy.txt`;
    const proxyInitiateResponse = await storage(`/storage/v1/${namespaceSlug}/uploads`, {
      method: "POST",
      body: JSON.stringify({ key: proxyObjectKey, sizeBytes: String(payload.length), contentType: "text/plain", idempotencyKey: randomUUID(), overwrite: false }),
    });
    assertStatus(proxyInitiateResponse, 201, "proxied upload initiate");
    const proxyUpload = await readBody(proxyInitiateResponse);
    if (proxyUpload.transferMode !== "PROXIED" || proxyUpload.url !== undefined) throw new Error("Proxied upload must not expose a provider URL");
    const proxyPutResponse = await storage(`/storage/v1/uploads/${encodeURIComponent(proxyUpload.uploadId)}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: payload,
    });
    assertStatus(proxyPutResponse, 200, "proxied upload");
    const proxyDownloadedResponse = await storage(`/storage/v1/${namespaceSlug}/objects/${proxyObjectKey}`);
    assertStatus(proxyDownloadedResponse, 200, "proxied download");
    const proxyDownloaded = Buffer.from(await proxyDownloadedResponse.arrayBuffer());
    if (!proxyDownloaded.equals(payload)) throw new Error("Proxied downloaded payload mismatch");
    const proxyDeleteResponse = await storage(`/storage/v1/${namespaceSlug}/objects/${proxyObjectKey}`, { method: "DELETE" });
    assertStatus(proxyDeleteResponse, 204, "proxied object delete");

    const revokeResponse = await control(`/v1/api-credentials/${encodeURIComponent(credentialId)}/revoke`, { method: "POST", headers: { "x-organization-id": organizationId }, body: JSON.stringify({}) });
    assertStatus(revokeResponse, 200, "credential revoke");
    const rejectedResponse = await storage(`/storage/v1/${namespaceSlug}/objects?prefix=${encodeURIComponent(prefix)}`);
    assertStatus(rejectedResponse, 401, "revoked credential rejection");

    console.log(JSON.stringify({ organizationId, namespaceId, namespaceSlug, apiSmoke: "passed", proxySmoke: "passed", revokeNegativeTest: "passed" }, null, 2));
  } finally {
    if (grantId) await control(`/v1/folder-grants/${encodeURIComponent(grantId)}`, { method: "DELETE", headers: { "x-organization-id": organizationId } }).catch(() => undefined);
    if (credentialId) await control(`/v1/api-credentials/${encodeURIComponent(credentialId)}/revoke`, { method: "POST", headers: { "x-organization-id": organizationId }, body: JSON.stringify({}) }).catch(() => undefined);
    if (objectKey && storageCredential) await storage(`/storage/v1/${namespaceSlug}/objects/${objectKey}`, { method: "DELETE" }).catch(() => undefined);
    if (proxyObjectKey && storageCredential) await storage(`/storage/v1/${namespaceSlug}/objects/${proxyObjectKey}`, { method: "DELETE" }).catch(() => undefined);
    if (namespaceId && organizationId && originalTransferMode !== "PROXIED") {
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
  console.error(`API MinIO smoke test failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const openApiPath = resolve(scriptDirectory, "../project-docs/openapi.yaml");

// Keep this inventory close to the API route prefixes. It is intentionally
// static: the check catches a deleted or renamed documented path without
// introducing a YAML parser dependency into the application.
const expectedPaths = [
  "/healthz",
  "/readyz",
  "/metrics",
  "/v1/auth/login",
  "/v1/auth/refresh",
  "/v1/auth/logout",
  "/v1/auth/session",
  "/v1/organizations/{organizationId}",
  "/v1/organizations/{organizationId}/activity-logs",
  "/v1/organizations/{organizationId}/usage",
  "/v1/organizations/{organizationId}/usage/export",
  "/v1/organizations/{organizationId}/members",
  "/v1/organizations/{organizationId}/members/{membershipId}",
  "/v1/organizations/{organizationId}/members/{membershipId}/roles",
  "/v1/organizations/{organizationId}/roles",
  "/v1/organizations/{organizationId}/roles/{roleId}",
  "/v1/providers",
  "/v1/providers/{providerId}",
  "/v1/providers/{providerId}/test",
  "/v1/providers/{providerId}/buckets",
  "/v1/buckets",
  "/v1/buckets/import",
  "/v1/buckets/{bucketId}",
  "/v1/buckets/{bucketId}/objects",
  "/v1/namespaces",
  "/v1/namespaces/{namespaceId}",
  "/v1/namespaces/{namespaceId}/targets",
  "/v1/namespaces/{namespaceId}/placement-policy",
  "/v1/api-credentials",
  "/v1/api-credentials/{credentialId}/rotate",
  "/v1/api-credentials/{credentialId}/revoke",
  "/v1/folder-grants",
  "/v1/folder-grants/{grantId}",
  "/v1/migrations",
  "/v1/migrations/{migrationId}",
  "/v1/migrations/{migrationId}/control",
  "/v1/platform/organizations",
  "/v1/platform/settings",
  "/v1/object-explorer/namespaces",
  "/v1/object-explorer/{namespace}/objects",
  "/v1/object-explorer/{namespace}/folders",
  "/v1/object-explorer/{namespace}/download/{key}",
  "/v1/object-explorer/{namespace}/objects/{key}",
  "/storage/v1/{namespace}/objects",
  "/storage/v1/{namespace}/objects/{key}",
  "/storage/v1/{namespace}/uploads",
  "/storage/v1/uploads/{uploadId}/complete",
  "/storage/v1/uploads/{uploadId}/parts/{partNumber}",
  "/storage/v1/uploads/{uploadId}",
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pathExists(document, path) {
  return new RegExp(`^  ${escapeRegExp(path)}:$`, "m").test(document);
}

const document = await readFile(openApiPath, "utf8");
if (!/^openapi:\s+3\.1\.0$/m.test(document)) {
  throw new Error("OpenAPI document must declare version 3.1.0");
}

const documentedPaths = [...document.matchAll(/^  (\/[^:]+):$/gm)].map(
  ([, path]) => path,
);
const duplicatePaths = documentedPaths.filter(
  (path, index) => documentedPaths.indexOf(path) !== index,
);
if (duplicatePaths.length > 0) {
  throw new Error(`Duplicate OpenAPI paths: ${[...new Set(duplicatePaths)].join(", ")}`);
}

const missingPaths = expectedPaths.filter((path) => !pathExists(document, path));
if (missingPaths.length > 0) {
  throw new Error(`OpenAPI paths missing from the route contract: ${missingPaths.join(", ")}`);
}

const expectedPathSet = new Set(expectedPaths);
const undocumentedPaths = documentedPaths.filter((path) => !expectedPathSet.has(path));
if (undocumentedPaths.length > 0) {
  throw new Error(`OpenAPI contains paths absent from the route inventory: ${undocumentedPaths.join(", ")}`);
}

const componentRefs = [
  ...document.matchAll(/#\/components\/(schemas|parameters|responses)\/([A-Za-z0-9_-]+)/g),
];
for (const [, kind, name] of componentRefs) {
  const definition = new RegExp(`^    ${escapeRegExp(name)}:`, "m");
  if (!definition.test(document)) {
    throw new Error(`OpenAPI component reference is unresolved: ${kind}/${name}`);
  }
}

console.log(`OpenAPI route contract passed: ${documentedPaths.length} paths, ${new Set(componentRefs.map(([, kind, name]) => `${kind}/${name}`)).size} component references.`);

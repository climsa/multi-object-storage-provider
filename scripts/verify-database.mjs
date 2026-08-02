import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const databaseUrlFile = resolve(
  scriptDirectory,
  "../.local/secrets/database-url",
);
const connectionString = (await readFile(databaseUrlFile, "utf8")).trim();
const client = new pg.Client({ connectionString });

await client.connect();

try {
  await client.query("BEGIN");

  const requiredTables = await client.query(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])`,
    [[
      "VirtualNamespace",
      "PlacementPolicy",
      "PlacementTarget",
      "ApiCredential",
      "FolderGrant",
      "ObjectRecord",
      "ObjectLocation",
      "UsageCounter",
      "UploadSession",
      "MultipartPart",
      "PlatformSetting",
    ]],
  );
  const requiredTableNames = new Set(
    requiredTables.rows.map((row) => row.table_name),
  );
  for (const tableName of [
    "VirtualNamespace",
    "PlacementPolicy",
    "PlacementTarget",
    "ApiCredential",
    "PlatformSetting",
  ]) {
    if (!requiredTableNames.has(tableName)) {
      throw new Error(`Required database table is missing: ${tableName}`);
    }
  }

  const platformSettingColumns = await client.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'PlatformSetting'
        AND column_name = ANY($1::text[])`,
    [["key", "value", "version", "updatedById"]],
  );
  if (platformSettingColumns.rowCount !== 4) {
    throw new Error("Platform setting columns are incomplete");
  }

  const usageColumns = await client.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'UsageCounter'
        AND column_name = ANY($1::text[])`,
    [["requestCount", "ingressBytes", "egressBytes"]],
  );
  if (usageColumns.rowCount !== 3) {
    throw new Error("UsageCounter metering columns are incomplete");
  }

  const uploadTransferModes = await client.query(
    `SELECT enumlabel
       FROM pg_enum
      WHERE enumtypid = '"UploadTransferMode"'::regtype
      ORDER BY enumsortorder`,
  );
  if (!uploadTransferModes.rows.some((row) => row.enumlabel === "PROXIED")) {
    throw new Error("UploadTransferMode.PROXIED is missing");
  }

  const migrationFingerprintColumns = await client.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'MigrationItem'
        AND column_name = ANY($1::text[])`,
    [["sourceEtag", "sourceLastModified"]],
  );
  if (migrationFingerprintColumns.rowCount !== 2) {
    throw new Error("Migration source fingerprint columns are incomplete");
  }

  const requiredPlacementConstraints = await client.query(
    `SELECT conname
       FROM pg_constraint
      WHERE conrelid IN (
        '"VirtualNamespace"'::regclass,
        '"PlacementTarget"'::regclass,
        '"FolderGrant"'::regclass,
        '"ObjectRecord"'::regclass,
        '"ObjectLocation"'::regclass,
        '"UsageCounter"'::regclass,
        '"UploadSession"'::regclass,
        '"MultipartPart"'::regclass
      )
        AND conname = ANY($1::text[])`,
    [[
      "VirtualNamespace_quotaBytes_nonnegative_check",
      "VirtualNamespace_maxObjectSizeBytes_nonnegative_check",
      "PlacementTarget_priorityTier_nonnegative_check",
      "PlacementTarget_weight_positive_check",
      "PlacementTarget_configuredCapacityBytes_nonnegative_check",
      "PlacementTarget_thresholdPercent_range_check",
      "FolderGrant_actions_allowed_check",
      "ObjectRecord_logicalKey_nonempty_check",
      "ObjectRecord_sizeBytes_nonnegative_check",
      "ObjectLocation_physicalKey_nonempty_check",
      "ObjectLocation_active_requires_verification_check",
      "ObjectLocation_objectRecordId_organizationId_fkey",
      "UsageCounter_nonnegative_check",
      "UsageCounter_egressBytes_nonnegative_check",
      "UploadSession_nonempty_check",
      "MultipartPart_values_check",
    ]],
  );
  if (requiredPlacementConstraints.rowCount !== 16) {
    throw new Error("Placement value constraints are incomplete");
  }

  const firstOrganizationId = "10000000-0000-4000-8000-000000000001";
  const secondOrganizationId = "10000000-0000-4000-8000-000000000002";
  const userId = "20000000-0000-4000-8000-000000000001";
  const membershipId = "30000000-0000-4000-8000-000000000001";
  const firstRoleId = "40000000-0000-4000-8000-000000000001";
  const secondRoleId = "40000000-0000-4000-8000-000000000002";
  const globalRoleId = "40000000-0000-4000-8000-000000000003";
  const firstNamespaceId = "50000000-0000-4000-8000-000000000001";
  const secondNamespaceId = "50000000-0000-4000-8000-000000000002";
  const credentialId = "60000000-0000-4000-8000-000000000001";
  const grantId = "70000000-0000-4000-8000-000000000001";
  const objectRecordId = "80000000-0000-4000-8000-000000000001";

  await client.query(
    `INSERT INTO "Organization" (id, name, slug, "updatedAt")
     VALUES ($1, 'First organization', 'database-test-first', now()),
            ($2, 'Second organization', 'database-test-second', now())`,
    [firstOrganizationId, secondOrganizationId],
  );
  await client.query(
    `INSERT INTO "User" (id, email, "passwordHash", "updatedAt")
     VALUES ($1, 'database-test@example.invalid', 'not-a-real-password-hash', now())`,
    [userId],
  );
  await client.query(
    `INSERT INTO "Membership" (id, "userId", "organizationId", status, "updatedAt")
     VALUES ($1, $2, $3, 'ACTIVE', now())`,
    [membershipId, userId, firstOrganizationId],
  );
  await client.query(
    `INSERT INTO "Role" (id, "organizationId", name, scope, "updatedAt")
     VALUES ($1, $2, 'First storage admin', 'ORGANIZATION', now()),
            ($3, $4, 'Second storage admin', 'ORGANIZATION', now()),
            ($5, NULL, 'Platform admin', 'GLOBAL', now())`,
    [
      firstRoleId,
      firstOrganizationId,
      secondRoleId,
      secondOrganizationId,
      globalRoleId,
    ],
  );
  await client.query(
    `INSERT INTO "MemberRole" ("membershipId", "roleId", "organizationId")
     VALUES ($1, $2, $3)`,
    [membershipId, firstRoleId, firstOrganizationId],
  );
  await client.query(
    `INSERT INTO "VirtualNamespace" (id, "organizationId", name, slug, "quotaBytes", "updatedAt")
     VALUES ($1, $2, 'First namespace', 'database-test-first', 1000, now()),
            ($3, $4, 'Second namespace', 'database-test-second', 1000, now())`,
    [firstNamespaceId, firstOrganizationId, secondNamespaceId, secondOrganizationId],
  );

  await client.query("SAVEPOINT cross_tenant_credential");

  let crossTenantCredentialRejected = false;
  try {
    await client.query(
      `INSERT INTO "ApiCredential" (id, "organizationId", "namespaceId", "keyId", "secretHash", "createdById", "updatedAt")
       VALUES ($1, $2, $3, 'database-test-key', repeat('a', 64), $4, now())`,
      [credentialId, firstOrganizationId, secondNamespaceId, userId],
    );
  } catch (error) {
    crossTenantCredentialRejected = error?.code === "23503";
    await client.query("ROLLBACK TO SAVEPOINT cross_tenant_credential");
  }

  if (!crossTenantCredentialRejected) {
    throw new Error("Cross-tenant API credential assignment was not rejected");
  }

  await client.query("SAVEPOINT cross_tenant_folder_grant");

  let crossTenantFolderGrantRejected = false;
  try {
    await client.query(
      `INSERT INTO "FolderGrant" (id, "organizationId", "namespaceId", "principalType", "principalId", prefix, actions, "createdById", "updatedAt")
       VALUES ($1, $2, $3, 'ROLE', $4, 'photos', ARRAY['read']::varchar[], $5, now())`,
      [grantId, firstOrganizationId, secondNamespaceId, firstRoleId, userId],
    );
  } catch (error) {
    crossTenantFolderGrantRejected = error?.code === "23503";
    await client.query("ROLLBACK TO SAVEPOINT cross_tenant_folder_grant");
  }

  if (!crossTenantFolderGrantRejected) {
    throw new Error("Cross-tenant folder grant assignment was not rejected");
  }

  await client.query("SAVEPOINT cross_tenant_object_record");

  let crossTenantObjectRejected = false;
  try {
    await client.query(
      `INSERT INTO "ObjectRecord" (id, "organizationId", "namespaceId", "logicalKey", "sizeBytes", "modifiedAt")
       VALUES ($1, $2, $3, 'photos/image.jpg', 1, now())`,
      [objectRecordId, firstOrganizationId, secondNamespaceId],
    );
  } catch (error) {
    crossTenantObjectRejected = error?.code === "23503";
    await client.query("ROLLBACK TO SAVEPOINT cross_tenant_object_record");
  }

  if (!crossTenantObjectRejected) {
    throw new Error("Cross-tenant object record assignment was not rejected");
  }

  await client.query("SAVEPOINT cross_tenant_assignment");

  let crossTenantAssignmentRejected = false;
  try {
    await client.query(
      `INSERT INTO "MemberRole" ("membershipId", "roleId", "organizationId")
       VALUES ($1, $2, $3)`,
      [membershipId, secondRoleId, firstOrganizationId],
    );
  } catch (error) {
    crossTenantAssignmentRejected = error?.code === "23503";
    await client.query("ROLLBACK TO SAVEPOINT cross_tenant_assignment");
  }

  if (!crossTenantAssignmentRejected) {
    throw new Error("Cross-tenant role assignment was not rejected");
  }

  await client.query("SAVEPOINT organization_role_as_global");

  let organizationRoleAsGlobalRejected = false;
  try {
    await client.query(
      `INSERT INTO "UserRole" ("userId", "roleId") VALUES ($1, $2)`,
      [userId, firstRoleId],
    );
  } catch (error) {
    organizationRoleAsGlobalRejected = error?.code === "23503";
    await client.query("ROLLBACK TO SAVEPOINT organization_role_as_global");
  }

  if (!organizationRoleAsGlobalRejected) {
    throw new Error("Organization role was accepted as a global user role");
  }

  const plaintextCredentialColumns = await client.query(
    `SELECT "column_name"
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'ProviderCredential'
        AND "column_name" IN ('accessKeyId', 'secretAccessKey', 'sessionToken')`,
  );

  if (plaintextCredentialColumns.rowCount !== 0) {
    throw new Error("ProviderCredential contains a plaintext credential column");
  }

  const plaintextApiCredentialColumns = await client.query(
    `SELECT "column_name"
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'ApiCredential'
        AND "column_name" IN ('secret', 'secretValue', 'plaintextSecret')`,
  );

  if (plaintextApiCredentialColumns.rowCount !== 0) {
    throw new Error("ApiCredential contains a plaintext secret column");
  }

  const activityLog = await client.query(
    `INSERT INTO "ActivityLog" (action, "entityType", "requestId")
     VALUES ('database.verify', 'Database', 'database-verification')
     RETURNING id`,
  );
  await client.query("SAVEPOINT mutate_activity_log");

  let activityLogMutationRejected = false;
  try {
    await client.query(
      `UPDATE "ActivityLog" SET action = 'database.tampered' WHERE id = $1`,
      [activityLog.rows[0].id],
    );
  } catch (error) {
    activityLogMutationRejected = error?.code === "55000";
    await client.query("ROLLBACK TO SAVEPOINT mutate_activity_log");
  }

  if (!activityLogMutationRejected) {
    throw new Error("ActivityLog update was not rejected");
  }

  await client.query("ROLLBACK");
  console.log(
    "Database verification passed: placement/API credential/folder-grant/object/multipart tenant boundaries, tenant/global role boundaries, append-only audit log, and encrypted credential schema.",
  );
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}

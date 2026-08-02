CREATE TYPE "MigrationRunState" AS ENUM ('CREATED', 'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED');
CREATE TYPE "MigrationItemState" AS ENUM ('PENDING', 'COPYING', 'COMPLETED', 'SKIPPED', 'FAILED');

CREATE TABLE "MigrationRun" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "namespaceId" UUID NOT NULL,
    "sourceBucketConnectionId" UUID NOT NULL,
    "targetBucketConnectionId" UUID NOT NULL,
    "initiatedById" UUID NOT NULL,
    "state" "MigrationRunState" NOT NULL DEFAULT 'CREATED',
    "totalItems" INTEGER NOT NULL DEFAULT 0,
    "completedItems" INTEGER NOT NULL DEFAULT 0,
    "failedItems" INTEGER NOT NULL DEFAULT 0,
    "lastError" VARCHAR(1000),
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "MigrationRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MigrationItem" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "migrationRunId" UUID NOT NULL,
    "objectRecordId" UUID NOT NULL,
    "sourceLocationId" UUID NOT NULL,
    "sourceBucketConnectionId" UUID NOT NULL,
    "targetBucketConnectionId" UUID NOT NULL,
    "sourcePhysicalKey" VARCHAR(2048) NOT NULL,
    "targetPhysicalKey" VARCHAR(2048) NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "checksum" VARCHAR(255),
    "state" "MigrationItemState" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" VARCHAR(1000),
    "nextAttemptAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "MigrationItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MigrationRun_organizationId_namespaceId_state_createdAt_idx" ON "MigrationRun"("organizationId", "namespaceId", "state", "createdAt");
CREATE UNIQUE INDEX "MigrationRun_id_organizationId_key" ON "MigrationRun"("id", "organizationId");
CREATE INDEX "MigrationItem_organizationId_migrationRunId_state_nextAttem_idx" ON "MigrationItem"("organizationId", "migrationRunId", "state", "nextAttemptAt");
CREATE UNIQUE INDEX "MigrationItem_migrationRunId_objectRecordId_key" ON "MigrationItem"("migrationRunId", "objectRecordId");
CREATE UNIQUE INDEX "MigrationItem_id_organizationId_key" ON "MigrationItem"("id", "organizationId");

ALTER TABLE "MigrationRun" ADD CONSTRAINT "MigrationRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MigrationRun" ADD CONSTRAINT "MigrationRun_namespaceId_organizationId_fkey" FOREIGN KEY ("namespaceId", "organizationId") REFERENCES "VirtualNamespace"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MigrationRun" ADD CONSTRAINT "MigrationRun_sourceBucketConnectionId_organizationId_fkey" FOREIGN KEY ("sourceBucketConnectionId", "organizationId") REFERENCES "BucketConnection"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MigrationRun" ADD CONSTRAINT "MigrationRun_targetBucketConnectionId_organizationId_fkey" FOREIGN KEY ("targetBucketConnectionId", "organizationId") REFERENCES "BucketConnection"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MigrationRun" ADD CONSTRAINT "MigrationRun_initiatedById_fkey" FOREIGN KEY ("initiatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MigrationItem" ADD CONSTRAINT "MigrationItem_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MigrationItem" ADD CONSTRAINT "MigrationItem_migrationRunId_organizationId_fkey" FOREIGN KEY ("migrationRunId", "organizationId") REFERENCES "MigrationRun"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MigrationItem" ADD CONSTRAINT "MigrationItem_objectRecordId_organizationId_fkey" FOREIGN KEY ("objectRecordId", "organizationId") REFERENCES "ObjectRecord"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

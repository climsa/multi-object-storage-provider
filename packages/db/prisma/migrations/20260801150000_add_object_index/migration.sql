-- CreateEnum
CREATE TYPE "ObjectRecordState" AS ENUM ('PENDING', 'AVAILABLE', 'DELETING', 'DELETED');

-- CreateEnum
CREATE TYPE "ObjectLocationState" AS ENUM ('CANDIDATE', 'ACTIVE', 'RETAINED', 'DELETED');

-- CreateTable
CREATE TABLE "ObjectRecord" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "namespaceId" UUID NOT NULL,
    "logicalKey" VARCHAR(2048) NOT NULL,
    "activeObjectLocationId" UUID,
    "state" "ObjectRecordState" NOT NULL DEFAULT 'PENDING',
    "sizeBytes" BIGINT NOT NULL,
    "contentType" VARCHAR(255),
    "checksum" VARCHAR(255),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "modifiedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ObjectRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ObjectLocation" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "objectRecordId" UUID NOT NULL,
    "bucketConnectionId" UUID NOT NULL,
    "physicalKey" VARCHAR(2048) NOT NULL,
    "state" "ObjectLocationState" NOT NULL DEFAULT 'CANDIDATE',
    "etag" VARCHAR(255),
    "providerVersionId" VARCHAR(255),
    "providerLastModified" TIMESTAMPTZ(3),
    "storageClass" VARCHAR(100),
    "encryptionMetadata" JSONB,
    "verifiedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ObjectLocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ObjectRecord_organizationId_namespaceId_state_modifiedAt_idx" ON "ObjectRecord"("organizationId", "namespaceId", "state", "modifiedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ObjectRecord_namespaceId_logicalKey_key" ON "ObjectRecord"("namespaceId", "logicalKey");

-- CreateIndex
CREATE UNIQUE INDEX "ObjectRecord_id_organizationId_key" ON "ObjectRecord"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "ObjectRecord_activeObjectLocationId_key" ON "ObjectRecord"("activeObjectLocationId");

-- CreateIndex
CREATE INDEX "ObjectLocation_organizationId_objectRecordId_state_idx" ON "ObjectLocation"("organizationId", "objectRecordId", "state");

-- CreateIndex
CREATE INDEX "ObjectLocation_organizationId_bucketConnectionId_state_idx" ON "ObjectLocation"("organizationId", "bucketConnectionId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "ObjectLocation_id_organizationId_key" ON "ObjectLocation"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "ObjectLocation_objectRecordId_bucketConnectionId_physicalKe_key" ON "ObjectLocation"("objectRecordId", "bucketConnectionId", "physicalKey");

-- AddForeignKey
ALTER TABLE "ObjectRecord" ADD CONSTRAINT "ObjectRecord_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObjectRecord" ADD CONSTRAINT "ObjectRecord_namespaceId_organizationId_fkey" FOREIGN KEY ("namespaceId", "organizationId") REFERENCES "VirtualNamespace"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObjectRecord" ADD CONSTRAINT "ObjectRecord_activeObjectLocationId_fkey" FOREIGN KEY ("activeObjectLocationId") REFERENCES "ObjectLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObjectLocation" ADD CONSTRAINT "ObjectLocation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObjectLocation" ADD CONSTRAINT "ObjectLocation_objectRecordId_fkey" FOREIGN KEY ("objectRecordId") REFERENCES "ObjectRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObjectLocation" ADD CONSTRAINT "ObjectLocation_bucketConnectionId_organizationId_fkey" FOREIGN KEY ("bucketConnectionId", "organizationId") REFERENCES "BucketConnection"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Keep object index invariants at the database boundary.
ALTER TABLE "ObjectRecord"
  ADD CONSTRAINT "ObjectRecord_logicalKey_nonempty_check" CHECK (length("logicalKey") > 0),
  ADD CONSTRAINT "ObjectRecord_sizeBytes_nonnegative_check" CHECK ("sizeBytes" >= 0);

ALTER TABLE "ObjectLocation"
  ADD CONSTRAINT "ObjectLocation_physicalKey_nonempty_check" CHECK (length("physicalKey") > 0),
  ADD CONSTRAINT "ObjectLocation_active_requires_verification_check" CHECK ("state" <> 'ACTIVE' OR "verifiedAt" IS NOT NULL);

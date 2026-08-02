-- CreateEnum
CREATE TYPE "NamespaceStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "NamespaceTransferMode" AS ENUM ('DIRECT', 'PROXIED');

-- CreateEnum
CREATE TYPE "NamespaceVersioningMode" AS ENUM ('DISABLED');

-- CreateEnum
CREATE TYPE "PlacementPolicyStrategy" AS ENUM ('PRIORITY_WEIGHTED');

-- CreateEnum
CREATE TYPE "PlacementPolicyStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateTable
CREATE TABLE "VirtualNamespace" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "status" "NamespaceStatus" NOT NULL DEFAULT 'ACTIVE',
    "quotaBytes" BIGINT NOT NULL,
    "maxObjectSizeBytes" BIGINT,
    "defaultTransferMode" "NamespaceTransferMode" NOT NULL DEFAULT 'DIRECT',
    "versioningMode" "NamespaceVersioningMode" NOT NULL DEFAULT 'DISABLED',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "VirtualNamespace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlacementPolicy" (
    "id" UUID NOT NULL,
    "namespaceId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "strategy" "PlacementPolicyStrategy" NOT NULL DEFAULT 'PRIORITY_WEIGHTED',
    "status" "PlacementPolicyStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PlacementPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlacementTarget" (
    "id" UUID NOT NULL,
    "policyId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "bucketConnectionId" UUID NOT NULL,
    "priorityTier" INTEGER NOT NULL DEFAULT 0,
    "weight" INTEGER NOT NULL DEFAULT 100,
    "configuredCapacityBytes" BIGINT,
    "thresholdPercent" INTEGER NOT NULL DEFAULT 100,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PlacementTarget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VirtualNamespace_organizationId_status_idx" ON "VirtualNamespace"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "VirtualNamespace_organizationId_slug_key" ON "VirtualNamespace"("organizationId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "VirtualNamespace_id_organizationId_key" ON "VirtualNamespace"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "PlacementPolicy_namespaceId_key" ON "PlacementPolicy"("namespaceId");

-- CreateIndex
CREATE INDEX "PlacementPolicy_organizationId_status_idx" ON "PlacementPolicy"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PlacementPolicy_id_organizationId_key" ON "PlacementPolicy"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "PlacementPolicy_namespaceId_organizationId_key" ON "PlacementPolicy"("namespaceId", "organizationId");

-- CreateIndex
CREATE INDEX "PlacementTarget_organizationId_policyId_priorityTier_enable_idx" ON "PlacementTarget"("organizationId", "policyId", "priorityTier", "enabled");

-- CreateIndex
CREATE INDEX "PlacementTarget_organizationId_bucketConnectionId_idx" ON "PlacementTarget"("organizationId", "bucketConnectionId");

-- CreateIndex
CREATE UNIQUE INDEX "PlacementTarget_policyId_bucketConnectionId_key" ON "PlacementTarget"("policyId", "bucketConnectionId");

-- CreateIndex
CREATE UNIQUE INDEX "PlacementTarget_id_organizationId_key" ON "PlacementTarget"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "BucketConnection_id_organizationId_key" ON "BucketConnection"("id", "organizationId");

-- AddForeignKey
ALTER TABLE "VirtualNamespace" ADD CONSTRAINT "VirtualNamespace_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlacementPolicy" ADD CONSTRAINT "PlacementPolicy_namespaceId_organizationId_fkey" FOREIGN KEY ("namespaceId", "organizationId") REFERENCES "VirtualNamespace"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlacementTarget" ADD CONSTRAINT "PlacementTarget_policyId_organizationId_fkey" FOREIGN KEY ("policyId", "organizationId") REFERENCES "PlacementPolicy"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlacementTarget" ADD CONSTRAINT "PlacementTarget_bucketConnectionId_organizationId_fkey" FOREIGN KEY ("bucketConnectionId", "organizationId") REFERENCES "BucketConnection"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Keep capacity and placement values meaningful at the database boundary.
ALTER TABLE "VirtualNamespace"
  ADD CONSTRAINT "VirtualNamespace_quotaBytes_nonnegative_check" CHECK ("quotaBytes" >= 0),
  ADD CONSTRAINT "VirtualNamespace_maxObjectSizeBytes_nonnegative_check" CHECK ("maxObjectSizeBytes" IS NULL OR "maxObjectSizeBytes" >= 0);

ALTER TABLE "PlacementTarget"
  ADD CONSTRAINT "PlacementTarget_priorityTier_nonnegative_check" CHECK ("priorityTier" >= 0),
  ADD CONSTRAINT "PlacementTarget_weight_positive_check" CHECK ("weight" > 0),
  ADD CONSTRAINT "PlacementTarget_configuredCapacityBytes_nonnegative_check" CHECK ("configuredCapacityBytes" IS NULL OR "configuredCapacityBytes" >= 0),
  ADD CONSTRAINT "PlacementTarget_thresholdPercent_range_check" CHECK ("thresholdPercent" BETWEEN 0 AND 100);

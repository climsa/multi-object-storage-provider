-- CreateEnum
CREATE TYPE "ApiCredentialStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');

-- CreateTable
CREATE TABLE "ApiCredential" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "namespaceId" UUID NOT NULL,
    "keyId" VARCHAR(100) NOT NULL,
    "secretHash" VARCHAR(128) NOT NULL,
    "status" "ApiCredentialStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMPTZ(3),
    "lastUsedAt" TIMESTAMPTZ(3),
    "createdById" UUID NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ApiCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApiCredential_keyId_key" ON "ApiCredential"("keyId");

-- CreateIndex
CREATE INDEX "ApiCredential_organizationId_status_idx" ON "ApiCredential"("organizationId", "status");

-- CreateIndex
CREATE INDEX "ApiCredential_organizationId_namespaceId_status_idx" ON "ApiCredential"("organizationId", "namespaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ApiCredential_id_organizationId_key" ON "ApiCredential"("id", "organizationId");

-- AddForeignKey
ALTER TABLE "ApiCredential" ADD CONSTRAINT "ApiCredential_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiCredential" ADD CONSTRAINT "ApiCredential_namespaceId_organizationId_fkey" FOREIGN KEY ("namespaceId", "organizationId") REFERENCES "VirtualNamespace"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiCredential" ADD CONSTRAINT "ApiCredential_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

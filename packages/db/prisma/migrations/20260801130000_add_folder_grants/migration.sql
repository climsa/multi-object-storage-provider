-- CreateEnum
CREATE TYPE "FolderGrantPrincipalType" AS ENUM ('ROLE', 'API_CREDENTIAL');

-- CreateTable
CREATE TABLE "FolderGrant" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "namespaceId" UUID NOT NULL,
    "principalType" "FolderGrantPrincipalType" NOT NULL,
    "principalId" UUID NOT NULL,
    "prefix" VARCHAR(1024) NOT NULL,
    "actions" VARCHAR(16)[] NOT NULL,
    "expiresAt" TIMESTAMPTZ(3),
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "FolderGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FolderGrant_organizationId_namespaceId_principalType_princi_idx" ON "FolderGrant"("organizationId", "namespaceId", "principalType", "principalId");

-- CreateIndex
CREATE INDEX "FolderGrant_organizationId_expiresAt_idx" ON "FolderGrant"("organizationId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "FolderGrant_organizationId_namespaceId_principalType_princi_key" ON "FolderGrant"("organizationId", "namespaceId", "principalType", "principalId", "prefix");

-- AddForeignKey
ALTER TABLE "FolderGrant" ADD CONSTRAINT "FolderGrant_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FolderGrant" ADD CONSTRAINT "FolderGrant_namespaceId_organizationId_fkey" FOREIGN KEY ("namespaceId", "organizationId") REFERENCES "VirtualNamespace"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FolderGrant" ADD CONSTRAINT "FolderGrant_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Keep action values bounded at the database boundary.
ALTER TABLE "FolderGrant"
  ADD CONSTRAINT "FolderGrant_actions_allowed_check"
  CHECK (cardinality("actions") > 0 AND "actions" <@ ARRAY['list', 'read', 'write', 'delete']::varchar[]);

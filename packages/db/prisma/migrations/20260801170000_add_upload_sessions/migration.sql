CREATE TYPE "UploadSessionState" AS ENUM ('INITIATED', 'COMPLETING', 'COMPLETED', 'ABORTED', 'EXPIRED');

CREATE TABLE "UsageCounter" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "namespaceId" UUID NOT NULL,
    "usedBytes" BIGINT NOT NULL DEFAULT 0,
    "reservedBytes" BIGINT NOT NULL DEFAULT 0,
    "objectCount" BIGINT NOT NULL DEFAULT 0,
    "activeUploadCount" INTEGER NOT NULL DEFAULT 0,
    "requestCount" BIGINT NOT NULL DEFAULT 0,
    "ingressBytes" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "UsageCounter_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UsageCounter_organizationId_namespaceId_key"
    ON "UsageCounter"("organizationId", "namespaceId");
CREATE INDEX "UsageCounter_organizationId_namespaceId_idx"
    ON "UsageCounter"("organizationId", "namespaceId");

ALTER TABLE "UsageCounter"
    ADD CONSTRAINT "UsageCounter_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UsageCounter"
    ADD CONSTRAINT "UsageCounter_namespaceId_organizationId_fkey"
    FOREIGN KEY ("namespaceId", "organizationId") REFERENCES "VirtualNamespace"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UsageCounter"
    ADD CONSTRAINT "UsageCounter_nonnegative_check"
    CHECK ("usedBytes" >= 0 AND "reservedBytes" >= 0 AND "objectCount" >= 0 AND "activeUploadCount" >= 0 AND "requestCount" >= 0 AND "ingressBytes" >= 0);

CREATE TABLE "UploadSession" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "namespaceId" UUID NOT NULL,
    "placementTargetId" UUID NOT NULL,
    "bucketConnectionId" UUID NOT NULL,
    "createdByCredentialId" UUID NOT NULL,
    "idempotencyKey" VARCHAR(200) NOT NULL,
    "logicalKey" VARCHAR(2048) NOT NULL,
    "physicalKey" VARCHAR(2048) NOT NULL,
    "reservedBytes" BIGINT NOT NULL,
    "contentType" VARCHAR(255),
    "checksum" VARCHAR(255),
    "state" "UploadSessionState" NOT NULL DEFAULT 'INITIATED',
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "UploadSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UploadSession_organizationId_namespaceId_idempotencyKey_key"
    ON "UploadSession"("organizationId", "namespaceId", "idempotencyKey");
CREATE UNIQUE INDEX "UploadSession_id_organizationId_key"
    ON "UploadSession"("id", "organizationId");
CREATE INDEX "UploadSession_organizationId_namespaceId_state_expiresAt_idx"
    ON "UploadSession"("organizationId", "namespaceId", "state", "expiresAt");
CREATE INDEX "UploadSession_organizationId_bucketConnectionId_state_idx"
    ON "UploadSession"("organizationId", "bucketConnectionId", "state");

ALTER TABLE "UploadSession"
    ADD CONSTRAINT "UploadSession_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UploadSession"
    ADD CONSTRAINT "UploadSession_namespaceId_organizationId_fkey"
    FOREIGN KEY ("namespaceId", "organizationId") REFERENCES "VirtualNamespace"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UploadSession"
    ADD CONSTRAINT "UploadSession_placementTargetId_organizationId_fkey"
    FOREIGN KEY ("placementTargetId", "organizationId") REFERENCES "PlacementTarget"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UploadSession"
    ADD CONSTRAINT "UploadSession_bucketConnectionId_organizationId_fkey"
    FOREIGN KEY ("bucketConnectionId", "organizationId") REFERENCES "BucketConnection"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UploadSession"
    ADD CONSTRAINT "UploadSession_createdByCredentialId_organizationId_fkey"
    FOREIGN KEY ("createdByCredentialId", "organizationId") REFERENCES "ApiCredential"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UploadSession"
    ADD CONSTRAINT "UploadSession_nonempty_check"
    CHECK (length("idempotencyKey") > 0 AND length("logicalKey") > 0 AND length("physicalKey") > 0 AND "reservedBytes" >= 0);

CREATE TYPE "UploadTransferMode" AS ENUM ('DIRECT', 'MULTIPART');

ALTER TABLE "UploadSession"
    ADD COLUMN "transferMode" "UploadTransferMode" NOT NULL DEFAULT 'DIRECT',
    ADD COLUMN "providerUploadId" VARCHAR(255);

CREATE TABLE "MultipartPart" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "uploadSessionId" UUID NOT NULL,
    "partNumber" INTEGER NOT NULL,
    "etag" VARCHAR(255),
    "sizeBytes" BIGINT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "MultipartPart_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MultipartPart_uploadSessionId_partNumber_key"
    ON "MultipartPart"("uploadSessionId", "partNumber");
CREATE UNIQUE INDEX "MultipartPart_id_organizationId_key"
    ON "MultipartPart"("id", "organizationId");
CREATE INDEX "MultipartPart_organizationId_uploadSessionId_partNumber_idx"
    ON "MultipartPart"("organizationId", "uploadSessionId", "partNumber");

ALTER TABLE "MultipartPart"
    ADD CONSTRAINT "MultipartPart_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MultipartPart"
    ADD CONSTRAINT "MultipartPart_uploadSessionId_organizationId_fkey"
    FOREIGN KEY ("uploadSessionId", "organizationId") REFERENCES "UploadSession"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MultipartPart"
    ADD CONSTRAINT "MultipartPart_values_check"
    CHECK ("partNumber" BETWEEN 1 AND 10000 AND ("sizeBytes" IS NULL OR "sizeBytes" >= 0));
